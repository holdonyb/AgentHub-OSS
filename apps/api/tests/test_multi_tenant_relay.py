from __future__ import annotations

from fastapi.testclient import TestClient

from conftest import auth_headers, bootstrap_owner, create_worker, login


def test_owner_bootstrap_returns_default_space(client: TestClient) -> None:
    payload = bootstrap_owner(client)
    assert payload["space"]["space_id"]
    assert payload["space"]["role"] == "owner"


def test_space_scoped_token_is_only_visible_in_active_space(client: TestClient) -> None:
    owner = bootstrap_owner(client)
    owner_headers = auth_headers(owner)
    created = client.post("/api/tokens", json={"name": "space-cli"}, headers=owner_headers)
    assert created.status_code == 200, created.text
    listed = client.get("/api/tokens", headers=owner_headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["space_id"] == owner["space"]["space_id"]


def test_public_relay_enrollment_registers_worker_inside_space(client: TestClient) -> None:
    owner = bootstrap_owner(client)
    owner_headers = auth_headers(owner)
    enrollment = client.post(
        "/api/worker-enrollments",
        json={"label": "office relay", "expires_in_hours": 2},
        headers=owner_headers,
    )
    assert enrollment.status_code == 200, enrollment.text

    enroll_response = client.post(
        "/api/worker/enroll",
        json={
            "enrollment_token": enrollment.json()["enrollment_token"],
            "worker_id": "relay-win-01",
            "machine_name": "RelayBox",
            "os": "windows",
            "connection_mode": "public_relay",
            "transport_state": "polling",
            "reachable_backends": ["codex", "kimi"],
            "workspace_roots": ["C:/Work"],
            "capabilities": {"codex": True, "kimi": True},
        },
    )
    assert enroll_response.status_code == 200, enroll_response.text
    worker = enroll_response.json()["worker"]
    assert worker["space_id"] == owner["space"]["space_id"]
    assert worker["connection_mode"] == "public_relay"

    listed = client.get("/api/workers", headers=owner_headers)
    assert listed.status_code == 200, listed.text
    assert any(item["worker_id"] == "relay-win-01" for item in listed.json()["items"])


def test_private_enrollment_registers_worker_inside_space(client: TestClient) -> None:
    owner = bootstrap_owner(client)
    owner_headers = auth_headers(owner)
    enrollment = client.post(
        "/api/worker-enrollments",
        json={"label": "private office", "expires_in_hours": 2},
        headers=owner_headers,
    )
    assert enrollment.status_code == 200, enrollment.text

    enroll_response = client.post(
        "/api/worker/enroll",
        json={
            "enrollment_token": enrollment.json()["enrollment_token"],
            "worker_id": "private-win-01",
            "machine_name": "PrivateBox",
            "os": "windows",
            "connection_mode": "private",
            "transport_state": "polling",
            "reachable_backends": ["codex", "claude"],
            "workspace_roots": ["C:/Work"],
            "capabilities": {"codex": True, "claude": True},
        },
    )
    assert enroll_response.status_code == 200, enroll_response.text
    worker = enroll_response.json()["worker"]
    assert worker["space_id"] == owner["space"]["space_id"]
    assert worker["connection_mode"] == "private"


def test_public_relay_worker_can_heartbeat_and_claim_jobs(client: TestClient) -> None:
    owner = bootstrap_owner(client)
    owner_headers = auth_headers(owner)
    enrollment = client.post(
        "/api/worker-enrollments",
        json={"label": "public relay", "expires_in_hours": 2},
        headers=owner_headers,
    )
    worker = client.post(
        "/api/worker/enroll",
        json={
            "enrollment_token": enrollment.json()["enrollment_token"],
            "worker_id": "relay-linux-01",
            "machine_name": "RelayLinux",
            "os": "linux",
            "connection_mode": "public_relay",
            "transport_state": "polling",
            "reachable_backends": ["codex"],
            "workspace_roots": ["/srv/work"],
            "capabilities": {"codex": True},
        },
    ).json()
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    heartbeat = client.post(
        "/api/worker/heartbeat",
        headers=worker_headers,
        json={
            "status": "online",
            "transport_state": "polling",
            "worker_version": "1.0.0",
            "reachable_backends": ["codex"],
            "workspace_roots": ["/srv/work"],
            "capabilities": {"codex": True},
        },
    )
    assert heartbeat.status_code == 200, heartbeat.text
    assert heartbeat.json()["worker"]["worker_version"] == "1.0.0"

    job = client.post(
        "/api/sessions/start",
        headers=owner_headers,
        json={
            "worker_id": "relay-linux-01",
            "backend": "codex",
            "workspace_root": "/srv/work",
            "namespace": "default",
            "prompt": "open a relay-backed session",
        },
    )
    assert job.status_code == 200, job.text

    claimed = client.post("/api/worker/jobs/claim", headers=worker_headers, json={})
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["worker_id"] == "relay-linux-01"


def test_public_relay_worker_can_publish_provider_snapshots(client: TestClient) -> None:
    owner = bootstrap_owner(client)
    owner_headers = auth_headers(owner)
    enrollment = client.post(
        "/api/worker-enrollments",
        json={"label": "public relay providers", "expires_in_hours": 2},
        headers=owner_headers,
    )
    worker = client.post(
        "/api/worker/enroll",
        json={
            "enrollment_token": enrollment.json()["enrollment_token"],
            "worker_id": "relay-providers-01",
            "machine_name": "RelayProviders",
            "os": "windows",
            "connection_mode": "public_relay",
            "transport_state": "polling",
            "reachable_backends": ["codex", "kimi"],
            "workspace_roots": ["E:/Work"],
            "capabilities": {"codex": True, "kimi": True},
        },
    ).json()
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    published = client.post(
        "/api/worker/providers/snapshot",
        headers=worker_headers,
        json={
            "worker_id": "relay-providers-01",
            "providers": [
                {
                    "backend": "kimi",
                    "status": "ready",
                    "auth_status": "ready",
                    "models": [{"id": "kimi-k2.5", "label": "kimi-k2.5"}],
                    "modes": [{"id": "thinking", "label": "thinking", "kind": "thinking"}],
                    "features": {"agent": True},
                    "diagnostics": {"version": "kimi 1.0"},
                }
            ],
        },
    )
    assert published.status_code == 200, published.text
    assert published.json()["items"][0]["backend"] == "kimi"

    listed = client.get("/api/providers", headers=owner_headers)
    assert listed.status_code == 200, listed.text
    item = listed.json()["items"][0]
    assert item["worker_id"] == "relay-providers-01"
    assert item["auth_status"] == "ready"
    assert item["features"]["agent"] is True


def test_space_filter_hides_other_users_resources(client: TestClient) -> None:
    owner = bootstrap_owner(client)
    owner_headers = auth_headers(owner)
    worker = create_worker(client, "tenant-win-main")

    session_created = client.post(
        "/api/sessions",
        json={
            "session_id": "tenant-session",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/tenant-session",
            "status": "ready",
        },
        headers=owner_headers,
    )
    assert session_created.status_code == 200, session_created.text

    invite = client.post(
        "/api/invites",
        json={"email": "viewer@example.com", "role": "viewer", "expires_in_hours": 2},
        headers=owner_headers,
    )
    assert invite.status_code == 200, invite.text
    accepted = client.post(
        "/api/invites/accept",
        json={
            "invite_token": invite.json()["invite_token"],
            "email": "viewer@example.com",
            "password": "Correct Horse Battery Staple 42",
        },
    )
    assert accepted.status_code == 200, accepted.text

    with TestClient(client.app) as viewer_browser:
        viewer = viewer_browser.post(
            "/api/auth/login",
            json={"email": "viewer@example.com", "password": "Correct Horse Battery Staple 42"},
            headers={"X-Forwarded-For": "203.0.113.55"},
        ).json()
        viewer_sessions = viewer_browser.get("/api/sessions", headers=auth_headers(viewer))
        assert viewer_sessions.status_code == 200, viewer_sessions.text
        assert any(item["session_id"] == "tenant-session" for item in viewer_sessions.json()["items"])
