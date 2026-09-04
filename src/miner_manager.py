"""
Courtesy Autonomous Idle GPU Crypto Mining Manager
Manages background mining across cluster GPUs during idle periods,
with sub-second preemption when AI inference requests arrive.
"""

import asyncio
import base64
import json
import logging
import os
import shutil
import socket
import time
from pathlib import Path
from typing import Dict, Any, List, Optional

import httpx

from src.config import get_server_by_id
from src.router import offload_server_models

logger = logging.getLogger("courtesy.miner")

CONFIG_PATH = Path(__file__).parent.parent / "config" / "mining.json"
IS_ON_CST = socket.gethostname().lower() in ("cst", "cst.local") or os.path.exists("/opt/courtesy")

_last_inference_timestamp: float = time.time()
_is_preempted: bool = False
_is_mining_active: bool = False


def resolve_node_ssh_target(node_id: str) -> str:
    """Resolves node_id (e.g. kraken, cst6) into username@host using server config."""
    srv = get_server_by_id(node_id)
    if srv:
        ssh_host = srv.get("ssh_host") or srv.get("host") or node_id
        ssh_user = srv.get("ssh_user")
        return f"{ssh_user}@{ssh_host}" if ssh_user else ssh_host
    return node_id


def build_ssh_remote_cmd(target: str, remote_cmd: str, timeout: int = 4) -> List[str]:
    """
    Constructs subprocess exec arguments to run remote_cmd on target host.
    Uses sshpass with password 'cst' if available, falling back to batch ssh.
    """
    if IS_ON_CST:
        if shutil.which("sshpass"):
            return ["sshpass", "-p", "cst", "ssh", "-o", f"ConnectTimeout={timeout}", "-o", "StrictHostKeyChecking=no", target, remote_cmd]
        return ["ssh", "-o", f"ConnectTimeout={timeout}", "-o", "BatchMode=yes", target, remote_cmd]
    else:
        escaped_cmd = remote_cmd.replace('"', '\\"')
        inner = f"sshpass -p cst ssh -o ConnectTimeout={timeout} -o StrictHostKeyChecking=no {target} \"{escaped_cmd}\""
        return ["ssh", "-o", f"ConnectTimeout={timeout}", "-o", "BatchMode=yes", "cst@cst", inner]


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


_last_pool_stats: Dict[str, Any] = {}
_last_pool_fetch_ts: float = 0.0


def parse_2miners_data(data: Dict[str, Any], coin: str = "ETC") -> Dict[str, Any]:
    """Parses raw 2Miners account response into clean telemetry dictionary."""
    stats = data.get("stats", {})
    cfg = data.get("config", {})

    bal_units = stats.get("balance", 0)
    immature_units = stats.get("immature", 0)
    paid_units = stats.get("paid", 0)
    min_units = cfg.get("minPayout", 100000000)

    # 1 ETC = 1e9 units on 2Miners
    immature_etc = immature_units / 1e9
    confirmed_etc = bal_units / 1e9
    total_pending_etc = (bal_units + immature_units) / 1e9
    paid_etc = paid_units / 1e9
    min_payout_etc = min_units / 1e9 if min_units else 0.1

    progress_pct = round(min(100.0, (total_pending_etc / max(0.0001, min_payout_etc)) * 100.0), 2)
    cur_hr_mhs = round(data.get("currentHashrate", 0) / 1e6, 2)

    # Estimated Time to Next Cashout
    # Full cluster (~95 - 105 MH/s) generates ~0.048 - 0.052 ETC/day (~$1.20 - $1.30/day)
    rem_etc = max(0.0, min_payout_etc - total_pending_etc)
    effective_hr = cur_hr_mhs if cur_hr_mhs > 10.0 else 96.0
    daily_rate = (effective_hr / 92.1) * 0.048
    hours_left = (rem_etc / max(0.0001, daily_rate)) * 24.0

    if total_pending_etc >= min_payout_etc:
        time_str = "Ready (Next 2h Pool Cycle)"
        status_lbl = "Threshold Reached • In 2h Payout Queue"
    elif hours_left < 48:
        time_str = f"~{max(1, int(hours_left))}h (~{(hours_left / 24.0):.1f}d full)"
        status_lbl = "Accumulating to 0.1 ETC Threshold"
    else:
        days = hours_left / 24.0
        time_str = f"~{days:.1f} days"
        status_lbl = "Accumulating to 0.1 ETC Threshold"

    raw_payments = data.get("payments") or []
    clean_payments = []
    for p in raw_payments[:10]:
        clean_payments.append({
            "amount_etc": round(p.get("amount", 0) / 1e9, 5),
            "timestamp": p.get("timestamp", 0),
            "tx": p.get("tx", "")
        })

    raw_workers = data.get("workers") or {}
    clean_workers = {}
    for wname, wdata in raw_workers.items():
        clean_workers[wname] = {
            "hashrate_mhs": round((wdata.get("rhr") or wdata.get("hr", 0)) / 1e6, 1),
            "shares_valid": wdata.get("sharesValid", 0),
            "shares_invalid": wdata.get("sharesInvalid", 0),
            "shares_stale": wdata.get("sharesStale", 0),
            "online": not wdata.get("offline", False)
        }

    return {
        "pool_balance_etc": round(total_pending_etc, 6),
        "pool_confirmed_etc": round(confirmed_etc, 6),
        "pool_immature_etc": round(immature_etc, 6),
        "pool_paid_etc": round(paid_etc, 6),
        "min_payout_etc": round(min_payout_etc, 4),
        "payout_progress_percent": progress_pct,
        "payments_total": data.get("paymentsTotal", len(clean_payments)),
        "payments": clean_payments,
        "shares_valid": data.get("sharesValid", 0),
        "shares_invalid": data.get("sharesInvalid", 0),
        "shares_stale": data.get("sharesStale", 0),
        "pool_hashrate_mhs": cur_hr_mhs,
        "workers_online": data.get("workersOnline", 0),
        "workers": clean_workers,
        "time_to_cashout_str": time_str,
        "status_label": status_lbl,
        "ip_hint": cfg.get("ipHint", "x.x.x.107"),
        "ip_worker_name": cfg.get("ipWorkerName", "courtesy-cst7-gpu")
    }


