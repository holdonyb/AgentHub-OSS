from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.core.json import loads_json
from app.models import AgentSession, Event, Job, utcnow
from conftest import auth_headers, bootstrap_owner, create_worker, login
from reporting import write_fault_report


@pytest.mark.all_scenarios
@pytest.mark.fi_1
def test_fi_1_worker_restart_marks_orphaned_active_job_and_unblocks_session(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client, worker_id="restart-worker")
    worker_id = worker["worker"]["worker_id"]
    user_headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "restart-session",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/restart-session.jsonl",
        },
        headers=user_headers,
    )
    assert created.status_code == 200, created.text

    queued = client.post(
        "/api/sessions/restart-session/input",
        json={"prompt": "simulate a long job before worker restart"},
        headers=user_headers,
    )
    assert queued.status_code == 200, queued.text
    job_id = queued.json()["job"]["job_id"]

    claimed = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == job_id

    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.job_id == job_id).one()
        job.claimed_at = utcnow() - timedelta(seconds=180)
        job.updated_at = job.claimed_at
        db.commit()

    heartbeat = client.post(
        f"/api/workers/{worker_id}/heartbeat",
        json={"status": "online", "active_job_ids": []},
        headers=worker_headers,
    )
    assert heartbeat.status_code == 200, heartbeat.text

    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.job_id == job_id).one()
        session = db.query(AgentSession).filter(AgentSession.session_id == "restart-session").one()
        event = (
            db.query(Event)
            .filter(Event.source_type == "job", Event.source_id == job_id, Event.event_type == "job.fail_orphaned")
            .one()
        )
        payload = loads_json(event.payload_json, {})

        assert job.status == "failed"
        assert job.completed_at is not None
        assert "orphaned" in str(job.error_text)
        assert session.status == "ready"
        assert payload == {
            "type": "stale_job",
            "worker_id": worker_id,
            "job_id": job_id,
            "kind": "session_input",
            "reason": "worker_restart_without_active_job",
            "recovery_action": "failed_unblock_queued_input",
            "grace_seconds": 120,
            "active_job_count": 0,
        }

    zombie_complete = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        json={"worker_id": worker_id, "result_text": "late zombie completion"},
        headers=worker_headers,
    )
    assert zombie_complete.status_code == 409

    next_queued = client.post(
        "/api/sessions/restart-session/input",
        json={"prompt": "next job after restart"},
        headers=user_headers,
    )
    assert next_queued.status_code == 200, next_queued.text
    next_claimed = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert next_claimed.status_code == 200, next_claimed.text
    assert next_claimed.json()["job"]["job_id"] == next_queued.json()["job"]["job_id"]

    report_path = write_fault_report(
        "fi-1-worker-restart",
        {
            "worker_id": worker_id,
            "recovered_job_id": job_id,
            "event_type": "job.fail_orphaned",
            "late_completion_status": zombie_complete.status_code,
            "next_job_claimed": True,
        },
    )
    assert report_path.exists()
