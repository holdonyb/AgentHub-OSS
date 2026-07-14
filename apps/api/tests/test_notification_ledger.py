from __future__ import annotations

from fastapi.testclient import TestClient

from conftest import auth_headers, bootstrap_owner, create_worker, login


def _create_session(client: TestClient, headers: dict[str, str], worker_id: str, session_id: str) -> dict:
    response = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": session_id,
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": f"codex/{session_id}",
            "status": "ready",
            "title": "Notification ledger",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["session"]


def test_session_exposes_execution_and_attention_revisions_for_legacy_workers(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client, "runtime-state-worker")
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = _create_session(client, headers, worker_id, "runtime-state-session")
    assert created["status"] == "ready"
    assert created["execution_status"] == "idle"
    assert created["execution_status_seq"] >= 1
    assert created["attention_status"] == "none"
    initial_seq = created["execution_status_seq"]

    queued = client.post(
        "/api/sessions/runtime-state-session/input",
        headers=headers,
        json={"prompt": "run the state transition test"},
    )
    assert queued.status_code == 200, queued.text
    queued_session = client.get("/api/sessions/runtime-state-session", headers=headers).json()["session"]
    assert queued_session["execution_status"] == "queued"
    assert queued_session["execution_status_seq"] > initial_seq
    assert queued_session["attention_status"] == "none"

    claimed = client.post(
        "/api/internal/jobs/claim",
        headers=worker_headers,
        json={"worker_id": worker_id},
    )
    assert claimed.status_code == 200, claimed.text
    job_id = claimed.json()["job"]["job_id"]
    running_session = client.get("/api/sessions/runtime-state-session", headers=headers).json()["session"]
    assert running_session["execution_status"] == "running"
    assert running_session["execution_status_seq"] > queued_session["execution_status_seq"]

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers=worker_headers,
        json={"worker_id": worker_id, "result_text": "state transition complete"},
    )
    assert completed.status_code == 200, completed.text
    completed_session = client.get("/api/sessions/runtime-state-session", headers=headers).json()["session"]
    assert completed_session["execution_status"] == "idle"
    assert completed_session["attention_status"] == "unseen"
    assert completed_session["attention_reason"] == "completion"
    assert completed_session["attention_revision"] >= 1

    seen = client.post("/api/sessions/runtime-state-session/attention/seen", headers=headers)
    assert seen.status_code == 200, seen.text
    assert seen.json()["session"]["attention_status"] == "seen"
    assert seen.json()["session"]["attention_revision"] > completed_session["attention_revision"]


def test_notification_ledger_is_idempotent_and_persists_delivery_and_read_state(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client, "notification-ledger-worker")
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}
    _create_session(client, headers, worker_id, "notification-ledger-session")

    permission_payload = {
        "worker_id": worker_id,
        "permission": {
            "permission_id": "permission-ledger-1",
            "session_id": "notification-ledger-session",
            "backend": "codex",
            "kind": "question",
            "title": "选择维护窗口",
            "description": "Agent 正在等待你的选择\n" + ("detail " * 100),
            "detail": {"questions": []},
            "actions": {"respond": True},
        },
    }
    first_request = client.post(
        "/api/internal/permissions/requested",
        headers=worker_headers,
        json=permission_payload,
    )
    assert first_request.status_code == 200, first_request.text
    duplicate_request = client.post(
        "/api/internal/permissions/requested",
        headers=worker_headers,
        json=permission_payload,
    )
    assert duplicate_request.status_code == 200, duplicate_request.text

    listed = client.get("/api/notifications", headers=headers)
    assert listed.status_code == 200, listed.text
    items = listed.json()["items"]
    assert len(items) == 1
    notification = items[0]
    assert notification["notification_type"] == "approval"
    assert notification["session_id"] == "notification-ledger-session"
    assert notification["source_id"] == "permission-ledger-1"
    assert notification["status"] == "pending"
    assert len(notification["body"]) <= 500
    assert "\n" not in notification["body"]

    notification_id = notification["notification_id"]
    delivered = client.post(f"/api/notifications/{notification_id}/delivered", headers=headers)
    assert delivered.status_code == 200, delivered.text
    assert delivered.json()["claimed"] is True
    assert delivered.json()["notification"]["status"] == "delivered"
    assert delivered.json()["notification"]["delivered_at"] is not None

    duplicate_delivery = client.post(f"/api/notifications/{notification_id}/delivered", headers=headers)
    assert duplicate_delivery.status_code == 200, duplicate_delivery.text
    assert duplicate_delivery.json()["claimed"] is False

    read = client.post(f"/api/notifications/{notification_id}/read", headers=headers)
    assert read.status_code == 200, read.text
    assert read.json()["notification"]["status"] == "read"
    assert read.json()["notification"]["read_at"] is not None

    refreshed = client.get("/api/notifications", headers=headers).json()["items"]
    assert len(refreshed) == 1
    assert refreshed[0]["status"] == "read"

    worker_access = client.get("/api/notifications", headers=worker_headers)
    assert worker_access.status_code == 403


