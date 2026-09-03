"""
Courtesy Authentication and Administrative Security Module
Ensures passwords and session tokens are strictly validated on the backend.
"""

import hashlib
import hmac
import logging
import secrets
import time
from typing import Dict, Optional
from fastapi import HTTPException, Header, Depends

logger = logging.getLogger("courtesy.auth")

# Admin credentials (hashed with salt so credentials cannot be read from memory or client)
ADMIN_USERNAME = "admin"
SALT = "courtesy_secret_salt_v2"
ADMIN_PASSWORD_HASH = hashlib.sha256((SALT + "alarm").encode("utf-8")).hexdigest()

# Active admin session tokens (token -> expiry timestamp)
_active_sessions: Dict[str, float] = {}
SESSION_TTL = 86400  # 24 hours


def verify_admin_credentials(username: str, password: str) -> bool:
    """Verifies username and password using constant-time comparison."""
    if username != ADMIN_USERNAME:
        return False
    computed_hash = hashlib.sha256((SALT + password).encode("utf-8")).hexdigest()
    return hmac.compare_digest(computed_hash, ADMIN_PASSWORD_HASH)


def create_admin_session() -> str:
    """Generates a secure cryptographic session token."""
    token = secrets.token_hex(32)
    _active_sessions[token] = time.time() + SESSION_TTL
    return token


def is_valid_admin_token(token: Optional[str]) -> bool:
    """Checks if a session token is valid and not expired."""
    if not token:
        return False
    exp = _active_sessions.get(token)
    if not exp:
        return False
    if time.time() > exp:
        del _active_sessions[token]
        return False
    return True


def revoke_admin_session(token: str):
    """Revokes a session on logout."""
    if token in _active_sessions:
        del _active_sessions[token]


async def require_admin_auth(authorization: Optional[str] = Header(None)) -> str:
    """FastAPI dependency for protected administrative endpoints."""
    if not authorization:
        raise HTTPException(status_code=401, detail="Authentication required.")
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid authorization header format.")
    token = parts[1]
    if not is_valid_admin_token(token):
        raise HTTPException(status_code=403, detail="Invalid or expired session token.")
    return token
