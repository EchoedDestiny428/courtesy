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
        # Normalize search tokens
        is_7b_req = any(tok in clean_model.lower() for tok in ("7b", "fast"))
        is_14b_req = any(tok in clean_model.lower() for tok in ("14b", "heavy", "reasoning"))
        
        matching_candidates = []
        for s in servers:
            s_id = s.get("id")
            s_metrics = metrics.get(s_id, {})
            if not s_metrics.get("online", True):
                continue

            s_models = [m.get("name") for m in s_metrics.get("models", [])]
            found_model = None

            # Exact match
            if clean_model in s_models:
                found_model = clean_model
            else:
                # Fuzzy / tag match
                for m_name in s_models:
                    if clean_model.lower() in m_name.lower():
                        found_model = m_name
                        break
                    if is_14b_req and "14b" in m_name.lower():
                        found_model = m_name
                        break
                    if is_7b_req and "7b" in m_name.lower():
                        found_model = m_name
                        break

            if found_model:
                active_jobs = get_active_request_count(s_id)
                latency = s_metrics.get("latency_ms", 50.0) or 50.0
                score = active_jobs * 100 + latency
                matching_candidates.append((score, s, found_model))

        if matching_candidates:
            matching_candidates.sort(key=lambda c: c[0])
            best_match = matching_candidates[0]
            srv = best_match[1]
            return RouteTarget(
                server_id=srv["id"],
                server_name=srv.get("name", srv["id"]),
                host=srv.get("host", "127.0.0.1"),
                port=srv.get("port", 11434),
                model_name=best_match[2],
                server_type=srv.get("type", "ollama")
            )

    # 3. Modular Auto Load-Balancing & Routing across all online nodes
    candidates = []
    for s in servers:
        s_id = s.get("id")
        s_metric = metrics.get(s_id, {})
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
            chosen_model = "qwen2.5-coder:7b"

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
        model_name=default_srv.get("preferred_model", "qwen2.5-coder:7b"),
        server_type=default_srv.get("type", "ollama")
    )


async def ensure_vram_headroom(target: RouteTarget, client: httpx.AsyncClient):
    """
    If loading 14B or a model requiring full VRAM, proactively unloads other resident models
    via Ollama's `keep_alive: 0` API to avoid CPU RAM spilling across dual Quadro P2000s.
    """
    is_heavy = "14b" in target.model_name.lower()
    if not is_heavy:
        return

    try:
        ps_url = f"{target.base_url}/api/ps"
        resp = await client.get(ps_url, timeout=2.0)
        if resp.status_code == 200:
            data = resp.json()
            running = data.get("models", [])
            for m in running:
                m_name = m.get("name", "")
                if m_name and m_name != target.model_name:
                    logger.info(f"Proactively offloading resident model '{m_name}' on {target.server_id} to ensure full VRAM headroom for '{target.model_name}'")
                    await client.post(
                        f"{target.base_url}/api/generate",
                        json={"model": m_name, "keep_alive": 0},
                        timeout=5.0
                    )
    except Exception as e:
        logger.debug(f"VRAM headroom offload check error on {target.server_id}: {e}")


async def offload_server_models(server: Any) -> List[str]:
    """Unloads all currently resident models on a server to free 100% of VRAM."""
    if isinstance(server, str):
        server_obj = get_server_by_id(server)
        if not server_obj:
            logger.warning(f"Cannot offload unknown server id: {server}")
            return []
        server = server_obj

    host = server.get("host", "127.0.0.1")
    port = server.get("port", 11434)
    base_url = f"http://{host}:{port}"
    unloaded = []

    async with httpx.AsyncClient(timeout=6.0) as client:
        try:
            resp = await client.get(f"{base_url}/api/ps")
            if resp.status_code == 200:
                data = resp.json()
                for m in data.get("models", []):
                    m_name = m.get("name")
                    if m_name:
                        await client.post(f"{base_url}/api/generate", json={"model": m_name, "keep_alive": 0})
                        unloaded.append(m_name)
        except Exception as e:
            logger.error(f"Error offloading models on {server.get('id')}: {e}")

    return unloaded


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
