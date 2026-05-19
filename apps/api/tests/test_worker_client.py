from __future__ import annotations

from typing import Any

import httpx

from agenthub_worker.client import AgentHubClient


def test_worker_client_disables_environment_proxy_by_default(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []

    def fake_post(*args, **kwargs) -> httpx.Response:
        calls.append({"args": args, "kwargs": kwargs})
        return httpx.Response(204)

    monkeypatch.setattr(httpx, "post", fake_post)

    client = AgentHubClient("http://100.99.254.119:8019", "win-pj-redmi", "worker-token")
    assert client.claim_job() is None

    assert calls[0]["kwargs"]["trust_env"] is False
    assert calls[0]["kwargs"]["headers"] == {"Authorization": "Bearer worker-token"}


def test_worker_client_omits_authorization_header_when_bootstrap_token_is_empty(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []

    def fake_post(*args, **kwargs) -> httpx.Response:
        calls.append({"args": args, "kwargs": kwargs})
        return httpx.Response(
            200,
            request=httpx.Request("POST", "https://agenthub.example.com/api/worker/enroll"),
            json={
                "worker": {"worker_id": "win-pj-redmi"},
                "worker_token": "ahw_issued",
            },
        )

    monkeypatch.setattr(httpx, "post", fake_post)

    client = AgentHubClient("https://agenthub.example.com", "win-pj-redmi", "")
    assert client.enroll({"worker_id": "win-pj-redmi"})["worker_token"] == "ahw_issued"

    assert calls[0]["kwargs"]["trust_env"] is False
    assert calls[0]["kwargs"]["headers"] == {}

