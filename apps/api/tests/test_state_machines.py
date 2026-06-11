from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.models import AgentSession, Job, utcnow
from conftest import auth_headers, bootstrap_owner, create_worker, login


def test_job_cannot_complete_twice(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)

    job = client.post(
        "/api/jobs",
        json={
            "kind": "health_check",
            "worker_id": worker["worker"]["worker_id"],
            "namespace": "default",
            "payload": {},
        },
        headers=auth_headers(owner_login),
    ).json()["job"]

    claimed = client.post(
        "/api/internal/jobs/claim",
        json={"worker_id": worker["worker"]["worker_id"]},
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
    )
    assert claimed.status_code == 200, claimed.text

    complete = client.post(
        f"/api/internal/jobs/{job['job_id']}/complete",
        json={"worker_id": worker["worker"]["worker_id"], "result_text": "ok"},
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
    )
    assert complete.status_code == 200, complete.text

    duplicate = client.post(
        f"/api/internal/jobs/{job['job_id']}/complete",
        json={"worker_id": worker["worker"]["worker_id"], "result_text": "ok again"},
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
    )
    assert duplicate.status_code == 409


def test_offline_worker_is_not_assigned_new_jobs(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)

    from app.models import Worker

    with client.app.state.SessionLocal() as db:
        db_worker = db.query(Worker).filter(Worker.worker_id == worker["worker"]["worker_id"]).one()
        db_worker.status = "offline"
        db_worker.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        db.commit()

    client.post(
        "/api/jobs",
        json={"kind": "health_check", "worker_id": worker["worker"]["worker_id"]},
        headers=auth_headers(owner_login),
    )
    claimed = client.post(
        "/api/internal/jobs/claim",
        json={"worker_id": worker["worker"]["worker_id"]},
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
    )
    assert claimed.status_code == 204