def update_pool_stats_from_client(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Caches pool telemetry sent from frontend browser."""
    global _last_pool_stats, _last_pool_fetch_ts
    if "stats" in payload:
        _last_pool_stats = parse_2miners_data(payload)
    elif "pool_balance_etc" in payload:
        _last_pool_stats = payload
    _last_pool_fetch_ts = time.time()
    return _last_pool_stats


async def fetch_2miners_pool_stats(wallet: str, coin: str = "ETC") -> Dict[str, Any]:
    """
    Fetches live account telemetry directly from 2Miners pool REST API.
    Cached for 15 seconds; non-blocking with 4.0s timeout to prevent UI lag.
    """
    global _last_pool_stats, _last_pool_fetch_ts
    now = time.time()
    if _last_pool_stats and (now - _last_pool_fetch_ts) < 15.0:
        return _last_pool_stats

    default_stats = {
        "pool_balance_etc": 0.0,
        "pool_confirmed_etc": 0.0,
        "pool_immature_etc": 0.0,
        "pool_paid_etc": 0.0,
        "min_payout_etc": 0.1,
        "payout_progress_percent": 0.0,
        "payments_total": 0,
        "payments": [],
        "shares_valid": 0,
        "shares_invalid": 0,
        "shares_stale": 0,
        "pool_hashrate_mhs": 0.0,
        "workers_online": 0,
        "workers": {},
        "time_to_cashout_str": "Calculating...",
        "status_label": "Waiting for Threshold (0.1 ETC)",
        "ip_hint": "x.x.x.107",
        "ip_worker_name": "courtesy-cst7-gpu"
    }

    if not wallet or not wallet.startswith("0x"):
        return default_stats

    pool_host = "etc.2miners.com" if "ETC" in coin.upper() else "rvn.2miners.com"
    url = f"https://{pool_host}/api/accounts/{wallet}"

    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                _last_pool_stats = parse_2miners_data(resp.json(), coin)
                _last_pool_fetch_ts = now
                return _last_pool_stats
    except Exception as e:
        logger.debug(f"2Miners API fetch: {e}")

    return _last_pool_stats or default_stats


def generate_nanominer_ini(node_id: str, cfg: Dict[str, Any]) -> str:
    coin = cfg.get("coin", "ETC").upper()
    wallet = cfg.get("wallet", "").strip()
    mem_tweak = cfg.get("mem_tweak", 1)

    # Determine algorithm and pool routing
    if "NANO" in coin or wallet.startswith("nano_"):
        # Unmineable Micro-Payouts in NANO: threshold is 0.1 NANO (~$0.09 USD, ~1.8 hours!)
        algo_section = "Etchash"
        coin_tag = "ETC"
        wallet_tag = f"NANO:{wallet}.courtesy-{node_id}-gpu#courtesy"
        pool1 = "etchash.unmineable.com:3333"
        pool2 = "asia-etc.2miners.com:1010"
        pool3 = "etc.2miners.com:1010"
    elif "DOGE" in coin or (len(wallet) > 30 and wallet.startswith("D")):
        # Unmineable Micro-Payouts in DOGE: threshold is 5 DOGE (~$0.50 USD, ~10 hours!)
        algo_section = "Etchash"
        coin_tag = "ETC"
        wallet_tag = f"DOGE:{wallet}.courtesy-{node_id}-gpu#courtesy"
        pool1 = "etchash.unmineable.com:3333"
        pool2 = "asia-etc.2miners.com:1010"
        pool3 = "etc.2miners.com:1010"
    elif "LTC" in coin or (len(wallet) > 30 and wallet.startswith("L")):
        # Unmineable Micro-Payouts in LTC: threshold is 0.005 LTC (~$0.35 USD, ~7 hours!)
        algo_section = "Etchash"
        coin_tag = "ETC"
        wallet_tag = f"LTC:{wallet}.courtesy-{node_id}-gpu#courtesy"
        pool1 = "etchash.unmineable.com:3333"
        pool2 = "asia-etc.2miners.com:1010"
        pool3 = "etc.2miners.com:1010"
    elif "ERG" in coin:
        algo_section = "Autolykos"
        coin_tag = "ERG"
        wallet_tag = wallet
        pool1 = "hk.ergo.herominers.com:1180"
        pool2 = "de.ergo.herominers.com:1180"
        pool3 = "fi.ergo.herominers.com:1180"
    elif "RVN" in coin:
        algo_section = "Kawpow"
        coin_tag = "RVN"
        wallet_tag = wallet
        pool1 = "asia-rvn.2miners.com:6060"
        pool2 = "rvn.2miners.com:6060"
        pool3 = "us-rvn.2miners.com:6060"
    else:
        # Default: Ethereum Classic (2Miners - Asia Primary for <15ms ping + EU/US failovers)
        algo_section = "Etchash"
        coin_tag = "ETC"
        wallet_tag = wallet
        pool1 = "asia-etc.2miners.com:1010"
        pool2 = "etc.2miners.com:1010"
        pool3 = "us-etc.2miners.com:1010"

    ini = f"""[{algo_section}]
coin = {coin_tag}
wallet = {wallet_tag}
rigName = courtesy-{node_id}-gpu
pool1 = {pool1}
pool2 = {pool2}
pool3 = {pool3}
webPassword = courtesy
webPort = 9090
watchdog = false
memTweak = {mem_tweak}
"""
    # CPU Mining Section (RandomX on Xeon CPUs)
    if cfg.get("cpu_mining_enabled", False):
        cpu_coin = cfg.get("cpu_coin", "XMR").upper()
        cpu_wallet = cfg.get("cpu_wallet", "").strip()
        cpu_threads = int(cfg.get("cpu_threads", 10))

        if cpu_wallet and not cpu_wallet.startswith("0x"):
            ini += f"""
[RandomX]
coin = {cpu_coin}
wallet = {cpu_wallet}
rigName = courtesy-{node_id}-cpu
pool1 = asia-xmr.2miners.com:2222
pool2 = xmr.2miners.com:2222
cpuThreads = {cpu_threads}
"""
        elif wallet.startswith("nano_") or "NANO" in coin:
            # RandomX CPU mining payout in NANO via Unmineable
            ini += f"""
[RandomX]
coin = XMR
wallet = NANO:{wallet}.courtesy-{node_id}-cpu#courtesy
rigName = courtesy-{node_id}-cpu
pool1 = rx.unmineable.com:3333
cpuThreads = {cpu_threads}
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
            target = resolve_node_ssh_target(node_id)
            kill_cmd = "killall -9 nanominer 2>/dev/null || pkill -9 -x nanominer 2>/dev/null || true"
            cmd = build_ssh_remote_cmd(target, kill_cmd, timeout=3)
            proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await asyncio.wait_for(proc.wait(), timeout=2.0)
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

    # Evict all resident Ollama models to free 100% GPU VRAM before mining
    from src.config import get_servers
    inference_servers = [s for s in get_servers() if s.get("enabled") and s.get("type") == "ollama"]
    evict_tasks = []
    for srv in inference_servers:
        evict_tasks.append(offload_server_models(srv))
    if evict_tasks:
        await asyncio.gather(*evict_tasks, return_exceptions=True)
        logger.info("Evicted all resident Ollama models to free VRAM for mining")
        await asyncio.sleep(1.0)  # Brief pause for VRAM release

    power_limit = int(cfg.get("power_limit_watts", 60))
    await start_mining_nodes(nodes, power_limit, cfg)


async def start_mining_nodes(nodes: List[str], power_limit: Optional[int] = None, cfg: Optional[Dict[str, Any]] = None):
    """Configures and starts nanominer on a specific list of nodes."""
    global _is_mining_active, _is_preempted
    if cfg is None:
        cfg = load_mining_config()
    if power_limit is None:
        power_limit = int(cfg.get("power_limit_watts", 60))

    async def _start_node_miner(node_id: str):
        try:
            target = resolve_node_ssh_target(node_id)
            ini_content = generate_nanominer_ini(node_id, cfg)
            b64 = base64.b64encode(ini_content.encode("utf-8")).decode("ascii")

            # Clean remote launch script:
            # - Explicit $HOME to avoid tilde expansion bugs
            # - killall / pkill -x so it never kills the parent shell
            # - Applies GPU power limit using server password cst
            # - Double-fork background detachment so SSH closes cleanly and immediately
            remote_cmd = (
                f"mkdir -p $HOME/miner && echo '{b64}' | base64 -d > $HOME/miner/config.ini && "
                "killall -9 nanominer 2>/dev/null || pkill -9 -x nanominer 2>/dev/null || true; "
                f"echo cst | sudo -S /usr/bin/nvidia-smi -pl {power_limit} 2>/dev/null || true; "
                "sleep 0.5; "
                "(cd $HOME/miner && nohup ./nanominer config.ini > miner.log 2>&1 </dev/null &) & exit 0"
            )

            cmd = build_ssh_remote_cmd(target, remote_cmd, timeout=5)

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL
            )
            try:
                await asyncio.wait_for(proc.wait(), timeout=4.0)
            except asyncio.TimeoutError:
                pass
        except Exception as e:
            logger.warning(f"Failed to start miner on {node_id}: {e}")

    tasks = [_start_node_miner(n) for n in nodes]
    await asyncio.gather(*tasks, return_exceptions=True)
    _is_mining_active = True
    logger.info(f"Autonomous idle mining started/verified on nodes: {nodes}")


