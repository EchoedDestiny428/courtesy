"""
Courtesy Cluster Ownership & Reservation System
Manages node claiming, reservation status, and lightweight user PIN verification.
Persisted in config/ownership.json.
"""

import hashlib
import hmac
import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Dict, Any, Optional

logger = logging.getLogger("courtesy.ownership")

CONFIG_DIR = Path(__file__).parent.parent / "config"
OWNERSHIP_FILE = CONFIG_DIR / "ownership.json"

_lock = threading.Lock()
SALT = "courtesy_ownership_pin_salt_v1"


def _hash_pin(pin: str) -> str:
    return hashlib.sha256((SALT + str(pin).strip()).encode("utf-8")).hexdigest()


def _clean_username(raw: str) -> str:
    cleaned = re.sub(r"[^\w\s-]", "", raw).strip()
    if not cleaned or len(cleaned) < 2:
        raise ValueError("Username must be at least 2 characters.")
    if len(cleaned) > 24:
        cleaned = cleaned[:24].strip()
    return cleaned


def _clean_pin(raw: str) -> str:
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) != 4:
        raise ValueError("PIN must be exactly 4 digits.")
    return digits


def load_ownership_data() -> Dict[str, Any]:
    """Thread-safe load of ownership records."""
    with _lock:
        if not OWNERSHIP_FILE.exists():
            return {"servers": {}, "users": {}}
        try:
            with open(OWNERSHIP_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if not isinstance(data, dict):
                    data = {}
                data.setdefault("servers", {})
                data.setdefault("users", {})
                return data
        except Exception as e:
            logger.error(f"Error loading ownership data: {e}")
            return {"servers": {}, "users": {}}


def save_ownership_data(data: Dict[str, Any]) -> None:
    """Thread-safe persistence of ownership records."""
    with _lock:
        try:
            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            temp_file = OWNERSHIP_FILE.with_suffix(".tmp")
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(temp_file, OWNERSHIP_FILE)
        except Exception as e:
            logger.error(f"Error saving ownership data: {e}")


def get_all_ownership() -> Dict[str, Dict[str, Any]]:
    """Returns a public view of server ownership (no PIN hashes exposed)."""
    data = load_ownership_data()
    servers = data.get("servers", {})
    result = {}
    now = time.time()

    for server_id, record in servers.items():
        if record and record.get("owner"):
            result[server_id] = {
                "server_id": server_id,
                "is_claimed": True,
                "owner": record.get("owner"),
                "claimed_at": record.get("claimed_at"),
                "last_active": record.get("last_active", record.get("claimed_at")),
                "active_mins_ago": max(0, int((now - record.get("last_active", record.get("claimed_at", now))) / 60))
            }
        else:
            result[server_id] = {
                "server_id": server_id,
                "is_claimed": False,
                "owner": None,
                "claimed_at": None,
                "last_active": None,
                "active_mins_ago": None
            }
    return result


def get_server_ownership(server_id: str) -> Dict[str, Any]:
    """Returns public ownership status for a single server."""
    all_map = get_all_ownership()
    return all_map.get(server_id, {
        "server_id": server_id,
        "is_claimed": False,
        "owner": None,
        "claimed_at": None,
        "last_active": None,
        "active_mins_ago": None
    })


def verify_or_register_user(raw_username: str, raw_pin: str) -> Dict[str, Any]:
    """
    Verifies user's 4-digit PIN, or registers them on first appearance.
    Raises ValueError on validation failure or incorrect PIN.
    """
    username = _clean_username(raw_username)
    pin = _clean_pin(raw_pin)
    pin_hash = _hash_pin(pin)

    data = load_ownership_data()
    users = data.setdefault("users", {})

    if username in users:
        expected_hash = users[username].get("pin_hash")
        if not hmac.compare_digest(expected_hash, pin_hash):
            raise ValueError(f"Incorrect 4-digit PIN for user '{username}'.")
        return {"username": username, "status": "verified"}
    else:
        # Register new user
        users[username] = {
            "pin_hash": pin_hash,
            "created_at": time.time()
        }
        save_ownership_data(data)
        logger.info(f"Registered new user '{username}' in ownership system.")
        return {"username": username, "status": "registered"}


def claim_server(server_id: str, raw_username: str, raw_pin: str) -> Dict[str, Any]:
    """
    Claims server for username after verifying PIN.
    If server is already owned by someone else, returns failure.
    """
    auth = verify_or_register_user(raw_username, raw_pin)
    username = auth["username"]

    data = load_ownership_data()
    servers = data.setdefault("servers", {})
    existing = servers.get(server_id)

    now = time.time()
    if existing and existing.get("owner") and existing.get("owner").lower() != username.lower():
        return {
            "success": False,
            "error": f"Node '{server_id}' is currently reserved by '{existing.get('owner')}'.",
            "current_owner": existing.get("owner")
        }

    # Claim or refresh
    servers[server_id] = {
        "owner": username,
        "claimed_at": existing.get("claimed_at", now) if (existing and existing.get("owner") == username) else now,
        "last_active": now
    }
    save_ownership_data(data)
    logger.info(f"Server '{server_id}' claimed by '{username}'.")

    return {
        "success": True,
        "server_id": server_id,
        "owner": username,
        "claimed_at": servers[server_id]["claimed_at"],
        "last_active": now
    }


def release_server(server_id: str, raw_username: str = "", raw_pin: Optional[str] = None, force: bool = False) -> Dict[str, Any]:
    """
    Releases ownership of a server.
    If force is True, admin override bypasses username/PIN check.
    """
    data = load_ownership_data()
    servers = data.setdefault("servers", {})
    existing = servers.get(server_id)

    if not existing or not existing.get("owner"):
        return {"success": True, "server_id": server_id, "message": "Server is already unreserved."}

    owner = existing.get("owner")

    if not force:
        username = _clean_username(raw_username)
        if owner.lower() != username.lower():
            return {
                "success": False,
                "error": f"Cannot release: server is owned by '{owner}', not '{username}'."
            }
        if raw_pin is not None:
            verify_or_register_user(username, raw_pin)

    servers[server_id] = None
    save_ownership_data(data)
    logger.info(f"Server '{server_id}' released (was owned by '{owner}'). Force={force}")

    return {
        "success": True,
        "server_id": server_id,
        "previous_owner": owner,
        "message": f"Node '{server_id}' is now available."
    }


def touch_activity(server_id: str, raw_username: str) -> None:
    """Updates the last_active timestamp for an active user session."""
    try:
        username = _clean_username(raw_username)
        data = load_ownership_data()
        servers = data.setdefault("servers", {})
        existing = servers.get(server_id)
        if existing and existing.get("owner", "").lower() == username.lower():
            existing["last_active"] = time.time()
            save_ownership_data(data)
    except Exception:
        pass
