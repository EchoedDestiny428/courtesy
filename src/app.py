import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, Any, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Body, Query, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from src.config import (
    load_config, get_servers, get_server_by_id, add_server,
    update_server, delete_server, get_routing_settings, get_general_settings
)
from src.collector import update_all_metrics, get_cached_metrics, get_cluster_summary
from src.openai_proxy import router as openai_router
from src.router import offload_server_models
from src.web_agent import search_web, fetch_webpage, generate_grounded_context
from src.swarm import start_swarm_task, stop_swarm_task, get_swarm_status, register_swarm_subscriber, unregister_swarm_subscriber
from src.miner_manager import load_mining_config, save_mining_config, get_cluster_mining_status, start_mining_cluster, preempt_mining, idle_mining_watcher_loop
from src.auth import verify_admin_credentials, create_admin_session, is_valid_admin_token, revoke_admin_session, require_admin_auth
from src.router import _active_requests

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
mining_task: asyncio.Task = None


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
    global background_task, mining_task
    background_task = asyncio.create_task(metrics_poller_task())
    mining_task = asyncio.create_task(idle_mining_watcher_loop(lambda: sum(_active_requests.values())))
    yield
    if background_task:
        background_task.cancel()
    if mining_task:
        mining_task.cancel()
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


@app.post("/api/cluster/offload")
async def api_cluster_offload():
    """Unloads all resident models across all GPU servers to free 100% of cluster VRAM."""
    servers = [s for s in get_servers() if s.get("enabled") and s.get("type") == "ollama"]
    tasks = [offload_server_models(s) for s in servers]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    asyncio.create_task(update_all_metrics())
    return {"status": "success", "unloaded": results}


@app.post("/api/servers/{server_id}/offload")
async def api_server_offload(server_id: str):
    """Unloads resident models on a specific node to free its VRAM."""
    srv = get_server_by_id(server_id)
    if not srv:
        raise HTTPException(status_code=404, detail=f"Server '{server_id}' not found.")
    unloaded = await offload_server_models(srv)
    asyncio.create_task(update_all_metrics())
    return {"status": "success", "server_id": server_id, "unloaded": unloaded}


# --- Web Access & Live Documentation Tool Endpoints ---

@app.get("/api/tools/search")
async def api_web_search(q: str = Query(..., description="Web search query for documentation or APIs")):
    """Executes live web search and returns relevant documentation links and snippets."""
    results = await search_web(q, max_results=5)
    return {"query": q, "results": results}


@app.get("/api/tools/fetch")
async def api_web_fetch(url: str = Query(..., description="URL to fetch documentation from")):
    """Scrapes clean text and code blocks from any documentation webpage."""
    text = await fetch_webpage(url)
    return {"url": url, "content": text}


@app.post("/api/tools/ground")
async def api_web_ground(payload: Dict[str, Any]):
    """Accepts a prompt or query, searches relevant docs, and returns grounded context."""
    prompt = payload.get("prompt", "")
    force = payload.get("force", True)
    context, sources = await generate_grounded_context(prompt, force=force)
    return {"context": context, "sources": sources}


# --- Autonomous Multi-Agent Swarm Endpoints ---

@app.post("/api/swarm/start")
async def api_swarm_start(payload: Dict[str, Any]):
    """Launches an autonomous multi-node swarm task."""
    objective = payload.get("objective", "").strip()
    if not objective:
        raise HTTPException(status_code=400, detail="Objective is required.")
    max_iterations = int(payload.get("max_iterations", 3))
    task_id = start_swarm_task(objective, max_iterations=max_iterations)
    return {"status": "started", "task_id": task_id}


@app.get("/api/swarm/status/{task_id}")
async def api_swarm_status(task_id: str):
    """Fetches status and final artifacts of a swarm task."""
    st = get_swarm_status(task_id)
    if not st:
        raise HTTPException(status_code=404, detail=f"Task '{task_id}' not found.")
    return st


@app.post("/api/swarm/stop/{task_id}")
async def api_swarm_stop(task_id: str):
    """Stops an active swarm workflow."""
    success = stop_swarm_task(task_id)
    return {"status": "stopped" if success else "not_found", "task_id": task_id}


@app.websocket("/ws/swarm")
async def websocket_swarm_endpoint(websocket: WebSocket):
    """Streams live multi-agent swarm dialogue and step events to the GUI."""
    await websocket.accept()
    queue = register_swarm_subscriber()
    try:
        while True:
            event = await queue.get()
            await websocket.send_json(event)
    except WebSocketDisconnect:
        unregister_swarm_subscriber(queue)
    except Exception:
        unregister_swarm_subscriber(queue)


# --- Autonomous Idle GPU Crypto Mining Endpoints ---

@app.get("/api/mining/status")
async def api_mining_status():
    """Returns current status of cluster idle mining."""
    return await get_cluster_mining_status()


@app.post("/api/mining/config")
async def api_mining_config(payload: Dict[str, Any]):
    """Updates mining configuration (wallet, coin, pool, idle threshold, power limit)."""
    cfg = load_mining_config()
    for k, v in payload.items():
        if k in cfg:
            cfg[k] = v
    save_mining_config(cfg)
    return {"status": "success", "config": cfg}


@app.post("/api/mining/start")
async def api_mining_start():
    """Manually triggers mining across the cluster."""
    cfg = load_mining_config()
    cfg["enabled"] = True
    save_mining_config(cfg)
    await start_mining_cluster()
    return {"status": "started"}


@app.post("/api/mining/stop")
async def api_mining_stop():
    """Manually stops/preempts mining across the cluster."""
    cfg = load_mining_config()
    cfg["enabled"] = False
    save_mining_config(cfg)
    await preempt_mining()
    return {"status": "stopped"}


# --- Authentication & Administrative Control Endpoints ---

@app.post("/api/auth/login")
async def api_auth_login(payload: Dict[str, Any]):
    """Securely authenticates admin user against server-side salted hash."""
    username = payload.get("username", "").strip()
    password = payload.get("password", "")
    if verify_admin_credentials(username, password):
        token = create_admin_session()
        return {"status": "success", "token": token, "username": username}
    raise HTTPException(status_code=401, detail="Invalid username or password.")


@app.post("/api/auth/verify")
async def api_auth_verify(payload: Dict[str, Any]):
    """Checks if a session token is currently valid."""
    token = payload.get("token", "")
    return {"valid": is_valid_admin_token(token)}


@app.post("/api/auth/logout")
async def api_auth_logout(payload: Dict[str, Any]):
    """Revokes active admin session."""
    token = payload.get("token", "")
    revoke_admin_session(token)
    return {"status": "logged_out"}


@app.post("/api/admin/terminate_sessions")
async def api_admin_terminate_sessions(admin_token: str = Depends(require_admin_auth)):
    """Terminates all active Ollama model sessions & flushes dual-GPU VRAM across all nodes."""
    servers = get_servers()
    results = {}
    for s in servers:
        if s.get("enabled", True):
            res = await offload_server_models(s)
            results[s["id"]] = res
    await preempt_mining()
    return {"status": "sessions_terminated", "servers": results}


@app.post("/api/admin/restart")
async def api_admin_restart(admin_token: str = Depends(require_admin_auth)):
    """Triggers an administrative service reload."""
    async def _do_restart():
        await asyncio.sleep(1.0)
        os.system("pkill -f uvicorn || true")
    asyncio.create_task(_do_restart())
    return {"status": "restarting", "message": "Cluster gateway is restarting..."}


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
