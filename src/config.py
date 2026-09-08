import json
import os
import threading
from pathlib import Path
from typing import Dict, Any, List, Optional

CONFIG_DIR = Path(__file__).parent.parent / "config"
CONFIG_FILE = CONFIG_DIR / "servers.json"

_lock = threading.Lock()

DEFAULT_CONFIG: Dict[str, Any] = {
    "gateway": {
        "id": "cst",
        "name": "Raspberry Pi Gateway",
        "host": "cst",
        "tailscale_ip": "100.107.249.92",
        "user": "cst",
        "role": "gateway",
        "specs": "Raspberry Pi 4 • Cortex-A72 • 8GB RAM"
    },
    "servers": [
        {
            "id": "cst",
            "name": "cst (Gateway Node)",
            "role": "gateway",
            "type": "system_only",
            "host": "127.0.0.1",
            "port": 22,
            "ssh_host": "cst",
            "ssh_user": "cst",
            "enabled": True,
            "specs": {
                "cpu": "Cortex-A72 (4 Cores)",
                "ram": "8 GB",
                "gpus": []
            },
            "tags": ["gateway", "tailscale", "arm64"]
        },
        {
            "id": "cst1",
            "name": "cst1 (Node 1)",
            "role": "inference",
            "type": "ollama",
            "host": "cst1.local",
            "ip": "10.11.16.36",
            "port": 11434,
            "ssh_host": "cst1.local",
            "ssh_user": "cst1",
            "enabled": True,
            "preferred_model": "qwen2.5-coder:7b",
            "specs": {
                "cpu": "Intel Core i7-8086K (12 Cores)",
                "ram": "32 GB",
                "gpus": [
                    {"index": 0, "name": "NVIDIA Quadro P2000", "vram_total_mb": 5120},
                    {"index": 1, "name": "NVIDIA Quadro P2000", "vram_total_mb": 5120}
                ]
            },
            "tags": ["compute", "gpu", "dual-p2000", "7b", "14b"]
        },
        {
            "id": "cst5",
            "name": "cst5 (Node 5)",
            "role": "inference",
            "type": "ollama",
            "host": "cst5.local",
            "ip": "10.11.2.22",
            "port": 11434,
            "ssh_host": "cst5.local",
            "ssh_user": "cst5",
            "enabled": True,
            "preferred_model": "qwen2.5-coder:7b",
            "specs": {
                "cpu": "Intel Core i7-8086K (12 Cores)",
                "ram": "32 GB",
                "gpus": [
                    {"index": 0, "name": "NVIDIA Quadro P2000", "vram_total_mb": 5120},
                    {"index": 1, "name": "NVIDIA Quadro P2000", "vram_total_mb": 5120}
                ]
            },
            "tags": ["compute", "gpu", "dual-p2000", "7b", "14b"]
        },
        {
            "id": "cst6",
            "name": "cst6 (Inference Node 2)",
            "role": "inference",
            "type": "ollama",
            "host": "cst6.local",
            "ip": "10.11.16.29",
            "port": 11434,
            "ssh_host": "cst6.local",
            "ssh_user": "cst6",
            "enabled": True,
            "preferred_model": "qwen2.5-coder:7b",
            "specs": {
                "cpu": "Intel Core i7-8086K (12 Cores)",
                "ram": "32 GB",
                "gpus": [
                    {"index": 0, "name": "NVIDIA Quadro P2000", "vram_total_mb": 5120},
                    {"index": 1, "name": "NVIDIA Quadro P2000", "vram_total_mb": 5120}
                ]
            },
            "tags": ["compute", "gpu", "dual-p2000", "7b", "14b"]
        },
        {
            "id": "cst7",
            "name": "cst7 (Heavy Node 3)",
            "role": "inference",
            "type": "ollama",
            "host": "cst7.local",
            "ip": "10.11.2.12",
            "port": 11434,
            "ssh_host": "cst7.local",
            "ssh_user": "cst7",
            "enabled": True,
            "preferred_model": "qwen2.5-coder:14b",
            "specs": {
                "cpu": "Intel Core i7-8086K (12 Cores)",
                "ram": "32 GB",
                "gpus": [
                    {"index": 0, "name": "NVIDIA Quadro P2000", "vram_total_mb": 5120},
                    {"index": 1, "name": "NVIDIA Quadro P2000", "vram_total_mb": 5120}
                ]
            },
            "tags": ["compute", "gpu", "dual-p2000", "heavy-reasoning", "7b", "14b"]
        }
    ],
    "routing": {
        "default_strategy": "auto",
        "fallback_enabled": True,
        "timeout_seconds": 120
    },
    "settings": {
        "poll_interval_seconds": 4,
        "temperature_default": 0.2,
        "max_tokens_default": 4096,
        "system_prompt_default": "You are Courtesy Codex, a world-class autonomous AI coding assistant. You write production-ready, clean, well-tested, robust code. Follow modern best practices, handle edge cases, and provide concise, insightful explanations."
    }
}


def load_config() -> Dict[str, Any]:
    """Loads configuration from JSON file, creating default if missing."""
    with _lock:
        if not CONFIG_FILE.exists():
            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(DEFAULT_CONFIG, f, indent=2)
            return DEFAULT_CONFIG.copy()
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return DEFAULT_CONFIG.copy()


def save_config(config: Dict[str, Any]) -> None:
    """Atomically saves configuration to JSON file."""
    with _lock:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        tmp_file = CONFIG_FILE.with_suffix(".tmp")
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2)
        os.replace(tmp_file, CONFIG_FILE)


def get_servers() -> List[Dict[str, Any]]:
    config = load_config()
    return config.get("servers", [])


def get_server_by_id(server_id: str) -> Optional[Dict[str, Any]]:
    for s in get_servers():
        if s.get("id") == server_id:
            return s
    return None


def add_server(server_data: Dict[str, Any]) -> Dict[str, Any]:
    """Modular addition of a new server."""
    config = load_config()
    servers = config.get("servers", [])
    
    # Check if id already exists
    server_id = server_data.get("id", "").strip().lower()
    if not server_id:
        server_id = f"node-{len(servers) + 1}"
        server_data["id"] = server_id
        
    for idx, s in enumerate(servers):
        if s.get("id") == server_id:
            servers[idx] = server_data
            config["servers"] = servers
            save_config(config)
            return server_data

    servers.append(server_data)
    config["servers"] = servers
    save_config(config)
    return server_data


def update_server(server_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Update fields on an existing server."""
    config = load_config()
    servers = config.get("servers", [])
    for idx, s in enumerate(servers):
        if s.get("id") == server_id:
            s.update(updates)
            servers[idx] = s
            config["servers"] = servers
            save_config(config)
            return s
    return None


def delete_server(server_id: str) -> bool:
    """Delete a server from the modular registry."""
    config = load_config()
    servers = config.get("servers", [])
    initial_len = len(servers)
    new_servers = [s for s in servers if s.get("id") != server_id]
    if len(new_servers) < initial_len:
        config["servers"] = new_servers
        save_config(config)
        return True
    return False


def get_routing_settings() -> Dict[str, Any]:
    config = load_config()
    return config.get("routing", {})


def get_general_settings() -> Dict[str, Any]:
    config = load_config()
    return config.get("settings", {})
