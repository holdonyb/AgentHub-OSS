from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[3]
API_ROOT = ROOT / "apps" / "api"
sys.path.insert(0, str(API_ROOT))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "packages" / "protocol"))
sys.path.insert(0, str(ROOT / "workers" / "shared"))
sys.path.insert(0, str(ROOT / "workers" / "local-windows"))
sys.path.insert(0, str(ROOT / "workers" / "local-linux"))


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    db_path = tmp_path / "agenthub-test.db"
    monkeypatch.setenv("AGENTHUB_DATABASE_URL", f"sqlite+pysqlite:///{db_path.as_posix()}")
    monkeypatch.setenv("AGENTHUB_BOOTSTRAP_TOKEN", "bootstrap-test-token")
    monkeypatch.setenv("AGENTHUB_WORKER_REGISTRATION_TOKEN", "worker-register-test-token")
    monkeypatch.setenv("AGENTHUB_COOKIE_SECURE", "false")
    monkeypatch.setenv("AGENTHUB_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv("AGENTHUB_LOGIN_RATE_LIMIT_COUNT", "3")
    monkeypatch.setenv("AGENTHUB_LOGIN_RATE_LIMIT_WINDOW_SECONDS", "60")

    from app.core.database import reset_database
    from app.main import create_app

    app = create_app()
    reset_database(app.state.db_engine)
    with TestClient(app) as test_client:
        yield test_client


def bootstrap_owner(client: TestClient, email: str = "owner@example.com") -> dict[str, Any]:
    response = client.post(
        "/api/auth/bootstrap",
        json={
            "bootstrap_token": "bootstrap-test-token",
            "email": email,
            "password": "Correct Horse Battery Staple 42",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def login(client: TestClient, email: str = "owner@example.com") -> dict[str, Any]:
    response = client.post(
        "/api/auth/login",
        json={"email": email, "password": "Correct Horse Battery Staple 42"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def auth_headers(auth_response: dict[str, Any]) -> dict[str, str]:
    headers = {"X-CSRF-Token": auth_response["csrf_token"]}
    space = auth_response.get("space")
    if isinstance(space, dict) and space.get("space_id"):
        headers["X-AgentHub-Space"] = str(space["space_id"])
    return headers


def create_worker(client: TestClient, worker_id: str = "win-main") -> dict[str, Any]:
    response = client.post(
        "/api/workers/register",
        headers={"Authorization": "Bearer worker-register-test-token"},
        json={
            "worker_id": worker_id,
            "machine_name": "DevBox",
            "os": "windows",
            "reachable_backends": ["codex", "claude"],
            "workspace_roots": ["E:/work"],
            "capabilities": {"psmux": True},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()
