import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Dict, Any, List, Optional, AsyncIterator
import httpx

from src.config import get_servers, get_server_by_id, get_routing_settings
from src.collector import get_cached_metrics

logger = logging.getLogger("courtesy.router")

# Track active in-flight requests per server
_active_requests: Dict[str, int] = {}
_request_lock = asyncio.Lock()


@dataclass
class RouteTarget:
    server_id: str
    server_name: str
    host: str
    port: int
    model_name: str
    server_type: str = "ollama"

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"


async def track_request_start(server_id: str):
    async with _request_lock:
        _active_requests[server_id] = _active_requests.get(server_id, 0) + 1


async def track_request_end(server_id: str):
    async with _request_lock:
        if server_id in _active_requests:
            _active_requests[server_id] = max(0, _active_requests[server_id] - 1)


def get_active_request_count(server_id: str) -> int:
    return _active_requests.get(server_id, 0)


def resolve_route(model_query: str = "auto", preferred_server: Optional[str] = None) -> RouteTarget:
    """
    Intelligently resolves which server and model to route the request to.
    Supports modular server selection, auto load-balancing, and fallback.
    """
    servers = [s for s in get_servers() if s.get("enabled", True) and s.get("type") == "ollama"]
    metrics = get_cached_metrics()

    if not servers:
        raise ValueError("No active inference servers configured in the cluster.")

    # 1. Direct server targeting: e.g. "kraken", "cst7", "kraken/qwen2.5-coder", "cst7:qwen2.5-coder"
    target_server_id = preferred_server
    clean_model = model_query.strip()

    # Check for separator (: or /)
    for sep in ("/", ":"):
        if sep in clean_model:
            prefix, remainder = clean_model.split(sep, 1)
            for s in servers:
                if s.get("id") == prefix.lower():
                    target_server_id = prefix.lower()
                    clean_model = remainder
                    break
            if target_server_id:
                break

    # If clean_model itself matches a known server ID
    if not target_server_id:
        for s in servers:
            if s.get("id") == clean_model.lower():
                target_server_id = s.get("id")
                clean_model = "auto"
                break

    # If a specific server was requested
    if target_server_id:
        srv = get_server_by_id(target_server_id)
        if srv and srv.get("enabled"):
            # Check model name
            m_name = clean_model if clean_model not in ("auto", "default", "codex", "claude") else srv.get("preferred_model", "")
            if not m_name and srv.get("id") in metrics:
                s_models = metrics[srv["id"]].get("models", [])
                if s_models:
                    m_name = s_models[0].get("name")
            if not m_name:
                m_name = "qwen2.5-coder:7b-instruct-q4_K_M"
                
            return RouteTarget(
                server_id=srv["id"],
                server_name=srv.get("name", srv["id"]),
                host=srv.get("host", "127.0.0.1"),
                port=srv.get("port", 11434),
                model_name=m_name,
                server_type=srv.get("type", "ollama")
            )

    # 2. Check if a specific model was requested across servers
    if clean_model not in ("auto", "default", "codex", "claude", "claude-3-5-sonnet", "coder", ""):
        # Find which server hosts this exact model
        for s in servers:
            s_id = s.get("id")
            s_metrics = metrics.get(s_id, {})
            s_models = [m.get("name") for m in s_metrics.get("models", [])]
            if clean_model in s_models:
                return RouteTarget(
                    server_id=s_id,
                    server_name=s.get("name", s_id),
                    host=s.get("host", "127.0.0.1"),
                    port=s.get("port", 11434),
                    model_name=clean_model,
                    server_type=s.get("type", "ollama")
                )

    # 3. Modular Auto Load-Balancing & Routing
    # Evaluate all online candidate servers
    candidates = []
    for s in servers:
        s_id = s.get("id")
        s_metric = metrics.get(s_id, {})
        # Check if online (or assume online if not yet polled)
        is_online = s_metric.get("online", True)
        if not is_online:
            continue

        active_jobs = get_active_request_count(s_id)
        latency = s_metric.get("latency_ms", 50.0) or 50.0
        
        # Determine best model for this server
        chosen_model = s.get("preferred_model")
        if not chosen_model and s_metric.get("models"):
            chosen_model = s_metric["models"][0].get("name")
        if not chosen_model:
            chosen_model = "qwen2.5-coder:7b-instruct-q4_K_M"

        score = active_jobs * 100 + latency
        candidates.append((score, s, chosen_model))

    if candidates:
        candidates.sort(key=lambda c: c[0])
        best = candidates[0]
        srv = best[1]
        return RouteTarget(
            server_id=srv["id"],
            server_name=srv.get("name", srv["id"]),
            host=srv.get("host", "127.0.0.1"),
            port=srv.get("port", 11434),
            model_name=best[2],
            server_type=srv.get("type", "ollama")
        )

    # Fallback to first configured inference server
    default_srv = servers[0]
    return RouteTarget(
        server_id=default_srv["id"],
        server_name=default_srv.get("name", default_srv["id"]),
        host=default_srv.get("host", "127.0.0.1"),
        port=default_srv.get("port", 11434),
        model_name=default_srv.get("preferred_model", "qwen2.5-coder:7b-instruct-q4_K_M"),
        server_type=default_srv.get("type", "ollama")
    )


async def execute_via_cst_proxy(url_path: str, payload: Dict[str, Any], stream: bool = False):
    """
    If running locally on Windows and unable to reach 10.11.x.x directly,
    executes the request through the cst gateway via SSH curl stream.
    """
    json_str = json.dumps(payload)
    cmd = [
        "ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", "cst@cst",
        f"curl -s -N {url_path} -d @-"
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await proc.communicate(input=json_str.encode("utf-8"))
    return stdout.decode("utf-8", errors="ignore")
