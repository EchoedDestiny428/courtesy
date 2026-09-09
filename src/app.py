import asyncio
import json
import logging
import os
import shutil
import select
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, Any, List, Optional

try:
    import paramiko
except ImportError:
    paramiko = None

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Body, Query, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
import httpx

from src.config import (
    load_config, get_servers, get_server_by_id, add_server,
    update_server, delete_server, get_routing_settings, get_general_settings
)
from src.collector import update_all_metrics, get_cached_metrics, get_cluster_summary, scan_all_servers, IS_ON_CST
from src.router import (
    resolve_route, track_request_start, track_request_end,
    ensure_vram_headroom, offload_server_models, _active_requests
)
from src.auth import (
    verify_admin_credentials, create_admin_session, is_valid_admin_token,
    revoke_admin_session, require_admin_auth, get_client_ip,
    check_admin_brute_force, record_admin_login_failure, reset_admin_login_failures,
    rate_limiter
)
from src.security import get_safe_workspace_path, SecurityHeadersMiddleware
from src.ownership import (
    get_server_ownership, get_all_ownership, claim_server,
    release_server, verify_or_register_user, touch_activity
)


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
    logger.info("Starting Courtesy Cluster Manager & IDE Gateway...")
    # Initial metrics fetch
    await update_all_metrics()
    global background_task
    background_task = asyncio.create_task(metrics_poller_task())
    yield
    if background_task:
        background_task.cancel()
    logger.info("Courtesy service shut down.")


app = FastAPI(
    title="Courtesy Cluster Engine",
    description="Autonomous AI Cluster Manager and Antigravity IDE Gateway",
    version="1.0.0",
    lifespan=lifespan
)

# CORS configuration - configurable via COURTESY_ALLOWED_ORIGINS
_raw_origins = os.environ.get("COURTESY_ALLOWED_ORIGINS", "*").strip()
allowed_origins = ["*"] if _raw_origins == "*" else [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(SecurityHeadersMiddleware)

# API Rate Limiter Middleware
RATE_LIMIT_RPM = int(os.environ.get("COURTESY_RATE_LIMIT_RPM", "180"))

@app.middleware("http")
async def api_rate_limiter_middleware(request: Request, call_next):
    path = request.url.path
    # Exempt static files, root page, and favicon from rate limiting
    if path.startswith("/static") or path == "/" or path == "/favicon.ico":
        return await call_next(request)

    client_ip = get_client_ip(request)
    is_limited, retry_after = rate_limiter.check_rate_limit(
        f"api_ip:{client_ip}",
        max_requests=RATE_LIMIT_RPM,
        window_seconds=60
    )
    if is_limited:
        return JSONResponse(
            status_code=429,
            content={"detail": "Too many requests. Please slow down."},
            headers={"Retry-After": str(retry_after)}
        )
    return await call_next(request)


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
            "dns": s_metric.get("dns", f"{s['id']}.local"),
            "resolved_ip": s_metric.get("resolved_ip", s.get("ip", s.get("host"))),
            "probe_type": s_metric.get("probe_type"),
            "verified_name": s_metric.get("verified_name", s["id"]),
            "ram_total_gb": s_metric.get("ram_total_gb", 0),
            "ram_used_gb": s_metric.get("ram_used_gb", 0),
            "ram_percent": s_metric.get("ram_percent", 0),
            "cpu_percent": s_metric.get("cpu_percent", 0),
            "gpus": s_metric.get("gpus", s.get("specs", {}).get("gpus", [])),
            "models": s_metric.get("models", []),
            "running_models": s_metric.get("running_models", [])
        }
        if s_metric.get("resolved_ip"):
            s_copy["host"] = s_metric.get("resolved_ip")
        s_copy["ownership"] = get_server_ownership(s["id"])
        result.append(s_copy)
    return result


@app.get("/api/servers/scan")
async def api_scan_servers():
    """Actively scans .local DNS and sends packet probes to all cluster nodes, returning fresh statuses."""
    servers = await scan_all_servers()
    for s in servers:
        s["ownership"] = get_server_ownership(s["id"])
    return servers



@app.post("/api/servers")
async def api_add_server(server_data: Dict[str, Any] = Body(...), admin_token: str = Depends(require_admin_auth)):
    """Modular endpoint: Dynamically add a new server to the cluster (Admin only)."""
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
async def api_update_server(server_id: str, updates: Dict[str, Any] = Body(...), admin_token: str = Depends(require_admin_auth)):
    """Update fields of an existing server (Admin only)."""
    updated = update_server(server_id, updates)
    if not updated:
        raise HTTPException(status_code=404, detail=f"Server '{server_id}' not found.")
    asyncio.create_task(update_all_metrics())
    return {"status": "success", "server": updated}