def test_startup_backfills_notifications_for_existing_pending_permissions(client: TestClient) -> None:
    from app.core.database import init_database
    from app.models import NotificationRecord

    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client, "notification-backfill-worker")
    worker_id = worker["worker"]["worker_id"]
    requested = client.post(
        "/api/internal/permissions/requested",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker_id,
            "permission": {
                "permission_id": "permission-existing-at-upgrade",
                "session_id": _create_session(
                    client,
                    headers,
                    worker_id,
                    "notification-backfill-session",
                )["session_id"],
                "backend": "codex",
                "kind": "question",
                "title": "Existing approval",
                "description": "This approval existed before the ledger upgrade",
                "detail": {},
                "actions": {"respond": True},
            },
        },
    )
    assert requested.status_code == 200, requested.text

    with client.app.state.SessionLocal() as db:
        db.query(NotificationRecord).delete()
        db.commit()

    init_database(client.app.state.db_engine)

    items = client.get("/api/notifications", headers=headers).json()["items"]
    backfilled = [item for item in items if item["source_id"] == "permission-existing-at-upgrade"]
    assert len(backfilled) == 1
    assert backfilled[0]["status"] == "pending"


def test_resolved_permission_supersedes_an_unclaimed_notification(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client, "resolved-notification-worker")
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}
    _create_session(client, headers, worker_id, "resolved-notification-session")

    requested = client.post(
        "/api/internal/permissions/requested",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "permission": {
                "permission_id": "permission-resolved-before-delivery",
                "session_id": "resolved-notification-session",
                "backend": "codex",
                "kind": "question",
                "title": "Proceed?",
                "description": "Approve or deny",
                "detail": {},
                "actions": {"respond": True},
            },
        },
    )
    assert requested.status_code == 200, requested.text

    responded = client.post(
        "/api/permissions/permission-resolved-before-delivery/respond",
        headers=headers,
        json={"action": "allow", "response": {}},
    )
    assert responded.status_code == 200, responded.text

    items = client.get("/api/notifications", headers=headers).json()["items"]
    approval = next(item for item in items if item["source_id"] == "permission-resolved-before-delivery")
    assert approval["status"] == "acknowledged"
    assert approval["acknowledged_at"] is not None
    resolved_session = client.get("/api/sessions/resolved-notification-session", headers=headers).json()["session"]
    assert resolved_session["execution_status"] == "idle"
    assert resolved_session["attention_status"] == "none"
    assert resolved_session["attention_reason"] == ""


def test_worker_resolved_permission_resumes_session_and_clears_attention(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client, "worker-resolved-permission-worker")
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}
    _create_session(client, headers, worker_id, "worker-resolved-permission-session")
    requested = client.post(
        "/api/internal/permissions/requested",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "permission": {
                "permission_id": "permission-resolved-on-worker",
                "session_id": "worker-resolved-permission-session",
                "backend": "claude",
                "kind": "tool",
                "title": "Allow tool?",
                "description": "The local runtime is waiting",
                "detail": {},
                "actions": {"allow": True, "deny": True},
            },
        },
    )
    assert requested.status_code == 200, requested.text

    resolved = client.post(
        "/api/internal/permissions/permission-resolved-on-worker/resolved",
        headers=worker_headers,
        json={"worker_id": worker_id, "status": "allowed", "response": {}},
    )
    assert resolved.status_code == 200, resolved.text

    session = client.get("/api/sessions/worker-resolved-permission-session", headers=headers).json()["session"]
    assert session["status"] == "running"
    assert session["execution_status"] == "running"
    assert session["attention_status"] == "none"
    notification = client.get("/api/notifications", headers=headers).json()["items"][0]
    assert notification["status"] == "acknowledged"


