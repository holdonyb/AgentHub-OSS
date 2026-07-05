from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.models import AgentSession, AgentTimeline, Event, Job, Worker, utcnow
from conftest import auth_headers, bootstrap_owner, create_worker, login
from reporting import write_fault_report


@pytest.mark.all_scenarios
@pytest.mark.fi_2
def test_fi_2_short_network_loss_recovers_without_false_failure_and_keeps_timeline_monotonic(
    client: TestClient,
) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client, worker_id="network-gap-worker")
    worker_id = worker["worker"]["worker_id"]
    user_headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "network-gap-session",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/network-gap-session.jsonl",
        },
        headers=user_headers,
    )
    assert created.status_code == 200, created.text

    queued = client.post(
        "/api/sessions/network-gap-session/input",
        json={"prompt": "simulate a job that survives a temporary network gap"},
        headers=user_headers,
    )
    assert queued.status_code == 200, queued.text
    job_id = queued.json()["job"]["job_id"]

    claimed = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == job_id

    first_publish = client.post(
        "/api/internal/sessions/network-gap-session/timeline",
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 1,
                    "item_type": "user_message",
                    "role": "user",
                    "text": "simulate a job that survives a temporary network gap",
                },
                {
                    "seq": 2,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "working before the network gap",
                },
            ],
        },
        headers=worker_headers,
    )
    assert first_publish.status_code == 200, first_publish.text

    with client.app.state.SessionLocal() as db:
        db_worker = db.query(Worker).filter(Worker.worker_id == worker_id).one()
        db_worker.last_heartbeat_at = utcnow() - timedelta(seconds=60)
        db.commit()

    jobs_during_gap = client.get("/api/jobs", headers=user_headers)
    assert jobs_during_gap.status_code == 200, jobs_during_gap.text

    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.job_id == job_id).one()
        session = db.query(AgentSession).filter(AgentSession.session_id == "network-gap-session").one()
        db_worker = db.query(Worker).filter(Worker.worker_id == worker_id).one()
        failure_events = (
            db.query(Event)
            .filter(Event.source_id == job_id)
            .filter(Event.event_type.in_(["job.fail_stale", "job.fail_orphaned", "job.fail_worker_offline"]))
            .all()
        )
        offline_events = (
            db.query(Event)
            .filter(Event.source_type == "worker", Event.source_id == worker_id)
            .filter(Event.event_type == "worker.offline_heartbeat_expired")
            .all()
        )
        assert job.status == "running"
        assert session.status == "running"
        assert db_worker.status == "online"
        assert failure_events == []
        assert offline_events == []

    recovered_heartbeat = client.post(
        f"/api/workers/{worker_id}/heartbeat",
        json={"status": "online", "active_job_ids": [job_id]},
        headers=worker_headers,
    )
    assert recovered_heartbeat.status_code == 200, recovered_heartbeat.text

    final_publish = client.post(
        "/api/internal/sessions/network-gap-session/timeline",
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 3,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "completed after the network gap",
                }
            ],
        },
        headers=worker_headers,
    )
    assert final_publish.status_code == 200, final_publish.text

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        json={"worker_id": worker_id, "result_text": "completed after the network gap"},
        headers=worker_headers,
    )
    assert completed.status_code == 200, completed.text

    timeline = client.get("/api/sessions/network-gap-session/timeline", headers=user_headers)
    assert timeline.status_code == 200, timeline.text
    assert [item["seq"] for item in timeline.json()["items"]] == [1, 2, 3]

    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.job_id == job_id).one()
        session = db.query(AgentSession).filter(AgentSession.session_id == "network-gap-session").one()
        timeline_seqs = [
            row.seq
            for row in (
                db.query(AgentTimeline)
                .filter(AgentTimeline.session_id == "network-gap-session")
                .order_by(AgentTimeline.seq.asc())
                .all()
            )
        ]
        assert job.status == "succeeded"
        assert session.status == "ready"
        assert timeline_seqs == sorted(timeline_seqs)

    report_path = write_fault_report(
        "fi-2-network-recovery",
        {
            "worker_id": worker_id,
            "job_id": job_id,
            "network_gap_seconds": 60,
            "false_failure": False,
            "heartbeat_recovered": True,
            "timeline_seq_monotonic": True,
        },
    )
    assert report_path.exists()