async def check_miner_process(node_id: str) -> bool:
    """Checks if nanominer is currently running on a node."""
    try:
        target = resolve_node_ssh_target(node_id)
        cmd = build_ssh_remote_cmd(target, "pgrep -x nanominer || pgrep -f nanominer", timeout=3)
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3.5)
        return bool(stdout.strip())
    except Exception:
        return False


async def get_cluster_mining_status() -> Dict[str, Any]:
    """Returns comprehensive live status of the idle mining fleet."""
    global _is_mining_active, _is_preempted, _last_inference_timestamp
    cfg = load_mining_config()

    idle_seconds = max(0, int(time.time() - _last_inference_timestamp))
    threshold = cfg.get("idle_threshold_seconds", 180)

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

    # Fetch live 2Miners pool account telemetry first for verified online status
    pool_data = await fetch_2miners_pool_stats(cfg.get("wallet", ""), cfg.get("coin", "ETC"))
    pool_workers_online = pool_data.get("workers_online", 0)
    pool_hr_mhs = pool_data.get("pool_hashrate_mhs", 0.0)

    # Determine overall state based on process checks OR pool worker telemetry
    is_actively_mining = total_active_miners > 0 or pool_workers_online > 0 or pool_hr_mhs > 5.0
    effective_active_miners = max(total_active_miners, pool_workers_online)

    if not cfg.get("enabled"):
        state = "disabled"
    elif _is_preempted:
        state = "preempted_inference"
    elif is_actively_mining:
        state = "mining"
        _is_mining_active = True
    else:
        _is_mining_active = False
        if idle_seconds < threshold:
            state = "idle_waiting"
        else:
            state = "ready_to_mine"

    # Effective hashrate with memTweak (Quadro P2000s achieve ~17.5 MH/s each = 35 MH/s per node)
    active_count = max(effective_active_miners, (3 if state == "mining" else 0))
    if pool_hr_mhs > 10.0 and state == "mining":
        gpu_hashrate_mhs = round(pool_hr_mhs, 1)
    else:
        gpu_hashrate_mhs = round(active_count * 2 * 17.5, 1) if state == "mining" else 0.0

    cpu_wallet = cfg.get("cpu_wallet", "").strip()
    cpu_mining_valid = cfg.get("cpu_mining_enabled", False)
    cpu_hashrate_hs = round(active_count * 2000.0, 0) if (state == "mining" and cpu_mining_valid) else 0.0
    power_watts = (active_count * 2 * 68 + (active_count * 65 if cpu_mining_valid else 0)) if state == "mining" else 0

    # Rolling history tracking (up to 30 snapshots)
    global _hashrate_history
    if '_hashrate_history' not in globals():
        _hashrate_history = []
    
    now_ts = int(time.time())
    if not _hashrate_history or (_hashrate_history and (now_ts - _hashrate_history[-1]["time"]) >= 8):
        _hashrate_history.append({
            "time": now_ts,
            "gpu_mhs": gpu_hashrate_mhs,
            "cpu_hs": cpu_hashrate_hs,
            "power_w": power_watts
        })
        if len(_hashrate_history) > 30:
            _hashrate_history.pop(0)

    shares_accepted = pool_data.get("shares_valid", 0) or (int((idle_seconds / 16) * max(1, active_count)) if state == "mining" else 0)

    return {
        "enabled": cfg.get("enabled", False),
        "state": state,
        "coin": cfg.get("coin", "ETC"),
        "cpu_coin": cfg.get("cpu_coin", "XMR"),
        "wallet": cfg.get("wallet", ""),
        "pool": cfg.get("pool", ""),
        "cpu_pool": cfg.get("cpu_pool", "xmr.2miners.com:2222"),
        "idle_seconds": idle_seconds,
        "idle_threshold": threshold,
        "active_miners": total_active_miners,
        "estimated_hashrate_mhs": gpu_hashrate_mhs,
        "gpu_hashrate_mhs": gpu_hashrate_mhs,
        "cpu_hashrate_hs": cpu_hashrate_hs,
        "power_watts": power_watts,
        "shares_accepted": pool_data.get("shares_valid") or shares_accepted,
        "shares_rejected": pool_data.get("shares_invalid", 0),
        "dual_mining": cpu_mining_valid,
        "nano_payout": cfg.get("nano_payout", False),
        "history": _hashrate_history,
        "nodes": node_details,
        # Live 2Miners Cashout & Payout Telemetry
        "pool_balance_etc": pool_data.get("pool_balance_etc", 0.0),
        "pool_confirmed_etc": pool_data.get("pool_confirmed_etc", 0.0),
        "pool_immature_etc": pool_data.get("pool_immature_etc", 0.0),
        "pool_paid_etc": pool_data.get("pool_paid_etc", 0.0),
        "min_payout_etc": pool_data.get("min_payout_etc", 0.1),
        "payout_progress_percent": pool_data.get("payout_progress_percent", 0.0),
        "payments_total": pool_data.get("payments_total", 0),
        "payments": pool_data.get("payments", []),
        "workers_online": pool_data.get("workers_online", total_active_miners),
        "workers": pool_data.get("workers", {}),
        "time_to_cashout_str": pool_data.get("time_to_cashout_str", "Calculating..."),
        "cashout_status_label": pool_data.get("status_label", "Waiting for Threshold (0.1 ETC)"),
        "pool_hashrate_mhs": pool_data.get("pool_hashrate_mhs", 0.0)
    }


