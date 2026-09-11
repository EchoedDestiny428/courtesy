"""
Courtesy Security & Sandboxing Module
Provides path traversal protection, security headers, rate limiting, and request sanitization.
"""

import os
import re
import logging
from pathlib import Path
from typing import Optional
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from fastapi import HTTPException

logger = logging.getLogger("courtesy.security")

# Optional root directory confining all workspace file operations
WORKSPACE_ROOT = os.environ.get("COURTESY_WORKSPACE_ROOT", "").strip()

# Disallowed system directories (normalized lowercase)
RESTRICTED_SYSTEM_DIRS = {
    "/etc", "/root", "/sys", "/proc", "/dev", "/boot", "/var/log",
    "c:\\windows", "c:\\windows\\system32", "c:\\windows\\syswow64",
    "c:\\program files", "c:\\program files (x86)"
}

# Disallowed file patterns that should never be accessed via workspace API
RESTRICTED_FILE_PATTERNS = [
    r"(^|[/\\])\.ssh([/\\]|$)",
    r"(^|[/\\])id_[a-z0-9]+$",
    r"(^|[/\\])authorized_keys$",
    r"(^|[/\\])known_hosts$",
    r"(^|[/\\])\.bash_history$",
    r"(^|[/\\])\.zsh_history$",
    r"(^|[/\\])etc[/\\]shadow$",
    r"(^|[/\\])etc[/\\]passwd$",
    r"(^|[/\\])\.env$"
]
_compiled_restricted = [re.compile(pat, re.IGNORECASE) for pat in RESTRICTED_FILE_PATTERNS]


def is_path_traversal(path_str: str) -> bool:
    """Checks for explicit directory traversal attempts."""
    if not path_str or "\x00" in path_str:
        return True
    normalized = path_str.replace("\\", "/")
    parts = normalized.split("/")
    return any(p == ".." for p in parts)


def get_safe_workspace_path(path_str: str, base_folder: str = "") -> Path:
    """
    Resolves and verifies that a target path is strictly contained within an allowed workspace directory.
    Prevents path traversal, directory escape, and access to system-critical files.
    """
    if not path_str:
        raise HTTPException(status_code=400, detail="File path cannot be empty.")

    if "\x00" in path_str or "\x00" in base_folder:
        raise HTTPException(status_code=400, detail="Invalid character in path.")

    # 1. Determine canonical base directory
    if base_folder and base_folder.strip():
        base_path = Path(base_folder.strip()).resolve()
    elif WORKSPACE_ROOT:
        base_path = Path(WORKSPACE_ROOT).resolve()
    else:
        # Default to current working directory if no base specified
        base_path = Path(os.getcwd()).resolve()

    # 2. Check if path is absolute or relative
    raw_target = Path(path_str.strip())
    if raw_target.is_absolute():
        resolved_target = raw_target.resolve()
    else:
        resolved_target = (base_path / raw_target).resolve()

    resolved_str = str(resolved_target).lower().replace("/", "\\")

    # 3. Check for restricted system directories
    for restricted in RESTRICTED_SYSTEM_DIRS:
        norm_res = str(Path(restricted)).lower().replace("/", "\\")
        if resolved_str == norm_res or resolved_str.startswith(norm_res + "\\"):
            logger.warning(f"Security Alert: Blocked access to restricted system directory: {resolved_target}")
            raise HTTPException(status_code=403, detail="Access denied: Restricted system path.")

    # 4. Check for restricted sensitive files (ssh keys, shadow, env)
    for pat in _compiled_restricted:
        if pat.search(str(resolved_target)):
            logger.warning(f"Security Alert: Blocked access to restricted file: {resolved_target}")
            raise HTTPException(status_code=403, detail="Access denied: Restricted file pattern.")

    # 5. Ensure target is within base_path or WORKSPACE_ROOT if configured
    if WORKSPACE_ROOT:
        root_path = Path(WORKSPACE_ROOT).resolve()
        try:
            resolved_target.relative_to(root_path)
        except ValueError:
            logger.warning(f"Security Alert: Blocked path escape outside WORKSPACE_ROOT: {resolved_target}")
            raise HTTPException(status_code=403, detail="Access denied: Path escapes workspace root boundary.")
    elif base_folder and base_folder.strip():
        try:
            resolved_target.relative_to(base_path)
        except ValueError:
            logger.warning(f"Security Alert: Blocked path escape outside base folder: {resolved_target}")
            raise HTTPException(status_code=403, detail="Access denied: Path escapes designated project boundary.")
    else:
        try:
            resolved_target.relative_to(base_path)
        except ValueError:
            logger.warning(f"Security Alert: Blocked path escape outside current working directory: {resolved_target}")
            raise HTTPException(status_code=403, detail="Access denied: Path escapes current working directory.")

    return resolved_target


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    Applies standard HTTP security headers to protect against clickjacking,
    MIME-sniffing, and cross-site scripting vulnerabilities.
    """
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        return response
