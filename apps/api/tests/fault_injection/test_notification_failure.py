from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.json import loads_json
from app.models import AgentSession, Event, Job
from conftest import auth_headers, bootstrap_owner, create_worker, login
from reporting import write_fault_report


@pytest.mark.all_scenarios
@pytest.mark.fi_5
def test_fi_5_notification_webhook_failure_retries_and_does_not_block_job_completion(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "agenthub-notification-failure.db"
    monkeypatch.setenv("AGENTHUB_DATABASE_URL", f"sqlite+pysqlite:///{db_path.as_posix()}")
    monkeypatch.setenv("AGENTHUB_BOOTSTRAP_TOKEN", "bootstrap-test-token")
    monkeypatch.setenv("AGENTHUB_WORKER_REGISTRATION_TOKEN", "worker-register-test-token")
    monkeypatch.setenv("AGENTHUB_COOKIE_SECURE", "false")
    monkeypatch.setenv("AGENTHUB_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv("AGENTHUB_LOGIN_RATE_LIMIT_COUNT", "3")
    monkeypatch.setenv("AGENTHUB_LOGIN_RATE_LIMIT_WINDOW_SECONDS", "60")
    monkeypatch.setenv("AGENTHUB_NOTIFICATION_WEBHOOK_URL", "https://notification.invalid/agenthub")
    monkeypatch.setenv("AGENTHUB_NOTIFICATION_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("AGENTHUB_NOTIFICATION_BACKOFF_SECONDS", "0")

    notification_attempts: list[dict[str, Any]] = []

    def fake_post(url: str, *, json: dict[str, Any], timeout: float) -> httpx.Response:
        notification_attempts.append({"url": url, "json": json, "timeout": timeout})
        return httpx.Response(500, request=httpx.Request("POST", url), text="down")

    monkeypatch.setattr(httpx, "post", fake_post)

    from app.core.database import reset_database
    from app.core.config import get_settings
    from app.factory import create_app

    get_settings.cache_clear()
    app = create_app()
    reset_database(app.state.db_engine)
    with TestClient(app) as client:
        bootstrap_owner(client)
        owner_login = login(client)
        worker = create_worker(client, worker_id="notification-worker")
        worker_id = worker["worker"]["worker_id"]
        user_headers = auth_headers(owner_login)
        worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

        created = client.post(
            "/api/sessions",
            json={
                "session_id": "notification-session",
                "backend": "codex",
                "worker_id": worker_id,
                "workspace_root": "E:/work/AgentHub",
                "project_name": "AgentHub",
                "runtime_session_ref": "codex/notification-session.jsonl",
            },
            headers=user_headers,
        )
        assert created.status_code == 200, created.text

        queued = client.post(
            "/api/sessions/notification-session/input",
            json={"prompt": "complete even when notification webhook is down"},
            headers=user_headers,
        )
        assert queued.status_code == 200, queued.text
        job_id = queued.json()["job"]["job_id"]

        claimed = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
        assert claimed.status_code == 200, claimed.text
        assert claimed.json()["job"]["job_id"] == job_id

        completed = client.post(
            f"/api/internal/jobs/{job_id}/complete",
            json={"worker_id": worker_id, "result_text": "completed despite notification failure"},
            headers=worker_headers,
        )
        assert completed.status_code == 200, completed.text
        assert completed.json()["job"]["status"] == "succeeded"

        with client.app.state.SessionLocal() as db:
            job = db.query(Job).filter(Job.job_id == job_id).one()
            session = db.query(AgentSession).filter(AgentSession.session_id == "notification-session").one()
            failure_event = (
                db.query(Event)
                .filter(Event.source_type == "job", Event.source_id == job_id)
                .filter(Event.event_type == "notification.delivery_failed")
                .one()
            )
            payload = loads_json(failure_event.payload_json, {})
            assert job.status == "succeeded"
            assert session.status == "ready"
            assert payload["notification_type"] == "job.complete"
            assert payload["attempts"] == 3
            assert payload["reason"] == "http_500"
            assert payload["retry_exhausted"] is True

    assert len(notification_attempts) == 3
    assert {attempt["url"] for attempt in notification_attempts} == {"https://notification.invalid/agenthub"}
    get_settings.cache_clear()

    report_path = write_fault_report(
        "fi-5-notification-failure",
        {
            "worker_id": worker_id,
            "job_id": job_id,
            "notification_attempts": len(notification_attempts),
            "failure_event_written": True,
            "job_completion_blocked": False,
        },
    )
    assert report_path.exists()