@app.post("/api/servers/{server_id}/toggle")
async def api_toggle_server(server_id: str, admin_token: str = Depends(require_admin_auth)):
    """Enable or disable a server from participating in inference or routing (Admin only)."""
    srv = get_server_by_id(server_id)
    if not srv:
        raise HTTPException(status_code=404, detail=f"Server '{server_id}' not found.")
    new_state = not srv.get("enabled", True)
    updated = update_server(server_id, {"enabled": new_state})
    asyncio.create_task(update_all_metrics())
    return {"status": "success", "server_id": server_id, "enabled": new_state}


@app.delete("/api/servers/{server_id}")
async def api_delete_server(server_id: str, admin_token: str = Depends(require_admin_auth)):
    """Remove a server from the modular registry (Admin only)."""
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
async def api_cluster_offload(admin_token: str = Depends(require_admin_auth)):
    """Unloads all resident models across all GPU servers to free 100% of cluster VRAM (Admin only)."""
    servers = [s for s in get_servers() if s.get("enabled") and s.get("type") == "ollama"]
    tasks = [offload_server_models(s) for s in servers]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    asyncio.create_task(update_all_metrics())
    return {"status": "success", "unloaded": results}


@app.post("/api/servers/{server_id}/offload")
async def api_server_offload(server_id: str, request: Request, payload: Optional[Dict[str, Any]] = Body(None)):
    """Unloads resident models on a specific node to free its VRAM."""
    srv = get_server_by_id(server_id)
    if not srv:
        raise HTTPException(status_code=404, detail=f"Server '{server_id}' not found.")

    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "").strip() if auth_header else (payload.get("admin_token", "") if payload else "")
    is_admin = is_valid_admin_token(token)

    if not is_admin:
        owner_info = get_server_ownership(server_id)
        client_user = request.headers.get("X-Courtesy-User") or (payload.get("username") if payload else "")
        if owner_info.get("is_claimed") and (not client_user or owner_info.get("owner", "").lower() != client_user.lower()):
            raise HTTPException(status_code=403, detail="Only the reserving user or admin can offload this node.")

    unloaded = await offload_server_models(srv)
    asyncio.create_task(update_all_metrics())
    return {"status": "success", "server_id": server_id, "unloaded": unloaded}


# --- Cluster Node Ownership & Reservation Endpoints ---

@app.get("/api/ownership")
async def api_get_ownership():
    """Returns cluster-wide node reservation status."""
    return get_all_ownership()


@app.post("/api/ownership/verify")
async def api_ownership_verify(request: Request, payload: Dict[str, Any]):
    """Verifies user's 4-digit PIN or registers new user with brute-force defense."""
    username = payload.get("username", "").strip()
    pin = str(payload.get("pin", "")).strip()
    if not username or not pin:
        raise HTTPException(status_code=400, detail="Username and 4-digit PIN are required.")
    client_ip = get_client_ip(request)
    try:
        return verify_or_register_user(username, pin, client_ip=client_ip)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/ownership/claim")
async def api_ownership_claim(request: Request, payload: Dict[str, Any]):
    """Claims a cluster node for a verified user with brute-force defense."""
    server_id = payload.get("server_id", "").strip()
    username = payload.get("username", "").strip()
    pin = str(payload.get("pin", "")).strip()
    if not server_id or not username or not pin:
        raise HTTPException(status_code=400, detail="server_id, username, and 4-digit PIN are required.")
    client_ip = get_client_ip(request)
    try:
        res = claim_server(server_id, username, pin, client_ip=client_ip)
        if not res.get("success"):
            raise HTTPException(status_code=409, detail=res.get("error", "Node reservation conflict."))
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/ownership/release")
async def api_ownership_release(request: Request, payload: Dict[str, Any]):
    """Releases ownership of a cluster node."""
    server_id = payload.get("server_id", "").strip()
    username = payload.get("username", "").strip()
    pin = str(payload.get("pin", "")).strip() if payload.get("pin") is not None else None
    force = payload.get("force", False)

    if force:
        auth_header = request.headers.get("Authorization", "")
        token = auth_header.replace("Bearer ", "").strip() if auth_header else payload.get("admin_token", "")
        if not is_valid_admin_token(token):
            raise HTTPException(status_code=403, detail="Admin authorization required to force-release node.")

    client_ip = get_client_ip(request)
    try:
        res = release_server(server_id, username, pin, force=force, client_ip=client_ip)
        if not res.get("success"):
            raise HTTPException(status_code=400, detail=res.get("error", "Failed to release node."))
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


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


