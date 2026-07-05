from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.models import AgentSession, Event, Job
from conftest import auth_headers, bootstrap_owner, create_worker, login
from reporting import write_fault_report


def _create_restartable_app():
    from app.main import create_app

    return create_app()


@pytest.mark.all_scenarios
@pytest.mark.fi_3
def test_fi_3_api_restart_preserves_inflight_job_and_rejects_duplicate_completion(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "agenthub-api-restart.db"
    monkeypatch.setenv("AGENTHUB_DATABASE_URL", f"sqlite+pysqlite:///{db_path.as_posix()}")
    monkeypatch.setenv("AGENTHUB_BOOTSTRAP_TOKEN", "bootstrap-test-token")
    monkeypatch.setenv("AGENTHUB_WORKER_REGISTRATION_TOKEN", "worker-register-test-token")
    monkeypatch.setenv("AGENTHUB_COOKIE_SECURE", "false")
    monkeypatch.setenv("AGENTHUB_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv("AGENTHUB_LOGIN_RATE_LIMIT_COUNT", "3")
    monkeypatch.setenv("AGENTHUB_LOGIN_RATE_LIMIT_WINDOW_SECONDS", "60")

    from app.core.database import reset_database

    app_before_restart = _create_restartable_app()
    reset_database(app_before_restart.state.db_engine)
    with TestClient(app_before_restart) as client:
        bootstrap_owner(client)
        owner_login = login(client)
        worker = create_worker(client, worker_id="api-restart-worker")
        worker_id = worker["worker"]["worker_id"]
        user_headers = auth_headers(owner_login)
        worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

        created = client.post(
            "/api/sessions",
            json={
                "session_id": "api-restart-session",
                "backend": "codex",
                "worker_id": worker_id,
                "workspace_root": "E:/work/AgentHub",
                "project_name": "AgentHub",
                "runtime_session_ref": "codex/api-restart-session.jsonl",
            },
            headers=user_headers,
        )
        assert created.status_code == 200, created.text

        queued = client.post(
            "/api/sessions/api-restart-session/input",
            json={"prompt": "survive an API restart while the worker is running"},
            headers=user_headers,
        )
        assert queued.status_code == 200, queued.text
        job_id = queued.json()["job"]["job_id"]

        claimed = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
        assert claimed.status_code == 200, claimed.text
        assert claimed.json()["job"]["job_id"] == job_id

        with client.app.state.SessionLocal() as db:
            job = db.query(Job).filter(Job.job_id == job_id).one()
            session = db.query(AgentSession).filter(AgentSession.session_id == "api-restart-session").one()
            assert job.status == "running"
            assert session.status == "running"

    app_after_restart = _create_restartable_app()
    with TestClient(app_after_restart) as restarted:
        owner_login = login(restarted)
        user_headers = auth_headers(owner_login)
        worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

        visible_before_complete = restarted.get("/api/jobs", headers=user_headers)
        assert visible_before_complete.status_code == 200, visible_before_complete.text
        visible_job = next(item for item in visible_before_complete.json()["items"] if item["job_id"] == job_id)
        assert visible_job["status"] == "running"

        completed = restarted.post(
            f"/api/internal/jobs/{job_id}/complete",
            json={"worker_id": worker_id, "result_text": "completed after API restart"},
            headers=worker_headers,
        )
        assert completed.status_code == 200, completed.text
        assert completed.json()["job"]["status"] == "succeeded"

        duplicate_complete = restarted.post(
            f"/api/internal/jobs/{job_id}/complete",
            json={"worker_id": worker_id, "result_text": "duplicate completion after restart"},
            headers=worker_headers,
        )
        assert duplicate_complete.status_code == 409

        visible_after_complete = restarted.get("/api/jobs", headers=user_headers)
        assert visible_after_complete.status_code == 200, visible_after_complete.text
        final_job = next(item for item in visible_after_complete.json()["items"] if item["job_id"] == job_id)
        assert final_job["status"] == "succeeded"

        session_response = restarted.get("/api/sessions/api-restart-session", headers=user_headers)
        assert session_response.status_code == 200, session_response.text
        assert session_response.json()["session"]["status"] == "ready"
        assert session_response.json()["session"]["last_message"] == "completed after API restart"

        with restarted.app.state.SessionLocal() as db:
            complete_events = (
                db.query(Event)
                .filter(Event.source_type == "job", Event.source_id == job_id, Event.event_type == "job.complete")
                .all()
            )
            job = db.query(Job).filter(Job.job_id == job_id).one()
            session = db.query(AgentSession).filter(AgentSession.session_id == "api-restart-session").one()
            assert len(complete_events) == 1
            assert job.status == "succeeded"
            assert session.status == "ready"

    report_path = write_fault_report(
        "fi-3-api-restart",
        {
            "worker_id": worker_id,
            "job_id": job_id,
            "api_restart_simulated": True,
            "duplicate_completion_status": duplicate_complete.status_code,
            "complete_event_count": 1,
            "final_job_status": "succeeded",
            "final_session_status": "ready",
        },
    )
    assert report_path.exists()
