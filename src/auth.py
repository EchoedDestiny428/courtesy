"""
Courtesy Authentication, Rate Limiting, and Brute-Force Protection Module
Ensures passwords, PINs, and session tokens are strictly validated with sliding-window
rate limiting, failure tracking, and automatic temporary lockouts.
"""

import collections
import hashlib
import hmac
import logging
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Dict, Optional, Tuple
from fastapi import HTTPException, Header, Request

logger = logging.getLogger("courtesy.auth")

# Auto-load .env file if present in project root
_ENV_FILE = Path(__file__).parent.parent / ".env"
if _ENV_FILE.exists():
    try:
        from dotenv import load_dotenv
        load_dotenv(_ENV_FILE)
    except ImportError:
        try:
            with open(_ENV_FILE, "r", encoding="utf-8") as _f:
                for _line in _f:
                    _line = _line.strip()
                    if _line and not _line.startswith("#") and "=" in _line:
                        _k, _v = _line.split("=", 1)
                        _k, _v = _k.strip(), _v.strip()
                        if _k and _k not in os.environ:
                            os.environ[_k] = _v.strip("'\"")
        except Exception:
            pass

# Admin credentials - configurable via environment variable
ADMIN_USERNAME = os.environ.get("COURTESY_ADMIN_USER", "admin")
DEFAULT_ADMIN_PASS = os.environ.get("COURTESY_ADMIN_PASSWORD", "cst")
SALT = os.environ.get("COURTESY_SALT", "courtesy_secret_salt_v2")
ADMIN_PASSWORD_HASH = hashlib.sha256((SALT + DEFAULT_ADMIN_PASS).encode("utf-8")).hexdigest()

# Active admin session tokens (token -> expiry timestamp)
_active_sessions: Dict[str, float] = {}
SESSION_TTL = 86400  # 24 hours


class RateLimiter:
    """
    Thread-safe, sliding-window rate limiter with brute-force lockout support.
    Tracks requests and failures per key (IP, username, or endpoint).
    """
    def __init__(self):
        self._lock = threading.Lock()
        self._attempts: Dict[str, collections.deque] = {}
        self._lockouts: Dict[str, float] = {}

    def is_locked(self, key: str) -> Tuple[bool, int]:
        """Checks if a key is currently locked out. Returns (is_locked, remaining_seconds)."""
        with self._lock:
            exp = self._lockouts.get(key)
            if not exp:
                return False, 0
            now = time.time()
            if now < exp:
                return True, max(1, int(exp - now))
            # Lockout has expired; clean up
            del self._lockouts[key]
            return False, 0

    def record_failure(
        self,
        key: str,
        max_failures: int = 5,
        window_seconds: int = 600,
        lockout_seconds: int = 900
    ) -> Tuple[bool, int]:
        """
        Records a failed attempt. If failures within window reach max_failures,
        places the key in lockout for lockout_seconds.
        Returns (is_locked, lockout_or_remaining_seconds).
        """
        now = time.time()
        with self._lock:
            if key in self._lockouts:
                if now < self._lockouts[key]:
                    return True, max(1, int(self._lockouts[key] - now))
                del self._lockouts[key]

            if key not in self._attempts:
                self._attempts[key] = collections.deque()

            dq = self._attempts[key]
            cutoff = now - window_seconds
            while dq and dq[0] < cutoff:
                dq.popleft()

            dq.append(now)

            if len(dq) >= max_failures:
                lockout_until = now + lockout_seconds
                self._lockouts[key] = lockout_until
                dq.clear()
                logger.warning(f"Security Alert: Brute force threshold exceeded for '{key}'. Locked for {lockout_seconds}s.")
                return True, lockout_seconds

            return False, 0

    def reset_failures(self, key: str) -> None:
        """Clears failures and removes lockout for key upon successful authentication."""
        with self._lock:
            self._attempts.pop(key, None)
            self._lockouts.pop(key, None)

    def check_rate_limit(
        self,
        key: str,
        max_requests: int = 120,
        window_seconds: int = 60
    ) -> Tuple[bool, int]:
        """
        Sliding-window request rate limiter.
        Returns (is_limited, retry_after_seconds).
        """
        now = time.time()
        with self._lock:
            if key not in self._attempts:
                self._attempts[key] = collections.deque()

            dq = self._attempts[key]
            cutoff = now - window_seconds
            while dq and dq[0] < cutoff:
                dq.popleft()

            if len(dq) >= max_requests:
                oldest = dq[0]
                retry_after = max(1, int(oldest + window_seconds - now))
                return True, retry_after

            dq.append(now)
            return False, 0


