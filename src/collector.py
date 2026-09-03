import asyncio
import logging
import os
import re
import shutil
import socket
import subprocess
import time
from typing import Dict, Any, List, Optional
import httpx

from src.config import get_servers, load_config

logger = logging.getLogger("courtesy.collector")

# Detect if running directly on the cst gateway
IS_ON_CST = socket.gethostname().lower() in ("cst", "cst.local") or os.path.exists("/opt/courtesy")

# In-memory metrics cache: server_id -> metrics dict
_metrics_cache: Dict[str, Dict[str, Any]] = {}
_cache_lock = asyncio.Lock()


def parse_nvidia_smi_output(output: str) -> List[Dict[str, Any]]:
    """
    Parses CSV output from:
    nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.total,memory.used,fan.speed --format=csv,noheader,nounits
    """
    gpus = []
    for line in output.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 6:
            try:
                gpu_idx = int(parts[0])
                name = parts[1]
                temp = int(float(parts[2])) if parts[2] != "[Not Supported]" else 0
                util = int(float(parts[3])) if parts[3] != "[Not Supported]" else 0
                mem_total = int(float(parts[4])) if parts[4] != "[Not Supported]" else 5120
                mem_used = int(float(parts[5])) if parts[5] != "[Not Supported]" else 0
                fan = int(float(parts[6])) if len(parts) > 6 and parts[6] != "[Not Supported]" else 0
                
                gpus.append({
                    "index": gpu_idx,
                    "name": name,
                    "temp_c": temp,
                    "util_percent": util,
                    "vram_used_mb": mem_used,
                    "vram_total_mb": mem_total,
                    "vram_percent": round((mem_used / mem_total) * 100, 1) if mem_total > 0 else 0,
                    "fan_percent": fan
                })
            except Exception as e:
                logger.debug(f"Failed to parse GPU line: {line}: {e}")
    return gpus


def parse_free_output(output: str) -> Dict[str, float]:
    """Parses `free -m` output for RAM used and total in GB."""
    ram = {"ram_used_gb": 0.0, "ram_total_gb": 0.0, "ram_percent": 0.0}
    for line in output.strip().splitlines():
        if line.startswith("Mem:"):
            parts = line.split()
            if len(parts) >= 3:
                try:
                    total_mb = float(parts[1])
                    used_mb = float(parts[2])
                    ram["ram_total_gb"] = round(total_mb / 1024, 2)
                    ram["ram_used_gb"] = round(used_mb / 1024, 2)
                    ram["ram_percent"] = round((used_mb / total_mb) * 100, 1) if total_mb > 0 else 0
                except Exception:
                    pass
    return ram


