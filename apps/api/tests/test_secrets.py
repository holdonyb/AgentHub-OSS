from __future__ import annotations

from fastapi.testclient import TestClient

from conftest import auth_headers, bootstrap_owner, create_worker, login


def test_admin_manages_secret_metadata_without_exposing_values(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)

    created = client.post(
        "/api/secrets",
        headers=headers,
        json={
            "name": "OPENAI_API_KEY",
            "value": "sk-agenthub-test",
            "environment": "prod",
            "namespace": "default",
            "description": "生产 OpenAI-compatible endpoint",
        },
    )

    assert created.status_code == 200, created.text
    secret = created.json()["secret"]
    assert secret["name"] == "OPENAI_API_KEY"
    assert secret["environment"] == "prod"
    assert secret["namespace"] == "default"
    assert secret["description"] == "生产 OpenAI-compatible endpoint"
    assert secret["has_value"] is True
    assert "value" not in secret
    assert "sk-agenthub-test" not in created.text

    listed = client.get("/api/secrets", headers=headers)
    assert listed.status_code == 200, listed.text
    item = listed.json()["items"][0]
    assert item["name"] == "OPENAI_API_KEY"
    assert "value" not in item
    assert "sk-agenthub-test" not in listed.text


def test_worker_resolves_only_job_referenced_secrets_for_its_space(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/secrets",
        headers=headers,
        json={"name": "KIMI_API_KEY", "value": "kimi-secret", "environment": "test", "namespace": "agenthub"},
    )
    assert created.status_code == 200, created.text
    extra = client.post(
        "/api/secrets",
        headers=headers,
        json={"name": "OPENAI_API_KEY", "value": "openai-secret", "environment": "test", "namespace": "agenthub"},
    )
    assert extra.status_code == 200, extra.text

    session = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "secret-session",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/secret-session.jsonl",
            "status": "ready",
            "title": "Secrets session",
            "controls": {
                "secret_refs": ["KIMI_API_KEY"],
                "secret_environment": "test",
                "secret_namespace": "agenthub",
            },
        },
    )
    assert session.status_code == 200, session.text
    queued = client.post("/api/sessions/secret-session/input", headers=headers, json={"prompt": "use configured api"})
    assert queued.status_code == 200, queued.text
    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text
    job_id = claimed.json()["job"]["job_id"]

    resolved = client.post(
        "/api/internal/secrets/resolve",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "job_id": job_id,
            "names": ["KIMI_API_KEY"],
            "environment": "test",
            "namespace": "agenthub",
        },
    )

    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["secrets"] == {"KIMI_API_KEY": "kimi-secret"}

    disallowed = client.post(
        "/api/internal/secrets/resolve",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "job_id": job_id,
            "names": ["OPENAI_API_KEY"],
            "environment": "test",
            "namespace": "agenthub",
        },
    )
    assert disallowed.status_code == 403

    missing_job = client.post(
        "/api/internal/secrets/resolve",
        headers=worker_headers,
        json={"worker_id": worker_id, "names": ["KIMI_API_KEY"], "environment": "test", "namespace": "agenthub"},
    )
    assert missing_job.status_code == 400


def test_viewer_cannot_manage_secrets(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    invite = client.post(
        "/api/invites",
        headers=auth_headers(owner_login),
        json={"email": "viewer@example.com", "role": "viewer", "expires_in_hours": 1},
    ).json()
    client.post(
        "/api/invites/accept",
        json={
            "invite_token": invite["invite_token"],
            "email": "viewer@example.com",
            "password": "Correct Horse Battery Staple 42",
        },
    )

    with TestClient(client.app) as viewer_browser:
        viewer_login = viewer_browser.post(
            "/api/auth/login",
            headers={"X-Forwarded-For": "203.0.113.30"},
            json={"email": "viewer@example.com", "password": "Correct Horse Battery Staple 42"},
        ).json()
        forbidden = viewer_browser.post(
            "/api/secrets",
            headers=auth_headers(viewer_login),
            json={"name": "OPENAI_API_KEY", "value": "sk-nope"},
        )

    assert forbidden.status_code == 403