# --- Native Courtesy IDE Chat Stream Endpoint ---

@app.post("/api/chat")
async def api_chat(request: Request):
    """
    Lightweight, streaming inference endpoint tailored specifically for Courtesy IDE.
    Directly routes to optimal cluster node using intelligent load balancing.
    """
    body = await request.json()
    model_req = body.get("model", "auto")
    stream = body.get("stream", True)
    web_access = body.get("web_access", False)

    # Perform live web & documentation grounding if requested
    sources = []
    if web_access:
        messages = body.get("messages", [])
        last_user_idx = None
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                last_user_idx = i
                break
        
        if last_user_idx is not None:
            user_content = messages[last_user_idx].get("content", "")
            if isinstance(user_content, str) and user_content.strip():
                try:
                    grounded_ctx, sources = await generate_grounded_context(user_content, force=True)
                    if grounded_ctx:
                        messages[last_user_idx]["content"] = user_content + grounded_ctx
                        body["messages"] = messages
                except Exception as e:
                    logger.warning(f"Web grounding failed: {e}")

    pref_server = body.get("server") or body.get("server_id")
    try:
        target = resolve_route(model_query=model_req, preferred_server=pref_server)
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

    if body.get("username"):
        touch_activity(target.server_id, body.get("username"))

    logger.info(f"Routing chat for '{model_req}' -> {target.server_id} ({target.server_name}) model '{target.model_name}'")

    resp_headers = {
        "X-Courtesy-Server": target.server_id,
        "X-Courtesy-Model": target.model_name,
        "X-Courtesy-Web-Sources": json.dumps(sources),
        "Access-Control-Expose-Headers": "X-Courtesy-Server, X-Courtesy-Model, X-Courtesy-Web-Sources"
    }

    if stream:
        async def stream_generator():
            await track_request_start(target.server_id)
            endpoint = f"{target.base_url}/v1/chat/completions"
            req_payload = body.copy()
            req_payload["model"] = target.model_name
            req_payload["stream"] = True

            try:
                can_direct = True
                try:
                    async with httpx.AsyncClient(timeout=120.0) as client:
                        await ensure_vram_headroom(target, client)
                        async with client.stream("POST", endpoint, json=req_payload) as resp:
                            if resp.status_code == 200:
                                async for chunk in resp.aiter_text():
                                    yield chunk
                                can_direct = False
                except Exception:
                    can_direct = True

                if can_direct:
                    json_input = json.dumps(req_payload)
                    from src.collector import IS_ON_CST
                    if IS_ON_CST:
                        cmd = ["curl", "-s", "-N", "-H", "Content-Type: application/json", endpoint, "-d", "@-"]
                        proc = await asyncio.create_subprocess_exec(
                            *cmd,
                            stdin=asyncio.subprocess.PIPE,
                            stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.PIPE
                        )
                    else:
                        curl_cmd = f"curl -s -N -H 'Content-Type: application/json' {endpoint} -d @-"
                        proc = await asyncio.create_subprocess_exec(
                            "ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", "cst@cst",
                            curl_cmd,
                            stdin=asyncio.subprocess.PIPE,
                            stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.PIPE
                        )

                    if proc.stdin:
                        proc.stdin.write(json_input.encode("utf-8"))
                        await proc.stdin.drain()
                        proc.stdin.close()

                    while True:
                        line = await proc.stdout.readline()
                        if not line:
                            break
                        yield line.decode("utf-8", errors="ignore")

                    await proc.wait()

            except Exception as e:
                logger.error(f"Chat streaming error on {target.server_id}: {e}")
                err_chunk = {"choices": [{"delta": {"content": f"\n\n[Cluster Error on {target.server_name}: {str(e)}]"}}]}
                yield f"data: {json.dumps(err_chunk)}\n\ndata: [DONE]\n\n"
            finally:
                await track_request_end(target.server_id)

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                **resp_headers
            }
        )

    # Non-streaming request
    await track_request_start(target.server_id)
    endpoint = f"{target.base_url}/v1/chat/completions"
    req_payload = body.copy()
    req_payload["model"] = target.model_name
    req_payload["stream"] = False

    try:
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                await ensure_vram_headroom(target, client)
                resp = await client.post(endpoint, json=req_payload)
                if resp.status_code == 200:
                    return JSONResponse(content=resp.json(), headers=resp_headers)
        except Exception:
            pass

        from src.collector import IS_ON_CST
        json_input = json.dumps(req_payload)
        if IS_ON_CST:
            cmd = ["curl", "-s", "-H", "Content-Type: application/json", endpoint, "-d", "@-"]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
        else:
            curl_cmd = f"curl -s -H 'Content-Type: application/json' {endpoint} -d @-"
            proc = await asyncio.create_subprocess_exec(
                "ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", "cst@cst",
                curl_cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
        stdout, _ = await proc.communicate(input=json_input.encode("utf-8"))
        res_data = json.loads(stdout.decode("utf-8"))
        return JSONResponse(content=res_data, headers=resp_headers)

    except Exception as e:
        logger.error(f"Inference error on {target.server_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Inference failed on {target.server_name}: {str(e)}")
    finally:
        await track_request_end(target.server_id)


# --- Local & Remote Workspace Filespace Endpoints ---

COURTESY_ALLOW_WORKSPACE_EXEC = os.environ.get("COURTESY_ALLOW_WORKSPACE_EXEC", "true").lower() in ("1", "true", "yes")


@app.api_route("/api/workspace/files", methods=["GET", "POST"])
async def api_workspace_files(
    payload: Optional[Dict[str, Any]] = Body(None),
    path: Optional[str] = Query(None),
    folder: Optional[str] = Query(None)
):
    """Returns directory structure of a workspace folder within sandbox boundaries."""
    dir_path = ""
    if payload:
        dir_path = payload.get("path") or payload.get("folder") or ""
    if not dir_path:
        dir_path = path or folder or ""
    if not dir_path:
        dir_path = os.getcwd()

    safe_dir = get_safe_workspace_path(dir_path)
    if not safe_dir.is_dir():
        return {"files": []}

    dir_path = str(safe_dir)
    ignored = {'.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build', '.vscode', '.idea'}
    file_list = []

    for root, dirs, files in os.walk(dir_path):
        dirs[:] = [d for d in dirs if d not in ignored]
        depth = os.path.relpath(root, dir_path).count(os.sep)
        if depth > 5:
            continue
        
        # Also add folder nodes
        if root != dir_path:
            rel_folder = os.path.relpath(root, dir_path).replace('\\', '/')
            file_list.append({
                "name": os.path.basename(root),
                "path": root.replace('\\', '/'),
                "relative": rel_folder,
                "is_dir": True,
                "size": 0
            })

        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, dir_path).replace('\\', '/')
            file_list.append({
                "name": f,
                "path": full.replace('\\', '/'),
                "relative": rel,
                "is_dir": False,
                "size": os.path.getsize(full) if os.path.exists(full) else 0
            })
            if len(file_list) > 500:
                break
        if len(file_list) > 500:
            break

    return {"files": file_list}