def test_session_input_waits_until_current_session_job_finishes(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "queued-session",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/queued-session.jsonl",
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    first = client.post("/api/sessions/queued-session/input", json={"prompt": "第一条"}, headers=headers)
    second = client.post("/api/sessions/queued-session/input", json={"prompt": "第二条"}, headers=headers)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text

    claimed_first = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert claimed_first.status_code == 200, claimed_first.text
    assert claimed_first.json()["job"]["payload"]["prompt"] == "第一条"

    blocked_second = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert blocked_second.status_code == 204

    completed = client.post(
        f"/api/internal/jobs/{claimed_first.json()['job']['job_id']}/complete",
        json={"worker_id": worker_id, "result_text": "done"},
        headers=worker_headers,
    )
    assert completed.status_code == 200, completed.text

    claimed_second = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert claimed_second.status_code == 200, claimed_second.text
    assert claimed_second.json()["job"]["payload"]["prompt"] == "第二条"


def test_session_input_waits_until_active_runtime_session_is_idle(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "active-codex-session",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/active-codex-session.jsonl",
            "status": "running",
            "last_message": "执行命令: pytest",
            "last_role": "system",
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    queued = client.post(
        "/api/sessions/active-codex-session/input",
        json={"prompt": "等当前 Codex 空闲后再发送"},
        headers=headers,
    )
    assert queued.status_code == 200, queued.text
    assert queued.json()["job"]["status"] == "queued"

    session = client.get("/api/sessions/active-codex-session", headers=headers).json()["session"]
    assert session["status"] == "running"

    blocked = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert blocked.status_code == 204

    discovered = client.post(
        "/api/internal/sessions/discovered",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "sessions": [
                {
                    "session_id": "active-codex-session",
                    "backend": "codex",
                    "worker_id": worker_id,
                    "workspace_root": "E:/work/AgentHub",
                    "project_name": "AgentHub",
                    "runtime_session_ref": "codex/active-codex-session.jsonl",
                    "status": "ready",
                    "last_message": "执行完成",
                    "last_role": "assistant",
                }
            ],
        },
    )
    assert discovered.status_code == 200, discovered.text

    claimed = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["payload"]["prompt"] == "等当前 Codex 空闲后再发送"


def test_worker_heartbeat_fails_stale_running_job_and_unblocks_queued_input(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "stale-active-session",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/stale-active-session.jsonl",
            "status": "running",
            "last_message": "执行命令: npm test",
            "last_role": "system",
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    queued = client.post(
        "/api/sessions/stale-active-session/input",
        json={"prompt": "恢复后继续发送"},
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

    heartbeat = client.post(
        f"/api/workers/{worker_id}/heartbeat",
        json={"status": "online", "capabilities": {"codex": True}},
        headers=worker_headers,
    )
    assert heartbeat.status_code == 200, heartbeat.text

    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.job_id == job_id).one()
        session = db.query(AgentSession).filter(AgentSession.session_id == "stale-active-session").one()
        assert job.status == "failed"
        assert job.completed_at is not None
        assert "timed out" in str(job.error_text)
        assert session.status == "ready"

    queued = client.post(
        "/api/sessions/stale-active-session/input",
        json={"prompt": "恢复后继续发送"},
        headers=headers,
    )
    assert queued.status_code == 200, queued.text

    claimed = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == queued.json()["job"]["job_id"]


def test_worker_heartbeat_releases_orphaned_running_job_not_reported_active(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "orphaned-active-session",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/orphaned-active-session.jsonl",
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    first = client.post("/api/sessions/orphaned-active-session/input", json={"prompt": "第一条"}, headers=headers)
    assert first.status_code == 200, first.text
    claimed_first = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert claimed_first.status_code == 200, claimed_first.text
    first_job_id = claimed_first.json()["job"]["job_id"]

    second = client.post("/api/sessions/orphaned-active-session/input", json={"prompt": "第二条"}, headers=headers)
    assert second.status_code == 200, second.text
    second_job_id = second.json()["job"]["job_id"]

    with client.app.state.SessionLocal() as db:
        first_job = db.query(Job).filter(Job.job_id == first_job_id).one()
        first_job.claimed_at = utcnow() - timedelta(seconds=180)
        first_job.updated_at = first_job.claimed_at
        db.commit()

    heartbeat = client.post(
        f"/api/workers/{worker_id}/heartbeat",
        json={"status": "online", "capabilities": {"codex": True}, "active_job_ids": []},
        headers=worker_headers,
    )
    assert heartbeat.status_code == 200, heartbeat.text

    with client.app.state.SessionLocal() as db:
        first_job = db.query(Job).filter(Job.job_id == first_job_id).one()
        second_job = db.query(Job).filter(Job.job_id == second_job_id).one()
        session = db.query(AgentSession).filter(AgentSession.session_id == "orphaned-active-session").one()
        assert first_job.status == "failed"
        assert "orphaned" in str(first_job.error_text)
        assert second_job.status == "queued"
        assert session.status == "queued"

    claimed_second = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert claimed_second.status_code == 200, claimed_second.text
    assert claimed_second.json()["job"]["job_id"] == second_job_id


def test_listing_jobs_fails_stale_running_job_without_worker_heartbeat(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "stale-disconnected-session",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/stale-disconnected-session.jsonl",
            "status": "running",
            "last_message": "执行命令: npm test",
            "last_role": "system",
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    queued = client.post(
        "/api/sessions/stale-disconnected-session/input",
        json={"prompt": "worker 断开后也要释放"},
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

    listed_job = next(item for item in listed.json()["items"] if item["job_id"] == job_id)
    assert listed_job["status"] == "failed"
    assert "timed out" in listed_job["error_text"]
    with client.app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "stale-disconnected-session").one()
        assert session.status == "ready"


def test_listing_sessions_releases_running_job_when_worker_heartbeat_expired(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "offline-worker-running-session",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/offline-worker-running-session.jsonl",
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    first = client.post("/api/sessions/offline-worker-running-session/input", json={"prompt": "第一条"}, headers=headers)
    assert first.status_code == 200, first.text
    claimed_first = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)
    assert claimed_first.status_code == 200, claimed_first.text
    first_job_id = claimed_first.json()["job"]["job_id"]

    second = client.post("/api/sessions/offline-worker-running-session/input", json={"prompt": "第二条"}, headers=headers)
    assert second.status_code == 200, second.text
    second_job_id = second.json()["job"]["job_id"]

    with client.app.state.SessionLocal() as db:
        from app.models import Worker

        db_worker = db.query(Worker).filter(Worker.worker_id == worker_id).one()
        db_worker.status = "online"
        db_worker.last_heartbeat_at = utcnow() - timedelta(seconds=240)
        first_job = db.query(Job).filter(Job.job_id == first_job_id).one()
        first_job.claimed_at = utcnow() - timedelta(seconds=180)
        first_job.updated_at = first_job.claimed_at
        db.commit()

    listed = client.get("/api/sessions", headers=headers)
    assert listed.status_code == 200, listed.text

    with client.app.state.SessionLocal() as db:
        from app.models import Worker

        db_worker = db.query(Worker).filter(Worker.worker_id == worker_id).one()
        first_job = db.query(Job).filter(Job.job_id == first_job_id).one()
        second_job = db.query(Job).filter(Job.job_id == second_job_id).one()
        session = db.query(AgentSession).filter(AgentSession.session_id == "offline-worker-running-session").one()
        assert db_worker.status == "offline"
        assert first_job.status == "failed"
        assert "heartbeat expired" in str(first_job.error_text)
        assert second_job.status == "queued"
        assert session.status == "queued"


def test_listing_workers_marks_expired_heartbeat_offline(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)

    with client.app.state.SessionLocal() as db:
        from app.models import Worker

        db_worker = db.query(Worker).filter(Worker.worker_id == worker_id).one()
        db_worker.status = "online"
        db_worker.last_heartbeat_at = utcnow() - timedelta(seconds=240)
        db.commit()

    listed = client.get("/api/workers", headers=headers)

    assert listed.status_code == 200, listed.text
    listed_worker = next(item for item in listed.json()["items"] if item["worker_id"] == worker_id)
    assert listed_worker["status"] == "offline"


def test_stale_runtime_running_session_does_not_block_queued_input(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "old-runtime-running-session",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/old-runtime-running-session.jsonl",
            "status": "running",
            "last_message": "执行命令: npm test",
            "last_role": "system",
            "last_activity_at": (utcnow() - timedelta(hours=2)).isoformat(),
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    queued = client.post(
        "/api/sessions/old-runtime-running-session/input",
        json={"prompt": "继续处理"},
        headers=headers,
    )
    assert queued.status_code == 200, queued.text

    claimed = client.post("/api/internal/jobs/claim", json={"worker_id": worker_id}, headers=worker_headers)

    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["target_session_id"] == "old-runtime-running-session"


def test_duplicate_worker_register_is_idempotent_and_token_bound(client: TestClient) -> None:
    bootstrap_owner(client)
    first = create_worker(client)
    second = create_worker(client)
    assert first["worker"]["worker_id"] == second["worker"]["worker_id"]
    assert second["worker_token"] is None

    heartbeat = client.post(
        "/api/workers/win-main/heartbeat",
        json={"status": "online", "capabilities": {"codex": True}},
        headers={"Authorization": f"Bearer {first['worker_token']}"},
    )
    assert heartbeat.status_code == 200, heartbeat.text

    wrong = client.post(
        "/api/workers/win-main/heartbeat",
        json={"status": "online"},
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert wrong.status_code == 403
