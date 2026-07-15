from __future__ import annotations

from typing import Any

import httpx

from agenthub_worker.client import AgentHubClient


def test_worker_client_disables_environment_proxy_by_default(monkeypatch) -> None:
    created: list[dict[str, Any]] = []
    calls: list[dict[str, Any]] = []

    class FakeClient:
        def __init__(self, **kwargs) -> None:
            created.append(kwargs)

        def post(self, *args, **kwargs) -> httpx.Response:
            calls.append({"args": args, "kwargs": kwargs})
            return httpx.Response(204)

        def close(self) -> None:
            return None

    monkeypatch.setattr(httpx, "Client", FakeClient)

    client = AgentHubClient("http://100.99.254.119:8019", "win-pj-redmi", "worker-token")
    assert client.claim_job() is None

    assert created == [{"timeout": 30.0, "trust_env": False}]
    assert calls[0]["kwargs"]["headers"] == {"Authorization": "Bearer worker-token"}


def test_worker_client_omits_authorization_header_when_bootstrap_token_is_empty(monkeypatch) -> None:
    created: list[dict[str, Any]] = []
    calls: list[dict[str, Any]] = []

    class FakeClient:
        def __init__(self, **kwargs) -> None:
            created.append(kwargs)

        def post(self, *args, **kwargs) -> httpx.Response:
            calls.append({"args": args, "kwargs": kwargs})
            return httpx.Response(
                200,
                request=httpx.Request("POST", "https://agenthub.example.com/api/worker/enroll"),
                json={
                    "worker": {"worker_id": "win-pj-redmi"},
                    "worker_token": "ahw_issued",
                },
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(httpx, "Client", FakeClient)

    client = AgentHubClient("https://agenthub.example.com", "win-pj-redmi", "")
    assert client.enroll({"worker_id": "win-pj-redmi"})["worker_token"] == "ahw_issued"

    assert created == [{"timeout": 30.0, "trust_env": False}]
    assert calls[0]["kwargs"]["headers"] == {}


def test_worker_client_reuses_one_http_connection_pool(monkeypatch) -> None:
    created: list[dict[str, Any]] = []
    posts: list[str] = []

    class FakeClient:
        def __init__(self, **kwargs) -> None:
            created.append(kwargs)

        def post(self, url: str, **_kwargs) -> httpx.Response:
            posts.append(url)
            return httpx.Response(204)

        def get(self, url: str, **_kwargs) -> httpx.Response:
            return httpx.Response(200, request=httpx.Request("GET", url), json={})

        def close(self) -> None:
            return None

    monkeypatch.setattr(httpx, "Client", FakeClient)
    monkeypatch.setattr(httpx, "post", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("one-shot HTTP used")))

    client = AgentHubClient("https://agenthub.example.com", "win-pj-redmi", "worker-token")
    assert client.claim_job() is None
    assert client.claim_job() is None

    assert created == [{"timeout": 30.0, "trust_env": False}]
    assert posts == [
        "https://agenthub.example.com/api/internal/jobs/claim",
        "https://agenthub.example.com/api/internal/jobs/claim",
    ]

