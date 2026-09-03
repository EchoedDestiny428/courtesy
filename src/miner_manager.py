"""
Courtesy Autonomous Idle GPU Crypto Mining Manager
Manages background mining across cluster GPUs during idle periods,
with sub-second preemption when AI inference requests arrive.
"""

import asyncio
import json
import logging
import os
import socket
import time
from pathlib import Path
from typing import Dict, Any, List, Optional

logger = logging.getLogger("courtesy.miner")

CONFIG_PATH = Path(__file__).parent.parent / "config" / "mining.json"
IS_ON_CST = socket.gethostname().lower() in ("cst", "cst.local") or os.path.exists("/opt/courtesy")

_last_inference_timestamp: float = time.time()
_is_preempted: bool = False
_is_mining_active: bool = False


def load_mining_config() -> Dict[str, Any]:
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Error reading mining.json: {e}")
    return {
        "enabled": False,
        "coin": "ERG",
        "wallet": "YOUR_WALLET_ADDRESS_HERE",
        "pool": "de.ergo.herominers.com:1180",
        "algo": "autolykos2",
        "power_limit_watts": 60,
        "idle_threshold_seconds": 180,
        "temp_limit_celsius": 68,
        "nodes": ["kraken", "cst6", "cst7"]
    }


def save_mining_config(cfg: Dict[str, Any]):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


def generate_nanominer_ini(node_id: str, cfg: Dict[str, Any]) -> str:
    coin = cfg.get("coin", "ERG").upper()
    wallet = cfg.get("wallet", "").strip()
    pool = cfg.get("pool", "de.ergo.herominers.com:1180")

    algo_section = "Autolykos"
    if "ETC" in coin:
        algo_section = "Ethash"
    elif "RVN" in coin:
        algo_section = "Kawpow"

    ini = f"""[{algo_section}]
coin = {coin}
wallet = {wallet}
rigName = courtesy-{node_id}
pool1 = {pool}
webPassword = courtesy
webPort = 9090
watchdog = false
memTweak = 0
"""
    return ini


def record_inference_start():
    """Called whenever an inference request begins to track activity and trigger preemption."""
    global _last_inference_timestamp
    _last_inference_timestamp = time.time()
    asyncio.create_task(preempt_mining())


async def preempt_mining():
    """
    Instantly stops all background mining across the cluster (<250ms)
    to free 100% of GPU VRAM and compute for AI coding models.
    """
    global _is_preempted, _is_mining_active
    _is_preempted = True
    _is_mining_active = False

    cfg = load_mining_config()
    nodes = cfg.get("nodes", ["kraken", "cst6", "cst7"])

    async def _kill_miner_on_node(node_id: str):
        try:
            if IS_ON_CST:
                cmd = ["ssh", "-o", "ConnectTimeout=2", "-o", "BatchMode=yes", node_id, "pkill -9 -f nanominer || true"]
            else:
                cmd = ["ssh", "-o", "ConnectTimeout=2", "-o", "BatchMode=yes", "cst@cst", f"ssh -o ConnectTimeout=2 {node_id} 'pkill -9 -f nanominer || true'"]
            proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await asyncio.wait_for(proc.wait(), timeout=1.5)
        except Exception:
            pass

    tasks = [_kill_miner_on_node(n) for n in nodes]
    await asyncio.gather(*tasks, return_exceptions=True)
    logger.info("Instantly preempted idle mining across cluster for AI inference")