@app.api_route("/api/workspace/read", methods=["GET", "POST"])
async def api_workspace_read(
    payload: Optional[Dict[str, Any]] = Body(None),
    path: Optional[str] = Query(None),
    folder: Optional[str] = Query(None)
):
    """Reads content of a workspace file within sandbox boundaries."""
    file_path = ""
    base_folder = ""
    if payload:
        file_path = payload.get("path", "")
        base_folder = payload.get("folder", "")
    if not file_path:
        file_path = path or ""
    if not base_folder:
        base_folder = folder or ""

    safe_file = get_safe_workspace_path(file_path, base_folder)

    if not safe_file.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    try:
        with open(safe_file, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
            return {"success": True, "content": content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/workspace/write")
async def api_workspace_write(payload: Dict[str, Any]):
    """Writes or overwrites content to a workspace file within sandbox boundaries."""
    file_path = payload.get("path", "").strip()
    base_folder = payload.get("folder", "").strip()
    content = payload.get("content", "")

    if not file_path:
        raise HTTPException(status_code=400, detail="Path is required")

    safe_file = get_safe_workspace_path(file_path, base_folder)

    try:
        safe_file.parent.mkdir(parents=True, exist_ok=True)
        with open(safe_file, "w", encoding="utf-8") as f:
            f.write(content)
        return {"success": True, "status": "success", "path": str(safe_file).replace('\\', '/')}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/workspace/apply_diff")
async def api_workspace_apply_diff(payload: Dict[str, Any]):
    """Applies a specific target content replacement to a workspace file."""
    file_path = payload.get("path", "")
    target = payload.get("target", "")
    replacement = payload.get("replacement", "")

    safe_file = get_safe_workspace_path(file_path)
    if not safe_file.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    try:
        with open(safe_file, "r", encoding="utf-8") as f:
            content = f.read()
        if target not in content:
            raise HTTPException(status_code=400, detail="Target snippet not found in file")
        content = content.replace(target, replacement, 1)
        with open(safe_file, "w", encoding="utf-8") as f:
            f.write(content)
        return {"status": "success", "path": str(safe_file).replace('\\', '/')}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/workspace/exec")
async def api_workspace_exec(request: Request, payload: Dict[str, Any]):
    """Executes a terminal command within workspace directory with authorization."""
    if not COURTESY_ALLOW_WORKSPACE_EXEC:
        raise HTTPException(status_code=403, detail="Workspace command execution disabled by administrator.")

    # Check caller credentials (admin token or valid user PIN)
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "").strip() if auth_header else payload.get("admin_token", "")
    is_admin = is_valid_admin_token(token)

    username = request.headers.get("X-Courtesy-User") or payload.get("username", "")
    pin = request.headers.get("X-Courtesy-Pin") or payload.get("pin", "")

    client_ip = get_client_ip(request)
    is_user = False
    if username and pin:
        try:
            verify_or_register_user(username, pin, client_ip=client_ip)
            is_user = True
        except Exception:
            pass

    if not is_admin and not is_user:
        raise HTTPException(status_code=401, detail="Authentication required: Valid admin token or user PIN required to execute commands.")

    cmd = payload.get("command", "")
    cwd = payload.get("cwd", "")
    if not cmd:
        raise HTTPException(status_code=400, detail="Command is required")

    safe_cwd = None
    if cwd:
        try:
            safe_cwd = str(get_safe_workspace_path(cwd))
        except Exception:
            safe_cwd = None

    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            cwd=safe_cwd if safe_cwd and os.path.isdir(safe_cwd) else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30.0)
        return {
            "exit_code": proc.returncode,
            "stdout": stdout.decode("utf-8", errors="replace"),
            "stderr": stderr.decode("utf-8", errors="replace")
        }
    except asyncio.TimeoutError:
        return {"exit_code": -1, "stdout": "", "stderr": "Command timed out after 30s"}
    except Exception as e:
        return {"exit_code": -1, "stdout": "", "stderr": str(e)}


