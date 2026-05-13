from __future__ import annotations

from fastapi.testclient import TestClient

from conftest import auth_headers, bootstrap_owner, create_worker, login


def test_bootstrap_creates_owner_once_and_hashes_password(client: TestClient) -> None:
    payload = bootstrap_owner(client)

    assert payload["user"]["role"] == "owner"
    second = client.post(
        "/api/auth/bootstrap",
        json={
            "bootstrap_token": "bootstrap-test-token",
            "email": "second@example.com",
            "password": "Correct Horse Battery Staple 42",
        },
    )
    assert second.status_code == 409

    from app.models import User

    with client.app.state.SessionLocal() as db:
        user = db.query(User).filter(User.email == "owner@example.com").one()
        assert user.password_hash != "Correct Horse Battery Staple 42"
        assert user.password_hash.startswith("$argon2id$")


def test_login_is_rate_limited_and_cookie_mutations_require_csrf(client: TestClient) -> None:
    bootstrap_owner(client)

    for _ in range(3):
        response = client.post(
            "/api/auth/login",
            json={"email": "owner@example.com", "password": "wrong-password"},
        )
        assert response.status_code == 401
    limited = client.post(
        "/api/auth/login",
        json={"email": "owner@example.com", "password": "wrong-password"},
    )
    assert limited.status_code == 429

    # A fresh client gets its own rate-limit bucket.
    with TestClient(client.app) as browser:
        login_payload = browser.post(
            "/api/auth/login",
            json={"email": "owner@example.com", "password": "Correct Horse Battery Staple 42"},
            headers={"X-Forwarded-For": "203.0.113.10"},
        )
        assert login_payload.status_code == 200, login_payload.text

        blocked = browser.post("/api/jobs", json={"kind": "health_check"})
        assert blocked.status_code == 403

        allowed = browser.post(
            "/api/jobs",
            json={"kind": "health_check", "namespace": "default", "payload": {}},
            headers={"X-CSRF-Token": login_payload.json()["csrf_token"]},
        )
        assert allowed.status_code == 200, allowed.text


def test_worker_token_cannot_call_web_api_and_user_token_cannot_call_internal_api(client: TestClient) -> None:
    bootstrap_owner(client)
    user_login = login(client)
    worker = create_worker(client)

    worker_web = client.get(
        "/api/sessions",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
    )
    assert worker_web.status_code == 403

    token_response = client.post(
        "/api/tokens",
        json={"name": "cli"},
        headers=auth_headers(user_login),
    )
    assert token_response.status_code == 200, token_response.text
    user_token = token_response.json()["token"]

    user_internal = client.post(
        "/api/internal/jobs/claim",
        json={"worker_id": worker["worker"]["worker_id"]},
        headers={"Authorization": f"Bearer {user_token}"},
    )
    assert user_internal.status_code == 403


def test_invites_expire_and_cannot_be_reused(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)

    invite_response = client.post(
        "/api/invites",
        json={"email": "viewer@example.com", "role": "viewer", "expires_in_hours": 1},
        headers=auth_headers(owner_login),
    )
    assert invite_response.status_code == 200, invite_response.text
    invite_token = invite_response.json()["invite_token"]

    with TestClient(client.app) as invitee_browser:
        accepted = invitee_browser.post(
            "/api/invites/accept",
            json={
                "invite_token": invite_token,
                "email": "viewer@example.com",
                "password": "Correct Horse Battery Staple 42",
            },
        )
        assert accepted.status_code == 200, accepted.text

        reused = invitee_browser.post(
            "/api/invites/accept",
            json={
                "invite_token": invite_token,
                "email": "viewer@example.com",
                "password": "Correct Horse Battery Staple 42",
            },
        )
        assert reused.status_code == 400

    expired = client.post(
        "/api/invites",
        json={"email": "late@example.com", "role": "viewer", "expires_in_hours": -1},
        headers=auth_headers(owner_login),
    )
    assert expired.status_code == 200, expired.text
    expired_accept = client.post(
        "/api/invites/accept",
        json={
            "invite_token": expired.json()["invite_token"],
            "email": "late@example.com",
            "password": "Correct Horse Battery Staple 42",
        },
    )
    assert expired_accept.status_code == 400
