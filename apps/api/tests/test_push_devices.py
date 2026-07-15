from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

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

        rotated = _register_device(
            viewer_browser,
            viewer_headers,
            device_id="phone-viewer-1",
            push_token="ExponentPushToken[rotated-owner-device-token]",
        )
        assert rotated.status_code == 200, rotated.text
        assert [
            item["device_id"]
            for item in viewer_browser.get("/api/push/devices", headers=viewer_headers).json()["items"]
        ] == ["phone-viewer-1"]

    assert client.get("/api/push/devices", headers=owner_headers).json()["items"] == []
    with client.app.state.SessionLocal() as db:
        from app.models import PushDevice

        old_device = db.query(PushDevice).filter(PushDevice.device_id == "phone-owner-1").one()
        assert old_device.enabled is False
        assert old_device.push_token == ""

    revoked = client.delete("/api/push/devices/phone-owner-1", headers=owner_headers)
    assert revoked.status_code == 200, revoked.text
    assert revoked.json() == {"revoked": True}
    assert client.get("/api/push/devices", headers=owner_headers).json()["items"] == []

    with TestClient(client.app) as viewer_browser:
        viewer_headers = auth_headers(login(viewer_browser, "push-viewer@example.com"))
        reassigned = _register_device(viewer_browser, viewer_headers)
        assert reassigned.status_code == 200, reassigned.text
        assert reassigned.json()["device"]["enabled"] is True


def test_push_device_mutations_require_authentication_and_csrf(client: TestClient) -> None:
    anonymous = _register_device(client, {})
    assert anonymous.status_code == 401

    bootstrap_owner(client)
    login(client)
    missing_csrf = _register_device(client, {})
    assert missing_csrf.status_code == 403


def test_concurrent_device_registration_recovers_as_an_idempotent_upsert(
    client: TestClient,
    monkeypatch,
) -> None:
    from app.core.deps import Actor
    from app.models import PushDevice, SpaceMembership, User, utcnow
    from app.routers.push_devices import upsert_push_device
    from app.schemas import PushDeviceUpsertIn

    bootstrap_owner(client)
    owner_login = login(client)
    space_id = owner_login["space"]["space_id"]
    with client.app.state.SessionLocal() as db:
        user = db.query(User).filter(User.email == "owner@example.com").one()
        membership = (
            db.query(SpaceMembership)
            .filter(SpaceMembership.space_id == space_id, SpaceMembership.user_id == user.id)
            .one()
        )
        actor = Actor(
            "user",
            user.id,
            "cookie",
            user=user,
            space_id=space_id,
            space_role="owner",
            space_membership=membership,
        )
        real_commit = db.commit
        raced = False

        def racing_commit() -> None:
            nonlocal raced
            if not raced:
                raced = True
                now = utcnow()
                with client.app.state.SessionLocal() as competing_db:
                    competing_db.add(
                        PushDevice(
                            device_id="phone-racing-1",
                            space_id=space_id,
                            user_id=user.id,
                            platform="android",
                            transport="expo",
                            push_token="ExponentPushToken[competing-token]",
                            app_version="0.9.0",
                            created_at=now,
                            updated_at=now,
                            last_seen_at=now,
                        )
                    )
                    competing_db.commit()
                raise IntegrityError("INSERT push_devices", {}, Exception("unique device_id"))
            real_commit()

        monkeypatch.setattr(db, "commit", racing_commit)
        response = upsert_push_device(
            PushDeviceUpsertIn(
                device_id="phone-racing-1",
                platform="android",
                transport="expo",
                push_token="ExponentPushToken[winning-token]",
                app_version="1.0.0",
            ),
            db,
            actor,
        )

        assert response["device"]["device_id"] == "phone-racing-1"
        device = db.query(PushDevice).filter(PushDevice.device_id == "phone-racing-1").one()
        assert device.push_token == "ExponentPushToken[winning-token]"
        assert device.app_version == "1.0.0"


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
    with client.app.state.db_engine.connect() as connection:
        assert connection.execute(text("SELECT status FROM notification_deliveries")).scalar_one() == "disabled"

    _request_permission(client, worker_headers, worker_id, "permission-after-revocation")
    with client.app.state.db_engine.connect() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM notification_deliveries")).scalar_one() == 1

    reactivated = _register_device(
        client,
        headers,
        push_token="ExponentPushToken[reactivated-owner-device-token]",
    )
    assert reactivated.status_code == 200, reactivated.text
    _request_permission(client, worker_headers, worker_id, "permission-after-reactivation")
    with client.app.state.db_engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT nr.source_id, nd.status "
                "FROM notification_deliveries nd "
                "JOIN notification_records nr ON nr.id = nd.notification_record_id "
                "ORDER BY nr.source_id"
            )
        ).all()
    assert rows == [
        ("permission-after-reactivation", "queued"),
        ("permission-after-registration", "disabled"),
    ]


def test_logout_atomically_revokes_the_current_push_device(client: TestClient) -> None:
    from app.models import NotificationDelivery, PushDevice

    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    registered = _register_device(
        client,
        headers,
        device_id="phone-logout-1",
        push_token="ExponentPushToken[logout-token]",
    )
    assert registered.status_code == 200, registered.text
    worker = create_worker(client, "push-logout-worker")
    worker_id = worker["worker"]["worker_id"]
    _create_session(client, headers, worker_id)
    _request_permission(
        client,
        {"Authorization": f"Bearer {worker['worker_token']}"},
        worker_id,
        "permission-before-logout",
    )

    logged_out = client.post(
        "/api/auth/logout",
        json={"device_id": "phone-logout-1"},
        headers=headers,
    )
    assert logged_out.status_code == 200, logged_out.text

    with client.app.state.SessionLocal() as db:
        device = db.query(PushDevice).filter(PushDevice.device_id == "phone-logout-1").one()
        assert device.enabled is False
        assert device.push_token == ""
        assert device.revoked_at is not None
        assert db.query(NotificationDelivery).one().status == "disabled"
