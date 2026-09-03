import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, Any, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from src.config import (
    load_config, get_servers, get_server_by_id, add_server,
    update_server, delete_server, get_routing_settings, get_general_settings
)
from src.collector import update_all_metrics, get_cached_metrics, get_cluster_summary
from src.openai_proxy import router as openai_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("courtesy.app")

STATIC_DIR = Path(__file__).parent.parent / "static"

# Connected WebSocket clients for real-time live metric streaming
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: Dict[str, Any]):
        dead = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                dead.append(connection)
        for d in dead:
            self.disconnect(d)

manager = ConnectionManager()
background_task: asyncio.Task = None


async def metrics_poller_task():
    """Continuously polls servers and broadcasts telemetry via WebSocket."""
    while True:
        try:
            settings = get_general_settings()
            poll_interval = settings.get("poll_interval_seconds", 4)
            metrics = await update_all_metrics()
            summary = get_cluster_summary()
            await manager.broadcast({
                "type": "metrics_update",
                "timestamp": asyncio.get_event_loop().time(),
                "metrics": metrics,
                "summary": summary
            })
        except Exception as e:
            logger.error(f"Error in metrics poller: {e}")
        await asyncio.sleep(poll_interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Courtesy Cluster Manager & Codex Gateway...")
    # Initial metrics fetch
    await update_all_metrics()
    global background_task
    background_task = asyncio.create_task(metrics_poller_task())
    yield
    if background_task:
        background_task.cancel()
    logger.info("Courtesy service shut down.")


app = FastAPI(
    title="Courtesy Codex & Cluster Engine",
    description="Autonomous AI Cluster Manager and Codex/Claude Gateway",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include OpenAI-compatible Codex endpoint
app.include_router(openai_router)


# --- REST API Endpoints ---

@app.get("/api/cluster")
async def api_cluster_summary():
    """Cluster-wide capacity, VRAM, and online node counts."""
    return get_cluster_summary()


@app.get("/api/servers")
async def api_get_servers():
    """Returns all configured servers augmented with current live telemetry."""
    servers = get_servers()
    metrics = get_cached_metrics()
    result = []
    for s in servers:
        s_copy = dict(s)
        s_metric = metrics.get(s["id"], {})
        s_copy["status"] = {
            "online": s_metric.get("online", False),
            "latency_ms": s_metric.get("latency_ms"),
            "ram_total_gb": s_metric.get("ram_total_gb", 0),
            "ram_used_gb": s_metric.get("ram_used_gb", 0),
            "ram_percent": s_metric.get("ram_percent", 0),
            "cpu_percent": s_metric.get("cpu_percent", 0),
            "gpus": s_metric.get("gpus", s.get("specs", {}).get("gpus", [])),
            "models": s_metric.get("models", []),
            "running_models": s_metric.get("running_models", [])
        }
        result.append(s_copy)
    return result


@app.post("/api/servers")
async def api_add_server(server_data: Dict[str, Any] = Body(...)):
    """Modular endpoint: Dynamically add a new server to the cluster."""
    if not server_data.get("id") or not server_data.get("name"):
        raise HTTPException(status_code=400, detail="Server 'id' and 'name' are required.")
    
    # Defaults
    server_data.setdefault("role", "inference")
    server_data.setdefault("type", "ollama")
    server_data.setdefault("port", 11434)
    server_data.setdefault("enabled", True)
    server_data.setdefault("specs", {"cpu": "Unknown", "ram": "Unknown", "gpus": []})
    server_data.setdefault("tags", ["custom-node"])

    saved = add_server(server_data)
    # Trigger immediate update
    asyncio.create_task(update_all_metrics())
    return {"status": "success", "server": saved}


@app.put("/api/servers/{server_id}")
async def api_update_server(server_id: str, updates: Dict[str, Any] = Body(...)):
    """Update fields of an existing server."""
    updated = update_server(server_id, updates)
    if not updated:
        raise HTTPException(status_code=404, detail=f"Server '{server_id}' not found.")
    asyncio.create_task(update_all_metrics())
    return {"status": "success", "server": updated}


@app.post("/api/servers/{server_id}/toggle")
async def api_toggle_server(server_id: str):
    """Enable or disable a server from participating in inference or routing."""
    srv = get_server_by_id(server_id)
    if not srv:
        raise HTTPException(status_code=404, detail=f"Server '{server_id}' not found.")
    new_state = not srv.get("enabled", True)
    updated = update_server(server_id, {"enabled": new_state})
    asyncio.create_task(update_all_metrics())
    return {"status": "success", "server_id": server_id, "enabled": new_state}


@app.delete("/api/servers/{server_id}")
async def api_delete_server(server_id: str):
    """Remove a server from the modular registry."""
    success = delete_server(server_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Server '{server_id}' not found.")
    asyncio.create_task(update_all_metrics())
    return {"status": "success", "deleted": server_id}


@app.get("/api/metrics")
async def api_get_metrics():
    """Live metrics dictionary for all nodes."""
    return get_cached_metrics()


@app.get("/api/models")
async def api_get_models():
    """Aggregated list of all available models across online nodes."""
    summary = get_cluster_summary()
    metrics = get_cached_metrics()
    detailed_models = []
    
    for s_id, m in metrics.items():
        if m.get("online"):
            for mdl in m.get("models", []):
                detailed_models.append({
                    "server_id": s_id,
                    "server_name": m.get("name", s_id),
                    **mdl
                })
                
    return {
        "unique_models": summary.get("models", []),
        "detailed": detailed_models
    }


# --- WebSocket for Real-time Dashboard Telemetry ---

@app.websocket("/ws/metrics")
async def websocket_metrics_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Send initial snapshot immediately upon connect
        await websocket.send_json({
            "type": "initial_state",
            "metrics": get_cached_metrics(),
            "summary": get_cluster_summary()
        })
        while True:
            # Keep alive; client can send pings
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)


# --- Static Files & SPA Route ---

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/")
async def serve_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return JSONResponse({"message": "Courtesy AI Backend Running. Static files not yet compiled."})
