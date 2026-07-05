from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
from fastapi.testclient import TestClient

from app.core.json import loads_json
from app.models import Event, Job, utcnow
from conftest import auth_headers, bootstrap_owner, create_worker, login


def _create_codex_session(client: TestClient, *, session_id: str, worker_id: str, headers: dict[str, str]) -> None:
    response = client.post(
        "/api/sessions",
        json={
            "session_id": session_id,
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": f"codex/{session_id}.jsonl",
            "status": "ready",
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text


def test_recovery_events_have_filterable_structured_payload(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client, worker_id="observability-worker")
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)
    _create_codex_session(client, session_id="observability-session", worker_id=worker_id, headers=headers)

    queued = client.post(
        "/api/sessions/observability-session/input",
        json={"prompt": "simulate a stale dispatch"},
        headers=headers,
    )
    assert queued.status_code == 200, queued.text
    job_id = queued.json()["job"]["job_id"]

    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.job_id == job_id).one()
        job.status = "running"
        job.claimed_at = utcnow() - timedelta(seconds=3700)
        job.updated_at = job.claimed_at
        db.commit()

    listed = client.get("/api/jobs", headers=headers)
    assert listed.status_code == 200, listed.text

    matched = client.get(
        "/api/events?payload_type=stale_job&worker_id=observability-worker&job_id="
        f"{job_id}&reason=claimed_job_timeout",
        headers=headers,
    )
    assert matched.status_code == 200, matched.text
    items = matched.json()["items"]
    assert len(items) == 1
    payload = items[0]["payload"]
    assert items[0]["event_type"] == "job.fail_stale"
    assert payload["type"] == "stale_job"
    assert payload["worker_id"] == worker_id
    assert payload["job_id"] == job_id
    assert payload["reason"] == "claimed_job_timeout"

    mismatched = client.get(
        "/api/events?payload_type=stale_job&worker_id=observability-worker&reason=worker_heartbeat_expired",
        headers=headers,
    )
    assert mismatched.status_code == 200, mismatched.text
    assert mismatched.json()["items"] == []


def test_recovery_event_triggers_notification_failure_record(
    tmp_path: Path,
    monkeypatch,
) -> None:
    db_path = tmp_path / "agenthub-reliability-notification.db"
    monkeypatch.setenv("AGENTHUB_DATABASE_URL", f"sqlite+pysqlite:///{db_path.as_posix()}")
    monkeypatch.setenv("AGENTHUB_BOOTSTRAP_TOKEN", "bootstrap-test-token")
    monkeypatch.setenv("AGENTHUB_WORKER_REGISTRATION_TOKEN", "worker-register-test-token")
    monkeypatch.setenv("AGENTHUB_COOKIE_SECURE", "false")
    monkeypatch.setenv("AGENTHUB_NOTIFICATION_WEBHOOK_URL", "https://notification.invalid/agenthub")
    monkeypatch.setenv("AGENTHUB_NOTIFICATION_MAX_ATTEMPTS", "2")
    monkeypatch.setenv("AGENTHUB_NOTIFICATION_BACKOFF_SECONDS", "0")

    notification_attempts: list[dict[str, Any]] = []

    def fake_post(url: str, *, json: dict[str, Any], timeout: float) -> httpx.Response:
        notification_attempts.append({"url": url, "json": json, "timeout": timeout})
        return httpx.Response(500, request=httpx.Request("POST", url), text="down")

    monkeypatch.setattr(httpx, "post", fake_post)

    from app.core.config import get_settings
    from app.core.database import reset_database
    from app.main import create_app

    get_settings.cache_clear()
    app = create_app()
    reset_database(app.state.db_engine)
    with TestClient(app) as client:
        bootstrap_owner(client)
        owner_login = login(client)
        worker = create_worker(client, worker_id="notify-recovery-worker")
        worker_id = worker["worker"]["worker_id"]
        headers = auth_headers(owner_login)
        _create_codex_session(client, session_id="notify-recovery-session", worker_id=worker_id, headers=headers)

        queued = client.post(
            "/api/sessions/notify-recovery-session/input",
            json={"prompt": "recover and notify"},
            headers=headers,
        )
        assert queued.status_code == 200, queued.text
        job_id = queued.json()["job"]["job_id"]

        with client.app.state.SessionLocal() as db:
            job = db.query(Job).filter(Job.job_id == job_id).one()
            job.status = "running"
            job.claimed_at = utcnow() - timedelta(seconds=3700)
            job.updated_at = job.claimed_at
            db.commit()

        listed = client.get("/api/jobs", headers=headers)
        assert listed.status_code == 200, listed.text

        with client.app.state.SessionLocal() as db:
            failure_event = (
                db.query(Event)
                .filter(Event.source_type == "job", Event.source_id == job_id)
                .filter(Event.event_type == "notification.delivery_failed")
                .one()
            )
            payload = loads_json(failure_event.payload_json, {})
            assert payload["notification_type"] == "job.fail_stale"
            assert payload["attempts"] == 2
            assert payload["reason"] == "http_500"

    assert len(notification_attempts) == 2
    assert notification_attempts[0]["json"]["notification_type"] == "job.fail_stale"
    get_settings.cache_clear()


def test_dispatch_failure_is_audited_before_rejecting_session_input(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker_response = client.post(
        "/api/workers/register",
        headers={"Authorization": "Bearer worker-register-test-token"},
        json={
            "worker_id": "linux-no-codex-a4",
            "machine_name": "VM",
            "os": "linux",
            "reachable_backends": ["tmux"],
            "workspace_roots": ["/opt/work"],
            "capabilities": {"tmux": True},
        },
    )
    assert worker_response.status_code == 200, worker_response.text

    _create_codex_session(client, session_id="dispatch-failure-session", worker_id="linux-no-codex-a4", headers=headers)

    response = client.post(
        "/api/sessions/dispatch-failure-session/input",
        json={"prompt": "this should fail dispatch"},
        headers=headers,
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "WORKER_BACKEND_UNAVAILABLE"

    events = client.get("/api/events?event_type=job.dispatch_failed&payload_type=dispatch_failed", headers=headers)
    assert events.status_code == 200, events.text
    items = events.json()["items"]
    assert len(items) == 1
    payload = items[0]["payload"]
    assert payload["type"] == "dispatch_failed"
    assert payload["worker_id"] == "linux-no-codex-a4"
    assert payload["job_id"] is None
    assert payload["session_id"] == "dispatch-failure-session"
    assert payload["reason"] == "worker_backend_unavailable"