# Global singleton rate limiter
rate_limiter = RateLimiter()


def get_client_ip(request: Request) -> str:
    """Extracts client IP safely from request headers or socket."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        if parts:
            return parts[0]
    real_ip = request.headers.get("X-Real-IP")
    if real_ip:
        return real_ip.strip()
    if request.client and request.client.host:
        return request.client.host
    return "127.0.0.1"


def verify_admin_credentials(username: str, password: str) -> bool:
    """Verifies admin credentials using constant-time comparison."""
    valid_users = {ADMIN_USERNAME.lower()}
    if username.lower() not in valid_users:
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


def check_admin_brute_force(ip: str, username: str):
    """Checks if IP or username is locked out for admin login."""
    is_locked_ip, rem_ip = rate_limiter.is_locked(f"admin_ip:{ip}")
    if is_locked_ip:
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed login attempts from this IP. Locked out for {rem_ip}s."
        )
    is_locked_u, rem_u = rate_limiter.is_locked(f"admin_user:{username.lower()}")
    if is_locked_u:
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed login attempts for account '{username}'. Locked out for {rem_u}s."
        )


def record_admin_login_failure(ip: str, username: str):
    """Records failed admin login and raises 429 if lockout triggered."""
    locked_ip, rem_ip = rate_limiter.record_failure(f"admin_ip:{ip}", max_failures=5, window_seconds=600, lockout_seconds=900)
    locked_u, rem_u = rate_limiter.record_failure(f"admin_user:{username.lower()}", max_failures=5, window_seconds=600, lockout_seconds=900)
    if locked_ip or locked_u:
        rem = max(rem_ip, rem_u)
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed login attempts. Temporarily locked out for {rem}s."
        )


def reset_admin_login_failures(ip: str, username: str):
    """Resets failures after successful login."""
    rate_limiter.reset_failures(f"admin_ip:{ip}")
    rate_limiter.reset_failures(f"admin_user:{username.lower()}")


def check_pin_brute_force(ip: str, username: str):
    """Checks if IP or user is locked out for PIN verification."""
    is_locked_ip, rem_ip = rate_limiter.is_locked(f"pin_ip:{ip}")
    if is_locked_ip:
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed PIN attempts from this IP. Locked out for {rem_ip}s."
        )
    is_locked_u, rem_u = rate_limiter.is_locked(f"pin_user:{username.lower()}")
    if is_locked_u:
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed PIN attempts for '{username}'. Locked out for {rem_u}s."
        )


def record_pin_failure(ip: str, username: str):
    """Records failed PIN attempt and triggers lockout if threshold reached."""
    locked_ip, rem_ip = rate_limiter.record_failure(f"pin_ip:{ip}", max_failures=5, window_seconds=600, lockout_seconds=900)
    locked_u, rem_u = rate_limiter.record_failure(f"pin_user:{username.lower()}", max_failures=5, window_seconds=600, lockout_seconds=900)
    if locked_ip or locked_u:
        rem = max(rem_ip, rem_u)
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed PIN attempts. Temporarily locked out for {rem}s."
        )


def reset_pin_failures(ip: str, username: str):
    """Resets PIN failures after valid verification."""
    rate_limiter.reset_failures(f"pin_ip:{ip}")
    rate_limiter.reset_failures(f"pin_user:{username.lower()}")