async def fetch_ssh_metrics(server: Dict[str, Any]) -> Dict[str, Any]:
    """Runs a quick command over SSH to collect nvidia-smi and system stats."""
    server_id = server.get("id", "")
    ssh_host = server.get("ssh_host")
    ssh_user = server.get("ssh_user")
    
    # Command to run on the target host
    cmd_str = (
        "nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.total,memory.used,fan.speed "
        "--format=csv,noheader,nounits 2>/dev/null; "
        "echo '---MEM---'; free -m; "
        "echo '---CPU---'; grep 'cpu ' /proc/stat"
    )

    try:
        out_text = ""
        ssh_target = f"{ssh_user}@{ssh_host}" if ssh_user else ssh_host
        if IS_ON_CST:
            # We are running on the cst gateway node directly
            if server_id == "cst":
                proc = await asyncio.create_subprocess_shell(
                    "free -m; echo '---CPU---'; grep 'cpu ' /proc/stat",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3.0)
                out_text = "---MEM---\n" + stdout.decode("utf-8", errors="ignore")
            elif ssh_target:
                proc = await asyncio.create_subprocess_exec(
                    "ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", ssh_target,
                    cmd_str,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=4.0)
                out_text = stdout.decode("utf-8", errors="ignore")
        else:
            # External runner (e.g. Windows dev machine): hop through cst gateway via SSH
            if not shutil.which("ssh"):
                return {}
            if server_id == "cst":
                proc = await asyncio.create_subprocess_exec(
                    "ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", "cst@cst",
                    "free -m; echo '---CPU---'; grep 'cpu ' /proc/stat",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=4.0)
                out_text = "---MEM---\n" + stdout.decode("utf-8", errors="ignore")
            elif ssh_target:
                remote_cmd = f"ssh -o ConnectTimeout=3 -o BatchMode=yes {ssh_target} \"{cmd_str}\""
                proc = await asyncio.create_subprocess_exec(
                    "ssh", "-o", "ConnectTimeout=4", "-o", "BatchMode=yes", "cst@cst",
                    remote_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
                out_text = stdout.decode("utf-8", errors="ignore")

        gpu_part = out_text.split("---MEM---")[0] if "---MEM---" in out_text else out_text
        mem_part = ""
        if "---MEM---" in out_text:
            rest = out_text.split("---MEM---")[1]
            mem_part = rest.split("---CPU---")[0] if "---CPU---" in rest else rest
            
        gpus = parse_nvidia_smi_output(gpu_part)
        ram_info = parse_free_output(mem_part)
        
        return {
            "gpus": gpus,
            **ram_info
        }
    except Exception as e:
        logger.debug(f"SSH metrics failed for {server_id}: {e}")
        return {}


async def poll_server(server: Dict[str, Any], client: httpx.AsyncClient) -> Dict[str, Any]:
    """Polls a single server for Ollama/API models and system/GPU metrics."""
    server_id = server.get("id", "")
    server_name = server.get("name", server_id)
    server_type = server.get("type", "ollama")
    host = server.get("host", "127.0.0.1")
    port = server.get("port", 11434)
    enabled = server.get("enabled", True)
    
    metrics: Dict[str, Any] = {
        "id": server_id,
        "name": server_name,
        "role": server.get("role", "inference"),
        "type": server_type,
        "host": host,
        "port": port,
        "enabled": enabled,
        "online": False,
        "latency_ms": None,
        "models": [],
        "running_models": [],
        "gpus": server.get("specs", {}).get("gpus", []),
        "ram_total_gb": 0.0,
        "ram_used_gb": 0.0,
        "ram_percent": 0.0,
        "cpu_percent": 0.0,
        "preferred_model": server.get("preferred_model", ""),
        "tags": server.get("tags", []),
        "last_checked": time.time(),
        "error": None
    }

    if not enabled:
        metrics["error"] = "Disabled in configuration"
        return metrics

    # For system-only nodes (like cst gateway)
    if server_type == "system_only":
        t0 = time.time()
        ssh_data = await fetch_ssh_metrics(server)
        if ssh_data:
            metrics["online"] = True
            metrics["latency_ms"] = round((time.time() - t0) * 1000, 1)
            metrics.update(ssh_data)
        return metrics

    # For Ollama / Inference nodes
    # If running on local Windows machine, HTTP requests to 10.11.x.x need to reach the LAN
    # Since 10.11.x.x is on the local Ethernet behind cst, we can test HTTP direct or via proxy
    t0 = time.time()
    direct_url = f"http://{host}:{port}/api/tags"
    
    ollama_ok = False
    try:
        # First attempt: direct HTTP (works if machine is on same subnet or routes exist)
        resp = await client.get(direct_url, timeout=2.0)
        if resp.status_code == 200:
            ollama_ok = True
            metrics["latency_ms"] = round((time.time() - t0) * 1000, 1)
            data = resp.json()
            metrics["models"] = [
                {
                    "name": m.get("name"),
                    "size_gb": round(m.get("size", 0) / (1024**3), 2),
                    "family": m.get("details", {}).get("family", ""),
                    "parameter_size": m.get("details", {}).get("parameter_size", ""),
                    "quantization": m.get("details", {}).get("quantization_level", "")
                }
                for m in data.get("models", [])
            ]
            
            # Check running models via /api/ps
            try:
                ps_resp = await client.get(f"http://{host}:{port}/api/ps", timeout=2.0)
                if ps_resp.status_code == 200:
                    metrics["running_models"] = ps_resp.json().get("models", [])
            except Exception:
                pass
    except Exception:
        pass

    # If direct HTTP failed (e.g. from outside LAN), query via cst SSH curl
    if not ollama_ok:
        try:
            t0 = time.time()
            proc = await asyncio.create_subprocess_exec(
                "ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", "cst@cst",
                f"curl -s --connect-timeout 2 http://{host}:{port}/api/tags",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=4.0)
            if stdout:
                import json
                data = json.loads(stdout.decode("utf-8"))
                if "models" in data:
                    ollama_ok = True
                    metrics["latency_ms"] = round((time.time() - t0) * 1000, 1)
                    metrics["models"] = [
                        {
                            "name": m.get("name"),
                            "size_gb": round(m.get("size", 0) / (1024**3), 2),
                            "family": m.get("details", {}).get("family", ""),
                            "parameter_size": m.get("details", {}).get("parameter_size", ""),
                            "quantization": m.get("details", {}).get("quantization_level", "")
                        }
                        for m in data.get("models", [])
                    ]
        except Exception as e:
            metrics["error"] = str(e)

    metrics["online"] = ollama_ok

    # Fetch SSH hardware metrics (Dual Quadro P2000s, RAM, etc.)
    if metrics["online"]:
        ssh_data = await fetch_ssh_metrics(server)
        if ssh_data:
            if "gpus" in ssh_data and ssh_data["gpus"]:
                metrics["gpus"] = ssh_data["gpus"]
            if "ram_total_gb" in ssh_data:
                metrics["ram_total_gb"] = ssh_data["ram_total_gb"]
                metrics["ram_used_gb"] = ssh_data["ram_used_gb"]
                metrics["ram_percent"] = ssh_data["ram_percent"]

    return metrics


async def update_all_metrics() -> Dict[str, Dict[str, Any]]:
    """Polls all configured servers concurrently and updates the metrics cache."""
    servers = get_servers()
    async with httpx.AsyncClient() as client:
        tasks = [poll_server(s, client) for s in servers]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    async with _cache_lock:
        for s, res in zip(servers, results):
            server_id = s.get("id")
            if isinstance(res, dict):
                _metrics_cache[server_id] = res
            elif isinstance(res, Exception):
                logger.error(f"Error polling server {server_id}: {res}")
                if server_id not in _metrics_cache:
                    _metrics_cache[server_id] = {
                        "id": server_id,
                        "name": s.get("name", server_id),
                        "online": False,
                        "error": str(res)
                    }

    return _metrics_cache.copy()


def get_cached_metrics() -> Dict[str, Dict[str, Any]]:
    return _metrics_cache.copy()


def get_cluster_summary() -> Dict[str, Any]:
    """Aggregates cluster-wide compute and VRAM capacity."""
    cache = get_cached_metrics()
    total_nodes = len(cache)
    online_nodes = sum(1 for m in cache.values() if m.get("online"))
    
    total_gpus = 0
    total_vram_mb = 0
    used_vram_mb = 0
    all_models = set()

    for m in cache.values():
        if m.get("online"):
            for gpu in m.get("gpus", []):
                total_gpus += 1
                total_vram_mb += gpu.get("vram_total_mb", 0)
                used_vram_mb += gpu.get("vram_used_mb", 0)
            for model in m.get("models", []):
                all_models.add(model.get("name"))

    return {
        "total_nodes": total_nodes,
        "online_nodes": online_nodes,
        "total_gpus": total_gpus,
        "total_vram_gb": round(total_vram_mb / 1024, 2),
        "used_vram_gb": round(used_vram_mb / 1024, 2),
        "vram_utilization_percent": round((used_vram_mb / total_vram_mb) * 100, 1) if total_vram_mb > 0 else 0,
        "unique_models_count": len(all_models),
        "models": sorted(list(all_models))
    }