@app.post("/api/terminal/exec")
async def api_terminal_exec(request: Request, payload: Dict[str, Any]):
    """Executes a terminal command directly on a specified cluster node (or gateway) over SSH with authorization checks."""
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "").strip() if auth_header else payload.get("admin_token", "")
    is_admin = is_valid_admin_token(token)

    server_id = (payload.get("server_id") or "cst").strip()
    username = request.headers.get("X-Courtesy-User") or payload.get("username", "")
    pin = request.headers.get("X-Courtesy-Pin") or payload.get("pin", "")

    client_ip = get_client_ip(request)
    is_authorized_user = False
    if username and pin:
        try:
            verify_or_register_user(username, pin, client_ip=client_ip)
            owner_info = get_server_ownership(server_id)
            if not owner_info.get("is_claimed") or owner_info.get("owner", "").lower() == username.strip().lower():
                is_authorized_user = True
        except Exception:
            pass

    if not is_admin and not is_authorized_user:
        raise HTTPException(status_code=401, detail="Authentication required: Valid admin token or node owner credentials required.")

    cmd = payload.get("command", "").strip()
    cwd = payload.get("cwd", "").strip()

    if not cmd:
        raise HTTPException(status_code=400, detail="Command is required")

    server = get_server_by_id(server_id)
    if not server and server_id == "cst":
        server = {"id": "cst", "ssh_host": "cst", "ssh_user": "cst"}

    if not server:
        raise HTTPException(status_code=404, detail=f"Server '{server_id}' not found")

    username = payload.get("username", "")
    touch_activity(server_id, username)

    ssh_host = server.get("ssh_host", f"{server_id}.local")
    ssh_user = server.get("ssh_user", server_id)
    ssh_target = f"{ssh_user}@{ssh_host}" if ssh_user else ssh_host

    effective_cmd = f"cd {cwd} && {cmd}" if cwd else cmd

    try:
        if IS_ON_CST:
            if server_id == "cst":
                proc = await asyncio.create_subprocess_shell(
                    effective_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=35.0)
                return {
                    "exit_code": proc.returncode,
                    "stdout": stdout.decode("utf-8", errors="replace"),
                    "stderr": stderr.decode("utf-8", errors="replace")
                }
            else:
                proc = await asyncio.create_subprocess_exec(
                    "ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", ssh_target,
                    effective_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=35.0)
                return {
                    "exit_code": proc.returncode,
                    "stdout": stdout.decode("utf-8", errors="replace"),
                    "stderr": stderr.decode("utf-8", errors="replace")
                }
        else:
            if not shutil.which("ssh"):
                return {"exit_code": -1, "stdout": "", "stderr": "SSH binary not found locally"}
            if server_id == "cst":
                proc = await asyncio.create_subprocess_exec(
                    "ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", "cst@cst",
                    effective_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
            else:
                remote_ssh = f"ssh -o ConnectTimeout=6 -o BatchMode=yes {ssh_target} {effective_cmd}"
                proc = await asyncio.create_subprocess_exec(
                    "ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", "cst@cst",
                    remote_ssh,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=35.0)
            return {
                "exit_code": proc.returncode,
                "stdout": stdout.decode("utf-8", errors="replace"),
                "stderr": stderr.decode("utf-8", errors="replace")
            }
    except asyncio.TimeoutError:
        return {"exit_code": -1, "stdout": "", "stderr": "Command timed out after 35s"}
    except Exception as e:
        return {"exit_code": -1, "stdout": "", "stderr": str(e)}


@app.post("/api/workspace/create")
async def api_workspace_create(payload: Dict[str, Any]):
    """Creates a new file or directory within workspace sandbox."""
    target_path = payload.get("path", "").strip()
    base_folder = payload.get("folder", "").strip()
    is_dir = payload.get("is_dir", False)
    content = payload.get("content", "")

    if not target_path:
        raise HTTPException(status_code=400, detail="Path is required")

    safe_target = get_safe_workspace_path(target_path, base_folder)

    try:
        if is_dir:
            safe_target.mkdir(parents=True, exist_ok=True)
        else:
            safe_target.parent.mkdir(parents=True, exist_ok=True)
            with open(safe_target, "w", encoding="utf-8") as f:
                f.write(content)
        name = safe_target.name
        return {"success": True, "status": "success", "full_path": str(safe_target).replace('\\', '/'), "name": name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/workspace/delete")
async def api_workspace_delete(payload: Dict[str, Any]):
    """Deletes a file or directory within workspace sandbox."""
    target_path = payload.get("path", "").strip()
    base_folder = payload.get("folder", "").strip()

    safe_target = get_safe_workspace_path(target_path, base_folder)

    if not safe_target.exists():
        raise HTTPException(status_code=404, detail="File or directory not found")
    try:
        import shutil
        if safe_target.is_dir():
            shutil.rmtree(safe_target)
        else:
            safe_target.unlink()
        return {"success": True, "status": "success", "path": str(safe_target).replace('\\', '/')}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/workspace/rename")
async def api_workspace_rename(payload: Dict[str, Any]):
    """Renames or moves a file or directory within workspace sandbox."""
    old_path = payload.get("old_path", "").strip()
    new_path = payload.get("new_path", "").strip()
    base_folder = payload.get("folder", "").strip()

    if not old_path:
        raise HTTPException(status_code=400, detail="Source path is required")
    if not new_path:
        raise HTTPException(status_code=400, detail="New path is required")

    safe_old = get_safe_workspace_path(old_path, base_folder)
    safe_new = get_safe_workspace_path(new_path, base_folder)

    if not safe_old.exists():
        raise HTTPException(status_code=404, detail="Source path not found")
    try:
        safe_new.parent.mkdir(parents=True, exist_ok=True)
        import shutil
        shutil.move(str(safe_old), str(safe_new))
        return {"success": True, "status": "success", "old_path": str(safe_old).replace('\\', '/'), "new_path": str(safe_new).replace('\\', '/')}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/workspace/search")
async def api_workspace_search(payload: Dict[str, Any]):
    """Searches across files in workspace within sandbox for a specific text pattern."""
    dir_path = payload.get("path") or payload.get("folder") or ""
    query = payload.get("query", "").strip()
    case_sensitive = payload.get("case_sensitive", False)
    max_results = int(payload.get("max_results", 50))

    if not query:
        return {"success": True, "results": [], "matches": []}

    safe_dir = get_safe_workspace_path(dir_path or os.getcwd())
    if not safe_dir.is_dir():
        return {"success": True, "results": [], "matches": []}

    dir_path = str(safe_dir)
    ignored = {'.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build', '.vscode', '.idea'}
    matches = []
    q = query if case_sensitive else query.lower()

    for root, dirs, files in os.walk(dir_path):
        dirs[:] = [d for d in dirs if d not in ignored]
        for f in files:
            ext = os.path.splitext(f)[1].lower()
            if ext in ('.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz', '.bin', '.exe', '.pyc', '.wasm'):
                continue

            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, dir_path).replace('\\', '/')
            try:
                with open(full_path, 'r', encoding='utf-8', errors='ignore') as fp:
                    for line_num, line in enumerate(fp, 1):
                        test_line = line if case_sensitive else line.lower()
                        if q in test_line:
                            match_obj = {
                                "file": f,
                                "path": full_path.replace('\\', '/'),
                                "relative": rel_path,
                                "line": line_num,
                                "content": line.strip()[:180],
                                "text": line.strip()[:180]
                            }
                            matches.append(match_obj)
                            if len(matches) >= max_results:
                                return {"success": True, "results": matches, "matches": matches}
            except Exception:
                continue

    return {"success": True, "results": matches, "matches": matches}


@app.post("/api/workspace/git")
async def api_workspace_git(payload: Dict[str, Any]):
    """Checks git status of workspace directory within sandbox."""
    dir_path = payload.get("path") or payload.get("folder") or ""
    safe_dir = get_safe_workspace_path(dir_path or os.getcwd())
    if not safe_dir.is_dir():
        return {"success": False, "is_git": False, "branch": "", "status": "", "dirty_count": 0}

    dir_path = str(safe_dir)

    try:
        proc_branch = await asyncio.create_subprocess_shell(
            "git branch --show-current 2>/dev/null || git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD",
            cwd=dir_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL
        )
        out_branch, _ = await asyncio.wait_for(proc_branch.communicate(), timeout=3.0)
        branch = out_branch.decode().strip()
        if branch == "HEAD" or not branch:
            proc_sym = await asyncio.create_subprocess_shell(
                "git symbolic-ref --short HEAD 2>/dev/null",
                cwd=dir_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL
            )
            out_sym, _ = await asyncio.wait_for(proc_sym.communicate(), timeout=2.0)
            sym = out_sym.decode().strip()
            branch = sym if sym else ("main" if branch == "HEAD" else "")

        if not branch:
            return {"success": True, "is_git": False, "branch": "", "status": "", "dirty_count": 0}

        proc_status = await asyncio.create_subprocess_shell(
            "git status -s",
            cwd=dir_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL
        )
        out_status, _ = await asyncio.wait_for(proc_status.communicate(), timeout=3.0)
        status_lines = [l for l in out_status.decode().splitlines() if l.strip()]

        return {
            "success": True,
            "is_git": True,
            "branch": branch,
            "dirty_count": len(status_lines),
            "status": "\n".join(status_lines)
        }
    except Exception:
        return {"success": False, "is_git": False, "branch": "", "status": "", "dirty_count": 0}



# --- Authentication & Administrative Control Endpoints ---

@app.post("/api/auth/login")
async def api_auth_login(request: Request, payload: Dict[str, Any]):
    """Securely authenticates admin user against server-side salted hash with brute-force lockout defense."""
    username = payload.get("username", "").strip()
    password = payload.get("password", "")
    client_ip = get_client_ip(request)

    # Check brute-force lockout
    check_admin_brute_force(client_ip, username)

    if verify_admin_credentials(username, password):
        reset_admin_login_failures(client_ip, username)
        token = create_admin_session()
        return {"status": "success", "token": token, "username": username}

    # Record failure and trigger lockout if threshold exceeded
    record_admin_login_failure(client_ip, username)
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


# --- Interactive SSH Pseudo-Terminal (PTY) WebSocket ---

@app.websocket("/ws/terminal/{server_id}")
async def websocket_terminal_endpoint(
    websocket: WebSocket,
    server_id: str,
    token: Optional[str] = Query(None),
    username: Optional[str] = Query(None),
    pin: Optional[str] = Query(None)
):
    """
    High-performance, zero-latency interactive SSH PTY bridge.
    Allocates a real pseudo-terminal on the target node, supporting interactive CLI apps:
    nano, vim, htop, top, ollama run, python REPL, etc.
    Strictly authenticates caller via admin session token or verified node reservation.
    """
    await websocket.accept()

    # Security Check: Must be valid admin OR verified reservation owner
    is_admin = is_valid_admin_token(token)
    is_authorized_user = False
    client_ip = websocket.client.host if websocket.client else "127.0.0.1"

    if not is_admin and username and pin:
        try:
            auth_res = verify_or_register_user(username, pin, client_ip=client_ip)
            owner_info = get_server_ownership(server_id)
            if not owner_info.get("is_claimed"):
                claim_res = claim_server(server_id, username, pin, client_ip=client_ip)
                if claim_res.get("success"):
                    is_authorized_user = True
            elif owner_info.get("owner", "").lower() == username.strip().lower():
                is_authorized_user = True
        except Exception:
            pass

    if not is_admin and not is_authorized_user:
        await websocket.send_bytes(b"\r\n\x1b[31m[Courtesy Security: Terminal access denied. Node reservation or admin session required.]\x1b[0m\r\n")
        await websocket.close(code=4003)
        return

    if paramiko is None:
        await websocket.send_bytes(b"\r\n\x1b[31m[Courtesy: paramiko library required for interactive PTY terminal]\x1b[0m\r\n")
        await websocket.close()
        return

    # 1. Resolve server
    server = get_server_by_id(server_id)
    if not server and server_id == "cst":
        server = {"id": "cst", "ssh_host": "127.0.0.1", "ssh_user": "cst"}

    if not server:
        await websocket.send_bytes(f"\r\n\x1b[31m[Courtesy: Server '{server_id}' not found]\x1b[0m\r\n".encode("utf-8"))
        await websocket.close()
        return

    ssh_host = server.get("ssh_host", f"{server_id}.local")
    ssh_user = server.get("ssh_user", server_id)
    if server_id == "cst" and IS_ON_CST:
        ssh_host = "127.0.0.1"

    touch_activity(server_id)

    # 2. Establish Paramiko SSH Client
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    connected = False
    try:
        await asyncio.to_thread(client.connect, ssh_host, username=ssh_user, timeout=5.0)
        connected = True
    except Exception as e1:
        logger.debug(f"SSH key auth failed for {server_id}@{ssh_host}: {e1}, attempting password fallback...")
        try:
            ssh_pass = os.environ.get("COURTESY_SSH_PASS", "cst")
            await asyncio.to_thread(client.connect, ssh_host, username=ssh_user, password=ssh_pass, timeout=5.0)
            connected = True
        except Exception as e2:
            logger.error(f"SSH connection failed to {ssh_user}@{ssh_host}: {e2}")
            err_msg = f"\r\n\x1b[31m[Courtesy: Failed to connect to {ssh_user}@{ssh_host}: {e2}]\x1b[0m\r\n"
            await websocket.send_bytes(err_msg.encode("utf-8"))
            await websocket.close()
            return

    # 3. Create interactive PTY channel (default 100 cols, 30 rows)
    chan = await asyncio.to_thread(client.invoke_shell, term="xterm-256color", width=100, height=30)
    chan.setblocking(False)

    stop_event = threading.Event()
    loop = asyncio.get_running_loop()

    # 4. Reader task: Remote PTY (SSH) -> Client (WebSocket)
    async def pty_reader():
        while not stop_event.is_set():
            try:
                def read_chan():
                    if chan.recv_ready():
                        return chan.recv(4096)
                    r, _, _ = select.select([chan], [], [], 0.03)
                    if r and chan.recv_ready():
                        return chan.recv(4096)
                    return b""

                data = await loop.run_in_executor(None, read_chan)
                if data:
                    await websocket.send_bytes(data)
                elif chan.exit_status_ready():
                    break
            except Exception:
                break

    # 5. Writer task: Client (WebSocket) -> Remote PTY (SSH)
    async def pty_writer():
        while not stop_event.is_set():
            try:
                msg = await websocket.receive()
                if "bytes" in msg and msg["bytes"]:
                    chan.send(msg["bytes"])
                    touch_activity(server_id)
                elif "text" in msg and msg["text"]:
                    text = msg["text"]
                    if text.startswith("{") and text.endswith("}"):
                        try:
                            ctrl = json.loads(text)
                            if ctrl.get("type") == "resize":
                                cols = int(ctrl.get("cols", 100))
                                rows = int(ctrl.get("rows", 30))
                                chan.resize_pty(width=cols, height=rows)
                                continue
                        except Exception:
                            pass
                    chan.send(text.encode("utf-8"))
                    touch_activity(server_id)
                elif msg.get("type") == "websocket.disconnect":
                    break
            except (WebSocketDisconnect, Exception):
                break

    reader_task = asyncio.create_task(pty_reader())
    writer_task = asyncio.create_task(pty_writer())

    done, pending = await asyncio.wait(
        [reader_task, writer_task],
        return_when=asyncio.FIRST_COMPLETED
    )

    stop_event.set()
    for t in pending:
        t.cancel()

    try:
        chan.close()
    except Exception:
        pass
    try:
        client.close()
    except Exception:
        pass


# --- Static Files & SPA Route ---

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/")
async def serve_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return JSONResponse({"message": "Courtesy AI Backend Running. Static files not yet compiled."})
