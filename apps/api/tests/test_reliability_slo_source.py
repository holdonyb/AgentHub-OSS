from __future__ import annotations

from datetime import timedelta

from app.core.json import dumps_json
from app.models import Event, Job, utcnow
from conftest import auth_headers, bootstrap_owner, login


def test_slo_source_returns_windowed_events_and_jobs(client) -> None:
    bootstrap_owner(client)
    auth = login(client)
    headers = auth_headers(auth)
    space_id = auth["space"]["space_id"]
    now = utcnow()

    with client.app.state.SessionLocal() as db:
        recent_job = Job(
            space_id=space_id,
            job_id="job-recent",
            kind="session_input",
            status="succeeded",
            created_at=now - timedelta(days=1),
            updated_at=now - timedelta(days=1),
        )
        old_job = Job(
            space_id=space_id,
            job_id="job-old",
            kind="session_input",
            status="failed",
            created_at=now - timedelta(days=8),
            updated_at=now - timedelta(days=8),
        )
        recent_event = Event(
            space_id=space_id,
            actor_type="worker",
            actor_id="win-main",
            source_type="job",
            source_id="job-recent",
            event_type="job.complete",
            payload_json=dumps_json({"kind": "session_input"}),
            created_at=now - timedelta(hours=2),
        )
        old_event = Event(
            space_id=space_id,
            actor_type="worker",
            actor_id="win-main",
            source_type="job",
            source_id="job-old",
            event_type="job.fail",
            payload_json=dumps_json({"kind": "session_input"}),
            created_at=now - timedelta(days=8),
        )
        db.add_all([recent_job, old_job, recent_event, old_event])
        db.commit()

    response = client.get("/api/events/slo-source?days=7&limit=1000", headers=headers)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["window_days"] == 7
    assert payload["job_count"] == 1
    source_ids = [item["source_id"] for item in payload["events"]]
    assert "job-recent" in source_ids
    assert "job-old" not in source_ids
    assert [item["job_id"] for item in payload["jobs"]] == ["job-recent"]
