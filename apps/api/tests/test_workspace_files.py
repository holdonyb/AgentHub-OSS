from __future__ import annotations

from datetime import timedelta
import json

from fastapi.testclient import TestClient

from conftest import auth_headers, bootstrap_owner, create_worker, login
from app.models import Job, utcnow


def test_workspace_file_job_runs_without_a_session(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client, "workspace-win")
    headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    queued = client.post(
        "/api/workspaces/files/list",
        headers=headers,
        json={
            "worker_id": "workspace-win",
            "workspace_root": "E:\\work",
            "path": ".",
        },
    )

    assert queued.status_code == 200, queued.text
    job = queued.json()["job"]
    assert job["kind"] == "file_list"
    assert job["target_session_id"] is None
    assert job["worker_id"] == "workspace-win"
    assert job["workspace_root"] == "E:/work"
    assert job["payload"] == {"path": "."}

    claimed = client.post(
        "/api/internal/jobs/claim",
        headers=worker_headers,
        json={"worker_id": "workspace-win"},
    )
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == job["job_id"]

    completed = client.post(
        f"/api/internal/jobs/{job['job_id']}/complete",
        headers=worker_headers,
        json={
            "worker_id": "workspace-win",
            "result_text": '{"path":".","entries":[{"name":"README.md","path":"README.md","kind":"file"}]}',
        },
    )
    assert completed.status_code == 200, completed.text

    detail = client.get(f"/api/jobs/{job['job_id']}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["job"]["status"] == "succeeded"
    assert '"README.md"' in detail.json()["job"]["result_text"]


def test_workspace_file_job_rejects_unregistered_workspace_root(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    create_worker(client, "workspace-win")

    response = client.post(
        "/api/workspaces/files/read",
        headers=auth_headers(owner_login),
        json={
            "worker_id": "workspace-win",
            "workspace_root": "C:/Users/Administrator",
            "path": "secret.txt",
            "max_bytes": 4096,
        },
    )

    assert response.status_code == 403, response.text
    assert response.json()["detail"]["code"] == "WORKSPACE_ROOT_NOT_ALLOWED"


def test_workspace_file_job_rejects_unknown_worker(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)

    response = client.post(
        "/api/workspaces/files/list",
        headers=auth_headers(owner_login),
        json={"worker_id": "missing-worker", "workspace_root": "E:/work", "path": "."},
    )

    assert response.status_code == 404, response.text
    assert response.json()["detail"]["code"] == "WORKER_NOT_FOUND"


def test_workspace_file_job_preserves_windows_drive_root(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    registered = client.post(
        "/api/workers/register",
        headers={"Authorization": "Bearer worker-register-test-token"},
        json={
            "worker_id": "workspace-drive-root",
            "machine_name": "DriveRootBox",
            "os": "windows",
            "reachable_backends": ["codex"],
            "workspace_roots": ["E:/"],
            "capabilities": {},
        },
    )
    assert registered.status_code == 200, registered.text

    queued = client.post(
        "/api/workspaces/files/list",
        headers=auth_headers(owner_login),
        json={"worker_id": "workspace-drive-root", "workspace_root": "e:\\", "path": "."},
    )

    assert queued.status_code == 200, queued.text
    assert queued.json()["job"]["workspace_root"] == "E:/"


def test_expired_file_job_bodies_are_removed_from_database(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client, "workspace-retention")
    headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    queued = client.post(
        "/api/workspaces/files/upload",
        headers=headers,
        json={
            "worker_id": "workspace-retention",
            "workspace_root": "E:/work",
            "path": ".",
            "filename": "secret.env",
            "content_type": "text/plain",
            "data_base64": "c2VjcmV0PWFiYw==",
        },
    )
    job_id = queued.json()["job"]["job_id"]
    client.post(
        "/api/internal/jobs/claim",
        headers=worker_headers,
        json={"worker_id": "workspace-retention"},
    )
    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers=worker_headers,
        json={
            "worker_id": "workspace-retention",
            "result_text": json.dumps(
                {
                    "path": "secret.env",
                    "text": "secret=abc",
                    "data_base64": "c2VjcmV0PWFiYw==",
                }
            ),
        },
    )
    assert completed.status_code == 200, completed.text

    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.job_id == job_id).one()
        job.completed_at = utcnow() - timedelta(days=2)
        db.commit()

    listed = client.get("/api/jobs", headers=headers)
    assert listed.status_code == 200, listed.text

    detail = client.get(f"/api/jobs/{job_id}", headers=headers)
    assert detail.status_code == 200, detail.text
    job = detail.json()["job"]
    assert "data_base64" not in job["payload"]
    assert job["payload"]["body_expired"] is True
    result = json.loads(job["result_text"])
    assert result == {"body_expired": True, "path": "secret.env"}
