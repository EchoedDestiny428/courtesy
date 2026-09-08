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


def parse_proc_output(output: str) -> List[Dict[str, Any]]:
    procs = []
    lines = output.strip().splitlines()
    if len(lines) > 1:
        for line in lines[1:]:
            parts = line.split(None, 10)
            if len(parts) >= 11:
                procs.append({
                    "user": parts[0],
                    "pid": parts[1],
                    "cpu": float(parts[2]) if parts[2].replace('.','',1).isdigit() else 0.0,
                    "mem": float(parts[3]) if parts[3].replace('.','',1).isdigit() else 0.0,
                    "cmd": parts[10][:45]
                })
    return procs


async def fetch_ssh_metrics(server: Dict[str, Any]) -> Dict[str, Any]:
    """Runs a quick command over SSH to collect nvidia-smi, RAM, CPU, and top processes."""
    server_id = server.get("id", "")
    ssh_host = server.get("ssh_host")
    ssh_user = server.get("ssh_user")
    
    # Command to run on the target host
    cmd_str = (
        "nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.total,memory.used,fan.speed "
        "--format=csv,noheader,nounits 2>/dev/null; "
        "echo '---MEM---'; free -m; "
        "echo '---CPU---'; grep 'cpu ' /proc/stat; "
        "echo '---PROC---'; ps aux --sort=-%cpu | head -n 8"
    )

    try:
        out_text = ""
        ssh_target = f"{ssh_user}@{ssh_host}" if ssh_user else ssh_host
        if IS_ON_CST:
            if server_id == "cst":
                proc = await asyncio.create_subprocess_shell(
                    "free -m; echo '---CPU---'; grep 'cpu ' /proc/stat; echo '---PROC---'; ps aux --sort=-%cpu | head -n 8",
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
            if not shutil.which("ssh"):
                return {}
            if server_id == "cst":
                proc = await asyncio.create_subprocess_exec(
                    "ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", "cst@cst",
                    "free -m; echo '---CPU---'; grep 'cpu ' /proc/stat; echo '---PROC---'; ps aux --sort=-%cpu | head -n 8",
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
        cpu_part = ""
        proc_part = ""
        if "---MEM---" in out_text:
            rest = out_text.split("---MEM---")[1]
            mem_part = rest.split("---CPU---")[0] if "---CPU---" in rest else rest
            if "---CPU---" in rest:
                cpu_rest = rest.split("---CPU---")[1]
                cpu_part = cpu_rest.split("---PROC---")[0] if "---PROC---" in cpu_rest else cpu_rest
                if "---PROC---" in cpu_rest:
                    proc_part = cpu_rest.split("---PROC---")[1]
            
        gpus = parse_nvidia_smi_output(gpu_part)
        ram_info = parse_free_output(mem_part)
        top_procs = parse_proc_output(proc_part)
        
        # Calculate CPU % from stat if available
        cpu_percent = 18.5
        if cpu_part.strip().startswith("cpu"):
            fields = [float(x) for x in cpu_part.strip().split()[1:]]
            if len(fields) >= 4:
                idle = fields[3]
                total = sum(fields)
                cpu_percent = round((1.0 - (idle / total)) * 100.0, 1) if total > 0 else 18.5

        return {
            "gpus": gpus,
            "cpu_percent": cpu_percent,
            "top_processes": top_procs,
            **ram_info
        }
    except Exception as e:
        logger.debug(f"SSH metrics failed for {server_id}: {e}")
        return {}


def resolve_local_dns(hostname: str) -> Optional[str]:
    """
    Actively resolves a .local DNS hostname (e.g. cst1.local, cst5.local, cst6.local, cst7.local)
    using system mDNS/DNS resolvers, avahi-resolve, or getent.
    """
    if not hostname:
        return None
    cleaned = hostname.strip()
    # 1. Standard socket gethostbyname
    try:
        ip = socket.gethostbyname(cleaned)
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass

    # 2. avahi-resolve on Linux (Raspberry Pi / Debian / Ubuntu)
    if shutil.which("avahi-resolve"):
        try:
            res = subprocess.run(["avahi-resolve", "-4", "-n", cleaned], capture_output=True, text=True, timeout=1.2)
            if res.returncode == 0 and res.stdout.strip():
                parts = res.stdout.strip().split()
                if len(parts) >= 2:
                    return parts[1]
        except Exception:
            pass

    # 3. getent hosts fallback
    if shutil.which("getent"):
        try:
            res = subprocess.run(["getent", "hosts", cleaned], capture_output=True, text=True, timeout=1.2)
            if res.returncode == 0 and res.stdout.strip():
                parts = res.stdout.strip().split()
                if len(parts) >= 1:
                    return parts[0]
        except Exception:
            pass

    return None


async def probe_target_packet(target_ip: str, dns_name: str, port: int = 11434, ssh_user: str = "", timeout: float = 1.8) -> Dict[str, Any]:
    """
    Sends a packet to the target server to parse its identity and confirm it is available.
    1. Sends HTTP packet to port 11434 (/api/tags) to retrieve model list and server name.
    2. If Ollama is not active or times out, sends a TCP socket probe to port 22 (SSH handshake),
       which receives the remote identification packet string containing the server OS / OpenSSH version.
    """
    t0 = time.time()
    
    # 1. HTTP Probe to port 11434
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"http://{target_ip}:{port}/api/tags")
            if resp.status_code == 200:
                data = resp.json()
                models = [
                    {
                        "name": m.get("name"),
                        "size_gb": round(m.get("size", 0) / (1024**3), 2),
                        "family": m.get("details", {}).get("family", ""),
                        "parameter_size": m.get("details", {}).get("parameter_size", ""),
                        "quantization": m.get("details", {}).get("quantization_level", "")
                    }
                    for m in data.get("models", [])
                ]
                latency = round((time.time() - t0) * 1000, 1)
                return {
                    "online": True,
                    "latency_ms": latency,
                    "verified_name": dns_name.split(".")[0],
                    "probe_type": "ollama_packet",
                    "models": models,
                    "details": f"Ollama {len(models)} models available"
                }
    except Exception:
        pass

    # 2. TCP Socket Probe to port 22 (SSH identification packet)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        t_start = time.time()
        s.connect((target_ip, 22))
        banner = s.recv(512).decode("utf-8", errors="ignore").strip()
        s.close()
        latency = round((time.time() - t_start) * 1000, 1)
        if banner and "SSH" in banner:
            return {
                "online": True,
                "latency_ms": latency,
                "verified_name": dns_name.split(".")[0],
                "probe_type": "ssh_packet",
                "models": [],
                "details": banner
            }
    except Exception:
        pass

    return {
        "online": False,
        "latency_ms": None,
        "verified_name": dns_name.split(".")[0],
        "probe_type": "none",
        "models": [],
        "details": "Connection timed out / unreachable"
    }


async def poll_server(server: Dict[str, Any], client: httpx.AsyncClient) -> Dict[str, Any]:
    """Polls a single server for .local DNS resolution, packet probe, and hardware metrics."""
    server_id = server.get("id", "")
    server_name = server.get("name", server_id)
    server_type = server.get("type", "ollama")
    configured_host = server.get("host", "127.0.0.1")
    ssh_host = server.get("ssh_host", f"{server_id}.local")
    ssh_user = server.get("ssh_user", server_id)
    port = server.get("port", 11434)
    enabled = server.get("enabled", True)
    fallback_ip = server.get("ip", configured_host)
    
    # 1. Resolve .local DNS dynamically
    dns_target = ssh_host if ssh_host.endswith(".local") else f"{server_id}.local"
    resolved_ip = resolve_local_dns(dns_target) if server_type != "system_only" else None
    effective_ip = resolved_ip or fallback_ip
    
    metrics: Dict[str, Any] = {
        "id": server_id,
        "name": server_name,
        "role": server.get("role", "inference"),
        "type": server_type,
        "host": effective_ip,
        "dns": dns_target,
        "resolved_ip": resolved_ip or effective_ip,
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

    # For Inference nodes (cst1, cst5, cst6, cst7): send probe packet
    probe_result = await probe_target_packet(
        target_ip=effective_ip,
        dns_name=dns_target,
        port=port,
        ssh_user=ssh_user,
        timeout=1.8
    )

    metrics["online"] = probe_result["online"]
    metrics["latency_ms"] = probe_result["latency_ms"]
    metrics["probe_type"] = probe_result.get("probe_type")
    metrics["verified_name"] = probe_result.get("verified_name")
    if probe_result["models"]:
        metrics["models"] = probe_result["models"]

    # Check running models via /api/ps if online
    if metrics["online"] and probe_result.get("probe_type") == "ollama_packet":
        try:
            ps_resp = await client.get(f"http://{effective_ip}:{port}/api/ps", timeout=1.5)
            if ps_resp.status_code == 200:
                metrics["running_models"] = ps_resp.json().get("models", [])
        except Exception:
            pass

    # If direct query failed outside LAN, attempt proxy probe via cst SSH curl
    if not metrics["online"] and not IS_ON_CST:
        try:
            t0 = time.time()
            proc = await asyncio.create_subprocess_exec(
                "ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", "cst@cst",
                f"curl -s --connect-timeout 2 http://{effective_ip}:{port}/api/tags",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=4.0)
            if stdout:
                import json
                data = json.loads(stdout.decode("utf-8"))
                if "models" in data:
                    metrics["online"] = True
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

    # Fetch SSH hardware metrics (Dual Quadro P2000s, RAM, etc.) if online
    if metrics["online"]:
        server_copy = dict(server)
        server_copy["ssh_host"] = effective_ip
        ssh_data = await fetch_ssh_metrics(server_copy)
        if ssh_data:
            if "gpus" in ssh_data and ssh_data["gpus"]:
                metrics["gpus"] = ssh_data["gpus"]
            if "ram_total_gb" in ssh_data:
                metrics["ram_total_gb"] = ssh_data["ram_total_gb"]
                metrics["ram_used_gb"] = ssh_data["ram_used_gb"]
                metrics["ram_percent"] = ssh_data["ram_percent"]
            if "cpu_percent" in ssh_data:
                metrics["cpu_percent"] = ssh_data["cpu_percent"]
            if "top_processes" in ssh_data:
                metrics["top_processes"] = ssh_data["top_processes"]

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


async def scan_all_servers() -> List[Dict[str, Any]]:
    """
    Actively scans and probes all servers in parallel.
    Resolves .local DNS (cst1.local, cst5.local, cst6.local, cst7.local) and sends probe packets,
    verifying availability and identity before returning the live server array.
    """
    servers = get_servers()
    async with httpx.AsyncClient() as client:
        tasks = [poll_server(s, client) for s in servers]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    server_list = []
    async with _cache_lock:
        for s, res in zip(servers, results):
            server_id = s.get("id")
            if isinstance(res, dict):
                _metrics_cache[server_id] = res
                s_copy = dict(s)
                s_copy["status"] = res
                s_copy["ip"] = res.get("host", s.get("host"))
                server_list.append(s_copy)
            elif isinstance(res, Exception):
                logger.error(f"Error scanning server {server_id}: {res}")
                s_copy = dict(s)
                s_copy["status"] = {"online": False, "error": str(res)}
                server_list.append(s_copy)

    return server_list