def test_notification_delivery_state_is_isolated_per_recipient(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    owner_headers = auth_headers(owner_login)
    invite = client.post(
        "/api/invites",
        headers=owner_headers,
        json={"email": "viewer@example.com", "role": "viewer", "expires_in_hours": 2},
    )
    assert invite.status_code == 200, invite.text

    with TestClient(client.app) as viewer_browser:
        accepted = viewer_browser.post(
            "/api/invites/accept",
            json={
                "invite_token": invite.json()["invite_token"],
                "email": "viewer@example.com",
                "password": "Correct Horse Battery Staple 42",
            },
        )
        assert accepted.status_code == 200, accepted.text
        viewer_headers = auth_headers(login(viewer_browser, "viewer@example.com"))

        worker = create_worker(client, "recipient-isolation-worker")
        worker_id = worker["worker"]["worker_id"]
        worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}
        _create_session(client, owner_headers, worker_id, "recipient-isolation-session")
        requested = client.post(
            "/api/internal/permissions/requested",
            headers=worker_headers,
            json={
                "worker_id": worker_id,
                "permission": {
                    "permission_id": "permission-recipient-isolation",
                    "session_id": "recipient-isolation-session",
                    "backend": "codex",
                    "kind": "question",
                    "title": "Choose one",
                    "description": "This should create one record per user",
                    "detail": {},
                    "actions": {"respond": True},
                },
            },
        )
        assert requested.status_code == 200, requested.text

        owner_notification = client.get("/api/notifications", headers=owner_headers).json()["items"][0]
        viewer_notification = viewer_browser.get("/api/notifications", headers=viewer_headers).json()["items"][0]
        assert owner_notification["notification_id"] != viewer_notification["notification_id"]

        viewer_delivery = viewer_browser.post(
            f"/api/notifications/{viewer_notification['notification_id']}/delivered",
            headers=viewer_headers,
        )
        assert viewer_delivery.status_code == 200, viewer_delivery.text
        assert viewer_delivery.json()["claimed"] is True

        owner_after_viewer_delivery = client.get("/api/notifications", headers=owner_headers).json()["items"][0]
        assert owner_after_viewer_delivery["status"] == "pending"
        owner_delivery = client.post(
            f"/api/notifications/{owner_notification['notification_id']}/delivered",
            headers=owner_headers,
        )
        assert owner_delivery.status_code == 200, owner_delivery.text
        assert owner_delivery.json()["claimed"] is True


def test_job_completion_notification_is_created_once_and_can_be_acknowledged(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client, "completion-notification-worker")
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}
    _create_session(client, headers, worker_id, "completion-notification-session")

    queued = client.post(
        "/api/sessions/completion-notification-session/input",
        headers=headers,
        json={"prompt": "finish once"},
    )
    assert queued.status_code == 200, queued.text
    claimed = client.post(
        "/api/internal/jobs/claim",
        headers=worker_headers,
        json={"worker_id": worker_id},
    )
    assert claimed.status_code == 200, claimed.text
    job_id = claimed.json()["job"]["job_id"]
    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers=worker_headers,
        json={"worker_id": worker_id, "result_text": "done"},
    )
    assert completed.status_code == 200, completed.text

    items = client.get("/api/notifications", headers=headers).json()["items"]
    completion_items = [item for item in items if item["notification_type"] == "completion"]
    assert len(completion_items) == 1
    notification_id = completion_items[0]["notification_id"]

    acknowledged = client.post(f"/api/notifications/{notification_id}/acknowledge", headers=headers)
    assert acknowledged.status_code == 200, acknowledged.text
    assert acknowledged.json()["notification"]["status"] == "acknowledged"
    assert acknowledged.json()["notification"]["acknowledged_at"] is not None