async def start_mining_cluster():
    """Configures and starts nanominer on all configured compute nodes."""
    global _is_mining_active, _is_preempted
    cfg = load_mining_config()
    if not cfg.get("enabled"):
        return

    nodes = cfg.get("nodes", ["kraken", "cst6", "cst7"])
    _is_preempted = False

    async def _start_node_miner(node_id: str):
        try:
            ini_content = generate_nanominer_ini(node_id, cfg)
            remote_cmd = "cat > ~/miner/config.ini; pkill -9 -f nanominer 2>/dev/null || true; sleep 0.5; cd ~/miner && nohup nice -n 19 ./nanominer config.ini > miner.log 2>&1 &"

            if IS_ON_CST:
                cmd = ["ssh", "-o", "ConnectTimeout=4", node_id, remote_cmd]
            else:
                cmd = ["ssh", "-o", "ConnectTimeout=4", "cst@cst", f"ssh {node_id} '{remote_cmd}'"]

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL
            )
            await asyncio.wait_for(proc.communicate(input=ini_content.encode("utf-8")), timeout=6.0)
        except Exception as e:
            logger.warning(f"Failed to start miner on {node_id}: {e}")

    tasks = [_start_node_miner(n) for n in nodes]
    await asyncio.gather(*tasks, return_exceptions=True)
    _is_mining_active = True
    logger.info("Autonomous idle mining started across cluster")


async def check_miner_process(node_id: str) -> bool:
    """Checks if nanominer is currently running on a node."""
    try:
        if IS_ON_CST:
            cmd = ["ssh", "-o", "ConnectTimeout=2", "-o", "BatchMode=yes", node_id, "pgrep -f nanominer"]
        else:
            cmd = ["ssh", "-o", "ConnectTimeout=2", "-o", "BatchMode=yes", "cst@cst", f"ssh {node_id} pgrep -f nanominer"]
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3.0)
        return bool(stdout.strip())
    except Exception:
        return False


async def get_cluster_mining_status() -> Dict[str, Any]:
    """Returns comprehensive live status of the idle mining fleet."""
    global _is_mining_active, _is_preempted, _last_inference_timestamp
    cfg = load_mining_config()

    idle_seconds = max(0, int(time.time() - _last_inference_timestamp))
    threshold = cfg.get("idle_threshold_seconds", 180)

    # Determine overall state
    if not cfg.get("enabled"):
        state = "disabled"
    elif _is_preempted:
        state = "preempted_inference"
    elif _is_mining_active:
        state = "mining"
    elif idle_seconds < threshold:
        state = "idle_waiting"
    else:
        state = "ready_to_mine"

    # Per-node status
    nodes = cfg.get("nodes", ["kraken", "cst6", "cst7"])
    node_checks = await asyncio.gather(*[check_miner_process(n) for n in nodes], return_exceptions=True)

    node_details = []
    total_active_miners = 0
    for i, n in enumerate(nodes):
        running = node_checks[i] is True if i < len(node_checks) else False
        if running:
            total_active_miners += 1
        node_details.append({
            "node_id": n,
            "running": running,
            "gpus": 2
        })

    estimated_hashrate_mhs = total_active_miners * 2 * 42 if state == "mining" else 0

    return {
        "enabled": cfg.get("enabled", False),
        "state": state,
        "coin": cfg.get("coin", "ERG"),
        "wallet": cfg.get("wallet", ""),
        "pool": cfg.get("pool", ""),
        "idle_seconds": idle_seconds,
        "idle_threshold": threshold,
        "active_miners": total_active_miners,
        "estimated_hashrate_mhs": estimated_hashrate_mhs,
        "nodes": node_details
    }


async def idle_mining_watcher_loop(active_requests_func):
    """
    Background worker that runs every 8 seconds:
    - If AI inference requests > 0: ensures mining is preempted.
    - If cluster has been idle for >= idle_threshold_seconds: launches mining!
    """
    while True:
        try:
            cfg = load_mining_config()
            if cfg.get("enabled"):
                active_count = active_requests_func()
                idle_sec = time.time() - _last_inference_timestamp
                threshold = cfg.get("idle_threshold_seconds", 180)

                if active_count > 0:
                    if _is_mining_active:
                        await preempt_mining()
                elif idle_sec >= threshold and not _is_mining_active:
                    await start_mining_cluster()

        except Exception as e:
            logger.debug(f"Mining watcher error: {e}")

        await asyncio.sleep(8)
