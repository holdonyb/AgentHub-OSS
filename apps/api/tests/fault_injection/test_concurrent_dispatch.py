from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.models import AgentSession, Job
from conftest import auth_headers, bootstrap_owner, create_worker, login
from reporting import write_fault_report


@pytest.mark.all_scenarios
@pytest.mark.fi_4
def test_fi_4_concurrent_dispatch_reaches_terminal_state_without_duplicate_jobs(
    client: TestClient,
) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client, worker_id="concurrent-worker")
    worker_id = worker["worker"]["worker_id"]
    user_headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    def create_session_and_input(index: int) -> dict[str, Any]:
        session_id = f"concurrent-session-{index}"
        created = client.post(
            "/api/sessions",
            json={
                "session_id": session_id,
                "backend": "codex",
                "worker_id": worker_id,
                "workspace_root": "E:/work/AgentHub",
                "project_name": "AgentHub",
                "runtime_session_ref": f"codex/{session_id}.jsonl",
            },
            headers=user_headers,
        )
        if created.status_code != 200:
            return {"index": index, "status_code": created.status_code, "body": created.text}
        queued = client.post(
            f"/api/sessions/{session_id}/input",
            json={"prompt": f"concurrent prompt {index}"},
            headers=user_headers,
        )
        if queued.status_code != 200:
            return {"index": index, "status_code": queued.status_code, "body": queued.text}
        return {
            "index": index,
            "status_code": 200,
            "session_id": session_id,
            "job_id": queued.json()["job"]["job_id"],
        }

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(create_session_and_input, index) for index in range(10)]
        results = [future.result() for future in as_completed(futures)]

    failures = [result for result in results if result["status_code"] != 200]
    assert failures == []
    session_ids = {result["session_id"] for result in results}
    queued_job_ids = {result["job_id"] for result in results}
    assert len(session_ids) == 10
    assert len(queued_job_ids) == 10

    completed_job_ids: set[str] = set()
    for _ in range(10):
        claimed = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
        assert claimed.status_code == 200, claimed.text
        job_id = claimed.json()["job"]["job_id"]
        assert job_id in queued_job_ids
        assert job_id not in completed_job_ids
        completed = client.post(
            f"/api/internal/jobs/{job_id}/complete",
            json={"worker_id": worker_id, "result_text": f"completed {job_id}"},
            headers=worker_headers,
        )
        assert completed.status_code == 200, completed.text
        completed_job_ids.add(job_id)

    no_more_claims = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert no_more_claims.status_code == 204

    with client.app.state.SessionLocal() as db:
        jobs = db.query(Job).filter(Job.job_id.in_(queued_job_ids)).all()
        sessions = db.query(AgentSession).filter(AgentSession.session_id.in_(session_ids)).all()
        assert len(jobs) == 10
        assert len(sessions) == 10
        assert {job.status for job in jobs} == {"succeeded"}
        assert {session.status for session in sessions} == {"ready"}
        assert {job.job_id for job in jobs} == completed_job_ids

    report_path = write_fault_report(
        "fi-4-concurrent-dispatch",
        {
            "worker_id": worker_id,
            "session_count": len(session_ids),
            "queued_job_count": len(queued_job_ids),
            "completed_job_count": len(completed_job_ids),
            "duplicate_job_ids": False,
            "sqlite_lock_errors": False,
        },
    )
    assert report_path.exists()
