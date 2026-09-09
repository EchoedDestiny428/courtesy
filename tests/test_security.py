"""
Courtesy Security & Hardening Test Suite
Tests brute-force defense, rate limiting, path traversal sandboxing, and auth boundaries.
"""

import os
import pytest
from pathlib import Path
from fastapi import HTTPException
from fastapi.testclient import TestClient

from src.auth import (
    RateLimiter,
    verify_admin_credentials,
    create_admin_session,
    is_valid_admin_token,
    check_admin_brute_force,
    record_admin_login_failure,
    reset_admin_login_failures,
    check_pin_brute_force,
    record_pin_failure,
    reset_pin_failures,
)
from src.security import get_safe_workspace_path
from src.ownership import verify_or_register_user
from src.app import app


client = TestClient(app)


def test_rate_limiter_sliding_window():
    """Verify that rate limiter enforces request limits per window."""
    limiter = RateLimiter()
    key = "test_ip:1.2.3.4"

    # Should allow 5 requests
    for _ in range(5):
        is_limited, _ = limiter.check_rate_limit(key, max_requests=5, window_seconds=10)
        assert not is_limited

    # 6th request should be limited
    is_limited, retry_after = limiter.check_rate_limit(key, max_requests=5, window_seconds=10)
    assert is_limited
    assert retry_after > 0


def test_admin_brute_force_lockout():
    """Verify that 5 failed admin logins trigger a 429 lockout."""
    ip = "192.168.1.99"
    user = "malicious_actor"

    # Reset any previous failures
    reset_admin_login_failures(ip, user)

    # First 4 failures do not lock out
    for _ in range(4):
        record_admin_login_failure(ip, user)

    # 5th failure triggers lockout
    with pytest.raises(HTTPException) as exc_info:
        record_admin_login_failure(ip, user)
    assert exc_info.value.status_code == 429
    assert "Too many failed login attempts" in exc_info.value.detail

    # Subsequent check immediately raises 429
    with pytest.raises(HTTPException) as exc_info2:
        check_admin_brute_force(ip, user)
    assert exc_info2.value.status_code == 429

    # Cleanup
    reset_admin_login_failures(ip, user)


def test_pin_brute_force_lockout():
    """Verify that 5 failed 4-digit PIN attempts trigger a 429 lockout."""
    ip = "192.168.1.100"
    user = "test_pin_user"

    # First register user with valid PIN
    verify_or_register_user(user, "1234", client_ip=ip)
    reset_pin_failures(ip, user)

    # 4 incorrect PIN attempts
    for _ in range(4):
        with pytest.raises(ValueError):
            verify_or_register_user(user, "9999", client_ip=ip)

    # 5th incorrect attempt raises 429 (lockout)
    with pytest.raises(HTTPException) as exc_info:
        verify_or_register_user(user, "9999", client_ip=ip)
    assert exc_info.value.status_code == 429
    assert "Too many failed PIN attempts" in exc_info.value.detail

    # Cleanup
    reset_pin_failures(ip, user)


def test_path_traversal_blocking():
    """Verify that path traversal attempts outside workspace are strictly rejected."""
    workspace = Path(os.getcwd()).resolve()

    # Legitimate path
    safe = get_safe_workspace_path("README.md", str(workspace))
    assert safe == (workspace / "README.md").resolve()

    # Traversal escape
    with pytest.raises(HTTPException) as exc_info:
        get_safe_workspace_path("../../../etc/passwd", str(workspace))
    assert exc_info.value.status_code in (400, 403)

    # Sensitive Linux paths
    with pytest.raises(HTTPException) as exc_info2:
        get_safe_workspace_path("/etc/shadow", str(workspace))
    assert exc_info2.value.status_code == 403

    # Sensitive files (.ssh, id_rsa, .env)
    with pytest.raises(HTTPException) as exc_info3:
        get_safe_workspace_path(".ssh/id_rsa", str(workspace))
    assert exc_info3.value.status_code == 403


def test_unauthenticated_server_mutation_rejected():
    """Verify that server mutation endpoints require valid admin token."""
    # Adding server without token
    res = client.post("/api/servers", json={"id": "rogue", "name": "Rogue Node"})
    assert res.status_code in (401, 403)

    # Toggling server without token
    res_toggle = client.post("/api/servers/cst1/toggle")
    assert res_toggle.status_code in (401, 403)

    # Deleting server without token
    res_del = client.delete("/api/servers/cst1")
    assert res_del.status_code in (401, 403)

    # Cluster offload without token
    res_offload = client.post("/api/cluster/offload")
    assert res_offload.status_code in (401, 403)


def test_security_headers_present():
    """Verify that HTTP security headers are injected into API responses."""
    res = client.get("/api/cluster")
    assert res.status_code == 200
    assert res.headers.get("X-Content-Type-Options") == "nosniff"
    assert res.headers.get("X-Frame-Options") == "SAMEORIGIN"
    assert res.headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"
    assert res.headers.get("X-XSS-Protection") == "1; mode=block"


def test_admin_login_flow():
    """Verify that valid admin credentials return a session token and invalid ones fail."""
    # Invalid password
    res_bad = client.post("/api/auth/login", json={"username": "admin", "password": "wrong_password_123"})
    assert res_bad.status_code == 401

    # Valid default password (cst)
    res_ok = client.post("/api/auth/login", json={"username": "admin", "password": "cst"})
    assert res_ok.status_code == 200
    data = res_ok.json()
    assert data.get("status") == "success"
    assert "token" in data

    token = data["token"]
    assert is_valid_admin_token(token)


def test_workspace_exec_auth():
    """Verify that workspace exec requires valid credentials and succeeds when authenticated."""
    # Unauthenticated should fail with 401
    res_unauth = client.post("/api/workspace/exec", json={"command": "echo test"})
    assert res_unauth.status_code == 401

    # Authenticated with admin token should succeed
    admin_token = create_admin_session()
    res_auth = client.post(
        "/api/workspace/exec",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"command": "echo hello_security"}
    )
    assert res_auth.status_code == 200
    out = res_auth.json()
    assert out.get("exit_code") == 0
    assert "hello_security" in out.get("stdout", "")


def test_terminal_exec_auth():
    """Verify that terminal exec requires valid credentials."""
    res = client.post("/api/terminal/exec", json={"command": "echo test", "server_id": "cst"})
    assert res.status_code == 401


def test_terminal_websocket_unauthenticated_rejected():
    """Verify that WebSocket terminal rejects unauthenticated connections."""
    with client.websocket_connect("/ws/terminal/cst1") as websocket:
        data = websocket.receive_bytes()
        assert b"Terminal access denied" in data

