from __future__ import annotations

from contextlib import contextmanager
import hashlib
from pathlib import Path
from typing import Any

import httpx
import pytest

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


def test_worker_client_encodes_unicode_transfer_filename_header(monkeypatch, tmp_path: Path) -> None:
    captured_headers: dict[str, str] = {}

    class FakeClient:
        def __init__(self, **_kwargs) -> None:
            pass

        def put(self, url: str, **kwargs) -> httpx.Response:
            captured_headers.update(kwargs["headers"])
            return httpx.Response(
                200,
                request=httpx.Request("PUT", url),
                json={"transfer": {"transfer_id": "xfr-test"}},
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(httpx, "Client", FakeClient)
    source = tmp_path / "设计 %.png"
    source.write_bytes(b"png")
    client = AgentHubClient("https://agenthub.example.com", "win-pj-redmi", "worker-token")

    client.upload_transfer(
        "xfr-test",
        source,
        content_type="image/png",
        filename=source.name,
        modified_at="2026-07-17T01:00:00Z",
    )

    assert captured_headers["X-AgentHub-Filename"] == "%E8%AE%BE%E8%AE%A1%20%25.png"


def test_worker_client_rejects_transfer_with_wrong_server_checksum(monkeypatch, tmp_path: Path) -> None:
    expected = hashlib.sha256(b"expected bytes").hexdigest()

    class FakeClient:
        def __init__(self, **_kwargs) -> None:
            pass

        @contextmanager
        def stream(self, method: str, url: str, **_kwargs):
            yield httpx.Response(
                200,
                request=httpx.Request(method, url),
                headers={"X-AgentHub-SHA256": expected},
                content=b"tampered bytes",
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(httpx, "Client", FakeClient)
    destination = tmp_path / "download.part"
    client = AgentHubClient("https://agenthub.example.com", "win-pj-redmi", "worker-token")

    with pytest.raises(ValueError, match="checksum"):
        client.download_transfer("xfr-test", destination)

    assert not destination.exists()


@pytest.mark.parametrize("checksum", ["", "not-a-sha256"])
def test_worker_client_rejects_transfer_without_valid_server_checksum(
    monkeypatch,
    tmp_path: Path,
    checksum: str,
) -> None:
    class FakeClient:
        def __init__(self, **_kwargs) -> None:
            pass

        @contextmanager
        def stream(self, method: str, url: str, **_kwargs):
            headers = {"X-AgentHub-SHA256": checksum} if checksum else {}
            yield httpx.Response(
                200,
                request=httpx.Request(method, url),
                headers=headers,
                content=b"downloaded bytes",
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(httpx, "Client", FakeClient)
    destination = tmp_path / "download.part"
    client = AgentHubClient("https://agenthub.example.com", "win-pj-redmi", "worker-token")

    with pytest.raises(ValueError, match="checksum"):
        client.download_transfer("xfr-test", destination)

    assert not destination.exists()