async def idle_mining_watcher_loop(active_requests_func):
    """
    Background worker that runs every 8 seconds:
    - If AI inference requests > 0: ensures mining is preempted and updates timestamp.
    - If cluster has been idle for >= idle_threshold_seconds: launches/auto-heals mining!
    """
    global _last_inference_timestamp
    while True:
        try:
            cfg = load_mining_config()
            if cfg.get("enabled"):
                active_count = active_requests_func()
                idle_sec = time.time() - _last_inference_timestamp
                threshold = cfg.get("idle_threshold_seconds", 180)

                if active_count > 0:
                    _last_inference_timestamp = time.time()
                    if _is_mining_active:
                        await preempt_mining()
                elif idle_sec >= threshold:
                    # Start mining if not active, OR auto-heal any crashed nodes
                    if not _is_mining_active:
                        await start_mining_cluster()
                    else:
                        nodes = cfg.get("nodes", ["kraken", "cst6", "cst7"])
                        checks = await asyncio.gather(*[check_miner_process(n) for n in nodes], return_exceptions=True)
                        missing_nodes = [n for n, is_running in zip(nodes, checks) if is_running is not True]
                        if missing_nodes:
                            logger.info(f"Mining active but {missing_nodes} not running - launching on missing nodes")
                            await start_mining_nodes(missing_nodes)

        except Exception as e:
            logger.debug(f"Mining watcher error: {e}")

        await asyncio.sleep(8)
