from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import inspect, text

from conftest import auth_headers, bootstrap_owner, create_worker, login


def _register_device(
    client: TestClient,
    headers: dict[str, str],
    *,
    device_id: str = "phone-owner-1",
    push_token: str = "ExponentPushToken[owner-device-token]",
):
    return client.post(
        "/api/push/devices",
        headers=headers,
        json={
            "device_id": device_id,
            "platform": "android",
            "transport": "expo",
            "push_token": push_token,
            "app_version": "1.0.0",
        },
    )


def _create_session(client: TestClient, headers: dict[str, str], worker_id: str) -> None:
    response = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "push-device-session",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/push-device-session",
            "status": "ready",
            "title": "Push delivery test",
        },
    )
    assert response.status_code == 200, response.text


def _request_permission(
    client: TestClient,
    worker_headers: dict[str, str],
    worker_id: str,
    permission_id: str,
) -> None:
    response = client.post(
        "/api/internal/permissions/requested",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "permission": {
                "permission_id": permission_id,
                "session_id": "push-device-session",
                "backend": "codex",
                "kind": "question",
                "title": "Choose a deployment window",
                "description": "AgentHub is waiting for your input.",
                "detail": {},
                "actions": {"respond": True},
            },
        },
    )
    assert response.status_code == 200, response.text


def test_push_device_registration_is_user_scoped_idempotent_and_redacted(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    owner_headers = auth_headers(owner_login)

    created = _register_device(client, owner_headers)
    assert created.status_code == 200, created.text
    device = created.json()["device"]
    assert device["device_id"] == "phone-owner-1"
    assert device["platform"] == "android"
    assert device["transport"] == "expo"
    assert device["app_version"] == "1.0.0"
    assert device["enabled"] is True
    assert "push_token" not in device

    refreshed = _register_device(
        client,
        owner_headers,
        push_token="ExponentPushToken[rotated-owner-device-token]",
    )
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["device"]["device_id"] == device["device_id"]

    listed = client.get("/api/push/devices", headers=owner_headers)
    assert listed.status_code == 200, listed.text
    assert [item["device_id"] for item in listed.json()["items"]] == ["phone-owner-1"]
    assert all("push_token" not in item for item in listed.json()["items"])

    invite = client.post(
        "/api/invites",
        headers=owner_headers,
        json={"email": "push-viewer@example.com", "role": "viewer", "expires_in_hours": 2},
    )
    assert invite.status_code == 200, invite.text
    with TestClient(client.app) as viewer_browser:
        accepted = viewer_browser.post(
            "/api/invites/accept",
            json={
                "invite_token": invite.json()["invite_token"],
                "email": "push-viewer@example.com",
                "password": "Correct Horse Battery Staple 42",
            },
        )
        assert accepted.status_code == 200, accepted.text
        viewer_headers = auth_headers(login(viewer_browser, "push-viewer@example.com"))
        conflict = _register_device(viewer_browser, viewer_headers)
        assert conflict.status_code == 409, conflict.text

        viewer_list = viewer_browser.get("/api/push/devices", headers=viewer_headers)
        assert viewer_list.status_code == 200, viewer_list.text
        assert viewer_list.json()["items"] == []

    revoked = client.delete("/api/push/devices/phone-owner-1", headers=owner_headers)
    assert revoked.status_code == 200, revoked.text
    assert revoked.json() == {"revoked": True}
    assert client.get("/api/push/devices", headers=owner_headers).json()["items"] == []


def test_push_device_mutations_require_authentication_and_csrf(client: TestClient) -> None:
    anonymous = _register_device(client, {})
    assert anonymous.status_code == 401

    bootstrap_owner(client)
    login(client)
    missing_csrf = _register_device(client, {})
    assert missing_csrf.status_code == 403


def test_device_delivery_is_created_only_for_notifications_after_registration(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client, "push-device-worker")
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}
    _create_session(client, headers, worker_id)

    _request_permission(client, worker_headers, worker_id, "permission-before-registration")
    registered = _register_device(client, headers)
    assert registered.status_code == 200, registered.text

    inspector = inspect(client.app.state.db_engine)
    assert "notification_deliveries" in inspector.get_table_names()
    with client.app.state.db_engine.connect() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM notification_deliveries")).scalar_one() == 0

    _request_permission(client, worker_headers, worker_id, "permission-after-registration")
    notification = next(
        item
        for item in client.get("/api/notifications", headers=headers).json()["items"]
        if item["source_id"] == "permission-after-registration"
    )
    web_delivery = client.post(
        f"/api/notifications/{notification['notification_id']}/delivered",
        headers=headers,
    )
    assert web_delivery.status_code == 200, web_delivery.text

    with client.app.state.db_engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT nr.source_id, nd.status "
                "FROM notification_deliveries nd "
                "JOIN notification_records nr ON nr.id = nd.notification_record_id"
            )
        ).all()
    assert rows == [("permission-after-registration", "queued")]

    revoked = client.delete("/api/push/devices/phone-owner-1", headers=headers)
    assert revoked.status_code == 200, revoked.text
    _request_permission(client, worker_headers, worker_id, "permission-after-revocation")
    with client.app.state.db_engine.connect() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM notification_deliveries")).scalar_one() == 1
