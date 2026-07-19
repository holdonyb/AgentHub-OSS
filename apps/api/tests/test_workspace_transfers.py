from __future__ import annotations

import asyncio
from datetime import timedelta
import hashlib
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from app.core.file_transfer_cleanup import FileTransferCleanupWorker
from app.models import FileTransfer, utcnow
from app.routers import workspace_files
from app.routers.workspace_files import _receive_transfer_content
from conftest import auth_headers, bootstrap_owner, login


def _register_transfer_worker(client: TestClient, worker_id: str) -> dict:
    response = client.post(
        "/api/workers/register",
        headers={"Authorization": "Bearer worker-register-test-token"},
        json={
            "worker_id": worker_id,
            "machine_name": "TransferBox",
            "os": "linux",
            "reachable_backends": ["codex"],
            "workspace_roots": ["/srv/work"],
            "capabilities": {"file_transfer_v2": True},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_worker_can_stream_transfer_and_user_can_read_ranges(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = _register_transfer_worker(client, "transfer-linux")
    user_headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/workspaces/files/transfers",
        headers=user_headers,
        json={
            "worker_id": "transfer-linux",
            "workspace_root": "/srv/work",
            "path": "images/diagram.png",
        },
    )
    assert created.status_code == 200, created.text
    ticket = created.json()["transfer"]
    transfer_id = ticket["transfer_id"]
    assert ticket["status"] == "queued"
    assert ticket["content_url"] == f"/api/workspaces/files/transfers/{transfer_id}/content"

    claimed = client.post(
        "/api/internal/jobs/claim",
        headers=worker_headers,
        json={"worker_id": "transfer-linux"},
    )
    assert claimed.status_code == 200, claimed.text
    job = claimed.json()["job"]
    assert job["kind"] == "file_transfer_prepare"
    assert job["payload"] == {"path": "images/diagram.png", "transfer_id": transfer_id}

    uploaded = client.put(
        f"/api/internal/transfers/{transfer_id}/content",
        headers={
            **worker_headers,
            "Content-Type": "image/png",
            "X-AgentHub-Filename": "%E8%AE%BE%E8%AE%A1%20%25.png",
            "X-AgentHub-Modified-At": "2026-07-17T01:00:00Z",
        },
        content=b"0123456789",
    )
    assert uploaded.status_code == 200, uploaded.text
    assert uploaded.json()["transfer"]["status"] == "ready"

    detail = client.get(f"/api/workspaces/files/transfers/{transfer_id}", headers=user_headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["transfer"]["size_bytes"] == 10
    assert detail.json()["transfer"]["filename"] == "设计 %.png"

    partial = client.get(
        f"/api/workspaces/files/transfers/{transfer_id}/content",
        headers={**user_headers, "Range": "bytes=2-5"},
    )
    assert partial.status_code == 206, partial.text
    assert partial.content == b"2345"
    assert partial.headers["content-range"] == "bytes 2-5/10"
    assert partial.headers["cache-control"] == "private, no-store"
    assert partial.headers["content-encoding"] == "identity"
    assert partial.headers["content-disposition"].startswith("inline;")
    assert partial.headers["x-agenthub-sha256"] == hashlib.sha256(b"0123456789").hexdigest()


def test_user_can_issue_a_short_lived_download_ticket_for_native_streaming(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = _register_transfer_worker(client, "transfer-native-download")
    user_headers = auth_headers(owner_login)
    created = client.post(
        "/api/workspaces/files/transfers",
        headers=user_headers,
        json={"worker_id": "transfer-native-download", "workspace_root": "/srv/work", "path": "reports/result.pdf"},
    )
    transfer_id = created.json()["transfer"]["transfer_id"]
    uploaded = client.put(
        f"/api/internal/transfers/{transfer_id}/content",
        headers={
            "Authorization": f"Bearer {worker['worker_token']}",
            "Content-Type": "application/pdf",
            "X-AgentHub-Filename": "result.pdf",
        },
        content=b"native-download",
    )
    assert uploaded.status_code == 200, uploaded.text

    ticket = client.post(
        f"/api/workspaces/files/transfers/{transfer_id}/download-ticket",
        headers=user_headers,
    )

    assert ticket.status_code == 200, ticket.text
    download_url = ticket.json()["download_url"]
    assert download_url.startswith(f"/api/workspaces/files/transfers/{transfer_id}/download?")
    downloaded = client.get(download_url)
    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.content == b"native-download"
    assert downloaded.headers["content-disposition"].startswith("attachment;")

    tampered = client.get(download_url.replace("signature=", "signature=0"))
    assert tampered.status_code == 403
    assert tampered.json()["detail"]["code"] == "TRANSFER_TICKET_INVALID"


def test_declared_oversized_transfer_is_marked_failed_after_claim(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = _register_transfer_worker(client, "transfer-too-large")
    user_headers = auth_headers(owner_login)

    created = client.post(
        "/api/workspaces/files/upload-transfers",
        headers=user_headers,
        json={
            "worker_id": "transfer-too-large",
            "workspace_root": "/srv/work",
            "path": ".",
            "filename": "large.bin",
            "content_type": "application/octet-stream",
        },
    )
    transfer_id = created.json()["transfer"]["transfer_id"]
    client.app.state.settings.max_file_transfer_bytes = 8

    response = client.put(
        f"/api/workspaces/files/transfers/{transfer_id}/content",
        headers={**user_headers, "Content-Type": "application/octet-stream", "Content-Length": "9"},
        content=b"123456789",
    )

    assert response.status_code == 413, response.text
    assert response.json()["detail"]["code"] == "TRANSFER_TOO_LARGE"
    with client.app.state.SessionLocal() as db:
        transfer = db.query(FileTransfer).filter(FileTransfer.transfer_id == transfer_id).one()
        assert transfer.status == "failed"


def test_active_content_transfer_is_forced_to_download(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = _register_transfer_worker(client, "transfer-active-content")
    user_headers = auth_headers(owner_login)

    created = client.post(
        "/api/workspaces/files/transfers",
        headers=user_headers,
        json={"worker_id": "transfer-active-content", "workspace_root": "/srv/work", "path": "preview.svg"},
    )
    transfer_id = created.json()["transfer"]["transfer_id"]
    uploaded = client.put(
        f"/api/internal/transfers/{transfer_id}/content",
        headers={
            "Authorization": f"Bearer {worker['worker_token']}",
            "Content-Type": "image/svg+xml",
            "X-AgentHub-Filename": "preview.svg",
        },
        content=b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )
    assert uploaded.status_code == 200, uploaded.text

    downloaded = client.get(f"/api/workspaces/files/transfers/{transfer_id}/content", headers=user_headers)

    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.headers["content-disposition"].startswith("attachment;")
    assert downloaded.headers["content-security-policy"] == "sandbox; default-src 'none'"


def test_transfer_storage_setup_failure_marks_claim_failed(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    _register_transfer_worker(client, "transfer-storage-failure")
    user_headers = auth_headers(owner_login)
    created = client.post(
        "/api/workspaces/files/upload-transfers",
        headers=user_headers,
        json={
            "worker_id": "transfer-storage-failure",
            "workspace_root": "/srv/work",
            "path": ".",
            "filename": "notes.txt",
            "content_type": "text/plain",
        },
    )
    transfer_id = created.json()["transfer"]["transfer_id"]

    def fail_storage(*_args, **_kwargs):
        raise OSError("transfer directory unavailable")

    monkeypatch.setattr(workspace_files, "_transfer_storage_path", fail_storage)

    with pytest.raises(OSError, match="transfer directory unavailable"):
        client.put(
            f"/api/workspaces/files/transfers/{transfer_id}/content",
            headers={**user_headers, "Content-Type": "text/plain"},
            content=b"hello",
        )

    with client.app.state.SessionLocal() as db:
        transfer = db.query(FileTransfer).filter(FileTransfer.transfer_id == transfer_id).one()
        assert transfer.status == "failed"


def test_transfer_content_cors_preflight_allows_put(client: TestClient) -> None:
    response = client.options(
        "/api/workspaces/files/transfers/example/content",
        headers={
            "Origin": "http://localhost:43073",
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "content-type,x-csrf-token",
        },
    )

    assert response.status_code == 200, response.text
    assert "PUT" in response.headers["access-control-allow-methods"]


def test_sensitive_transfer_preserves_explicit_reveal_for_the_worker(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = _register_transfer_worker(client, "transfer-sensitive")

    created = client.post(
        "/api/workspaces/files/transfers",
        headers=auth_headers(owner_login),
        json={
            "worker_id": "transfer-sensitive",
            "workspace_root": "/srv/work",
            "path": ".env.production",
            "reveal_sensitive": True,
        },
    )
    assert created.status_code == 200, created.text

    events = client.get("/api/events", headers=auth_headers(owner_login)).json()["items"]
    reveal_event = next(event for event in events if event["event_type"] == "workspace.transfer.create")
    assert reveal_event["payload"]["reveal_sensitive"] is True

    claimed = client.post(
        "/api/internal/jobs/claim",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={"worker_id": "transfer-sensitive"},
    )

    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["payload"]["reveal_sensitive"] is True


def test_transfer_upload_rejects_another_worker(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    _register_transfer_worker(client, "transfer-owner")
    other = _register_transfer_worker(client, "transfer-other")

    created = client.post(
        "/api/workspaces/files/transfers",
        headers=auth_headers(owner_login),
        json={"worker_id": "transfer-owner", "workspace_root": "/srv/work", "path": "secret.env"},
    )
    transfer_id = created.json()["transfer"]["transfer_id"]

    uploaded = client.put(
        f"/api/internal/transfers/{transfer_id}/content",
        headers={"Authorization": f"Bearer {other['worker_token']}"},
        content=b"not allowed",
    )

    assert uploaded.status_code == 403, uploaded.text
    assert uploaded.json()["detail"]["code"] == "TRANSFER_WORKER_MISMATCH"


def test_expired_transfer_cannot_be_downloaded(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = _register_transfer_worker(client, "transfer-expiry")
    user_headers = auth_headers(owner_login)

    created = client.post(
        "/api/workspaces/files/transfers",
        headers=user_headers,
        json={"worker_id": "transfer-expiry", "workspace_root": "/srv/work", "path": "old.png"},
    )
    transfer_id = created.json()["transfer"]["transfer_id"]
    client.put(
        f"/api/internal/transfers/{transfer_id}/content",
        headers={"Authorization": f"Bearer {worker['worker_token']}", "Content-Type": "image/png"},
        content=b"old",
    )
    with client.app.state.SessionLocal() as db:
        transfer = db.query(FileTransfer).filter(FileTransfer.transfer_id == transfer_id).one()
        transfer.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()

    response = client.get(f"/api/workspaces/files/transfers/{transfer_id}/content", headers=user_headers)

    assert response.status_code == 410, response.text
    assert response.json()["detail"]["code"] == "TRANSFER_EXPIRED"


def test_creating_a_transfer_cleans_expired_temp_files(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = _register_transfer_worker(client, "transfer-cleanup")
    user_headers = auth_headers(owner_login)
    created = client.post(
        "/api/workspaces/files/transfers",
        headers=user_headers,
        json={"worker_id": "transfer-cleanup", "workspace_root": "/srv/work", "path": "old.bin"},
    )
    transfer_id = created.json()["transfer"]["transfer_id"]
    uploaded = client.put(
        f"/api/internal/transfers/{transfer_id}/content",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        content=b"expired content",
    )
    assert uploaded.status_code == 200, uploaded.text
    with client.app.state.SessionLocal() as db:
        transfer = db.query(FileTransfer).filter(FileTransfer.transfer_id == transfer_id).one()
        old_path = Path(transfer.temp_path)
        transfer.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert old_path.is_file()

    next_transfer = client.post(
        "/api/workspaces/files/transfers",
        headers=user_headers,
        json={"worker_id": "transfer-cleanup", "workspace_root": "/srv/work", "path": "next.bin"},
    )

    assert next_transfer.status_code == 200, next_transfer.text
    assert not old_path.exists()
    with client.app.state.SessionLocal() as db:
        transfer = db.query(FileTransfer).filter(FileTransfer.transfer_id == transfer_id).one()
        assert transfer.status == "expired"
        assert transfer.temp_path == ""


def test_cleanup_worker_removes_expired_temp_files_without_another_request(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = _register_transfer_worker(client, "transfer-background-cleanup")
    created = client.post(
        "/api/workspaces/files/transfers",
        headers=auth_headers(owner_login),
        json={
            "worker_id": "transfer-background-cleanup",
            "workspace_root": "/srv/work",
            "path": "old.bin",
        },
    )
    transfer_id = created.json()["transfer"]["transfer_id"]
    uploaded = client.put(
        f"/api/internal/transfers/{transfer_id}/content",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        content=b"expired content",
    )
    assert uploaded.status_code == 200, uploaded.text
    with client.app.state.SessionLocal() as db:
        transfer = db.query(FileTransfer).filter(FileTransfer.transfer_id == transfer_id).one()
        old_path = Path(transfer.temp_path)
        orphan_part = old_path.with_name(f".{transfer_id}.crash.part")
        orphan_part.write_bytes(b"partial")
        transfer.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert old_path.is_file()
    assert orphan_part.is_file()

    cleanup = FileTransferCleanupWorker(
        client.app.state.SessionLocal,
        interval_seconds=60,
        storage_dir=client.app.state.settings.file_transfer_dir,
    )

    assert cleanup.run_once() == 1
    assert not old_path.exists()
    assert not orphan_part.exists()
    with client.app.state.SessionLocal() as db:
        transfer = db.query(FileTransfer).filter(FileTransfer.transfer_id == transfer_id).one()
        assert transfer.status == "expired"
        assert transfer.temp_path == ""


def test_interrupted_transfer_removes_partial_content_and_marks_failure(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    _register_transfer_worker(client, "transfer-interrupted")
    created = client.post(
        "/api/workspaces/files/transfers",
        headers=auth_headers(owner_login),
        json={"worker_id": "transfer-interrupted", "workspace_root": "/srv/work", "path": "partial.bin"},
    )
    transfer_id = created.json()["transfer"]["transfer_id"]

    class InterruptedRequest:
        app = client.app
        headers: dict[str, str] = {}

        async def stream(self):
            yield b"partial bytes"
            raise RuntimeError("connection dropped")

    with client.app.state.SessionLocal() as db:
        transfer = db.query(FileTransfer).filter(FileTransfer.transfer_id == transfer_id).one()
        with pytest.raises(RuntimeError, match="connection dropped"):
            asyncio.run(
                _receive_transfer_content(
                    InterruptedRequest(),
                    db,
                    transfer,
                    filename="partial.bin",
                    modified_at="",
                )
            )
        db.refresh(transfer)
        assert transfer.status == "failed"

    transfer_dir = Path(client.app.state.settings.file_transfer_dir)
    assert not list(transfer_dir.glob(f"*{transfer_id}*.part"))


def test_interrupted_transfer_preserves_original_error_when_partial_cleanup_fails(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    _register_transfer_worker(client, "transfer-cleanup-locked")
    created = client.post(
        "/api/workspaces/files/transfers",
        headers=auth_headers(owner_login),
        json={"worker_id": "transfer-cleanup-locked", "workspace_root": "/srv/work", "path": "partial.bin"},
    )
    transfer_id = created.json()["transfer"]["transfer_id"]

    class InterruptedRequest:
        app = client.app
        headers: dict[str, str] = {}

        async def stream(self):
            yield b"partial bytes"
            raise RuntimeError("connection dropped")

    original_unlink = Path.unlink

    def fail_partial_cleanup(path: Path, *args, **kwargs):
        if path.name.startswith(f".{transfer_id}.") and path.name.endswith(".part"):
            raise OSError("file is locked")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_partial_cleanup)

    with client.app.state.SessionLocal() as db:
        transfer = db.query(FileTransfer).filter(FileTransfer.transfer_id == transfer_id).one()
        with pytest.raises(RuntimeError, match="connection dropped"):
            asyncio.run(
                _receive_transfer_content(
                    InterruptedRequest(),
                    db,
                    transfer,
                    filename="partial.bin",
                    modified_at="",
                )
            )
        db.refresh(transfer)
        assert transfer.status == "failed"


def test_empty_transfer_downloads_as_an_empty_file(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = _register_transfer_worker(client, "transfer-empty")
    user_headers = auth_headers(owner_login)
    created = client.post(
        "/api/workspaces/files/transfers",
        headers=user_headers,
        json={"worker_id": "transfer-empty", "workspace_root": "/srv/work", "path": "empty.txt"},
    )
    transfer_id = created.json()["transfer"]["transfer_id"]
    uploaded = client.put(
        f"/api/internal/transfers/{transfer_id}/content",
        headers={
            "Authorization": f"Bearer {worker['worker_token']}",
            "Content-Type": "text/plain",
        },
        content=b"",
    )
    assert uploaded.status_code == 200, uploaded.text

    downloaded = client.get(f"/api/workspaces/files/transfers/{transfer_id}/content", headers=user_headers)

    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.content == b""
    assert downloaded.headers["content-length"] == "0"


def test_user_streams_upload_and_bound_worker_claims_the_apply_job(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = _register_transfer_worker(client, "transfer-upload")
    user_headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/workspaces/files/upload-transfers",
        headers=user_headers,
        json={
            "worker_id": "transfer-upload",
            "workspace_root": "/srv/work",
            "path": "assets",
            "filename": "diagram.png",
            "content_type": "image/png",
            "overwrite": False,
        },
    )
    assert created.status_code == 200, created.text
    transfer_id = created.json()["transfer"]["transfer_id"]
    assert created.json()["transfer"]["direction"] == "upload"
    assert created.json()["transfer"]["status"] == "awaiting_upload"

    uploaded = client.put(
        f"/api/workspaces/files/transfers/{transfer_id}/content",
        headers={**user_headers, "Content-Type": "image/png"},
        content=b"streamed upload",
    )
    assert uploaded.status_code == 200, uploaded.text
    job = uploaded.json()["job"]
    assert job["kind"] == "file_transfer_apply"
    assert job["payload"] == {
        "transfer_id": transfer_id,
        "path": "assets",
        "filename": "diagram.png",
        "content_type": "image/png",
        "overwrite": False,
    }

    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": "transfer-upload"})
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == job["job_id"]

    content = client.get(f"/api/internal/transfers/{transfer_id}/content", headers=worker_headers)
    assert content.status_code == 200, content.text
    assert content.content == b"streamed upload"
    assert content.headers["content-type"].startswith("image/png")

    replay = client.put(
        f"/api/workspaces/files/transfers/{transfer_id}/content",
        headers={**user_headers, "Content-Type": "image/png"},
        content=b"replayed upload",
    )
    assert replay.status_code == 409, replay.text
    assert replay.json()["detail"]["code"] == "TRANSFER_STATE_INVALID"


def test_upload_transfer_download_rejects_another_worker(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    _register_transfer_worker(client, "upload-owner")
    other = _register_transfer_worker(client, "upload-other")
    user_headers = auth_headers(owner_login)

    created = client.post(
        "/api/workspaces/files/upload-transfers",
        headers=user_headers,
        json={
            "worker_id": "upload-owner",
            "workspace_root": "/srv/work",
            "path": ".",
            "filename": "notes.txt",
            "content_type": "text/plain",
        },
    )
    transfer_id = created.json()["transfer"]["transfer_id"]
    uploaded = client.put(
        f"/api/workspaces/files/transfers/{transfer_id}/content",
        headers={**user_headers, "Content-Type": "text/plain"},
        content=b"private upload",
    )
    assert uploaded.status_code == 200, uploaded.text

    downloaded = client.get(
        f"/api/internal/transfers/{transfer_id}/content",
        headers={"Authorization": f"Bearer {other['worker_token']}"},
    )

    assert downloaded.status_code == 403, downloaded.text
    assert downloaded.json()["detail"]["code"] == "TRANSFER_WORKER_MISMATCH"


def test_transfer_requires_worker_capability(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    registered = client.post(
        "/api/workers/register",
        headers={"Authorization": "Bearer worker-register-test-token"},
        json={
            "worker_id": "legacy-worker",
            "machine_name": "LegacyBox",
            "os": "windows",
            "reachable_backends": ["codex"],
            "workspace_roots": ["E:/work"],
            "capabilities": {},
        },
    )
    assert registered.status_code == 200

    response = client.post(
        "/api/workspaces/files/transfers",
        headers=auth_headers(owner_login),
        json={"worker_id": "legacy-worker", "workspace_root": "E:/work", "path": "README.md"},
    )

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "TRANSFER_UNSUPPORTED"
