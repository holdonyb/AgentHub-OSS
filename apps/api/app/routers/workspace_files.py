from __future__ import annotations

from collections.abc import Mapping
from datetime import timedelta
import hashlib
import hmac
import os
from pathlib import Path
from urllib.parse import quote, unquote
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.core.audit import write_event
from app.core.deps import Actor, DbSession, require_min_role, require_worker
from app.core.file_transfer_cleanup import cleanup_expired_file_transfers, expire_file_transfer
from app.core.json import dumps_json, loads_json
from app.core.secrets import secret_value_hash
from app.models import FileTransfer, Job, Worker, utcnow
from app.schemas import (
    WorkspaceFileCreateIn,
    WorkspaceFileListIn,
    WorkspaceFileMkdirIn,
    WorkspaceFileReadIn,
    WorkspaceFileRenameIn,
    WorkspaceFileSearchIn,
    WorkspaceFileTargetIn,
    WorkspaceFileTransferCreateIn,
    WorkspaceFileTransferUploadCreateIn,
    WorkspaceFileUploadIn,
    WorkspaceFileWriteIn,
)
from app.services import job_out

router = APIRouter()


def _transfer_out(transfer: FileTransfer) -> dict[str, object]:
    return {
        "transfer_id": transfer.transfer_id,
        "worker_id": transfer.worker_id,
        "workspace_root": transfer.workspace_root,
        "path": transfer.relative_path,
        "direction": transfer.direction,
        "status": transfer.status,
        "filename": transfer.filename,
        "content_type": transfer.content_type,
        "size_bytes": transfer.size_bytes,
        "sha256": transfer.sha256,
        "modified_at": transfer.source_modified_at or None,
        "overwrite": transfer.overwrite,
        "expires_at": transfer.expires_at,
        "content_url": f"/api/workspaces/files/transfers/{transfer.transfer_id}/content",
    }


def _transfer_storage_path(request: Request, transfer_id: str) -> Path:
    root = Path(request.app.state.settings.file_transfer_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root / transfer_id


def _require_user_transfer(db: DbSession, actor: Actor, transfer_id: str) -> FileTransfer:
    transfer = (
        db.query(FileTransfer)
        .filter(
            FileTransfer.space_id == actor.space_id,
            FileTransfer.transfer_id == transfer_id,
            FileTransfer.created_by == actor.actor_id,
        )
        .one_or_none()
    )
    if transfer is None:
        raise HTTPException(status_code=404, detail={"message": "Transfer not found", "code": "TRANSFER_NOT_FOUND"})
    if transfer.expires_at <= utcnow() or transfer.status == "expired":
        expire_file_transfer(transfer)
        db.commit()
        raise HTTPException(status_code=410, detail={"message": "Transfer expired", "code": "TRANSFER_EXPIRED"})
    return transfer


def _download_ticket_payload(transfer: FileTransfer, expires_at: int) -> str:
    return f"{transfer.transfer_id}:{transfer.created_by}:{expires_at}"


def _download_ticket_signature(transfer: FileTransfer, expires_at: int, request: Request) -> str:
    return secret_value_hash(_download_ticket_payload(transfer, expires_at), request.app.state.settings)


def _normalized_workspace_root(value: str, *, windows: bool) -> str:
    normalized = value.strip().replace("\\", "/")
    while "//" in normalized:
        normalized = normalized.replace("//", "/")
    if len(normalized) > 1 and not (len(normalized) == 3 and normalized[1:] == ":/"):
        normalized = normalized.rstrip("/")
    return normalized.casefold() if windows else normalized


def _canonical_workspace_root(value: str) -> str:
    normalized = value.strip().replace("\\", "/")
    while "//" in normalized:
        normalized = normalized.replace("//", "/")
    if len(normalized) == 3 and normalized[1:] == ":/":
        return normalized
    return normalized.rstrip("/") or "/"


def _require_workspace(db: DbSession, actor: Actor, payload: WorkspaceFileTargetIn) -> tuple[Worker, str]:
    worker = (
        db.query(Worker)
        .filter(Worker.space_id == actor.space_id, Worker.worker_id == payload.worker_id)
        .one_or_none()
    )
    if worker is None:
        raise HTTPException(status_code=404, detail={"message": "Worker not found", "code": "WORKER_NOT_FOUND"})
    if worker.status == "offline":
        raise HTTPException(status_code=409, detail={"message": "Worker is offline", "code": "WORKER_OFFLINE"})

    windows = worker.os.strip().lower() == "windows"
    requested = _normalized_workspace_root(payload.workspace_root, windows=windows)
    roots = loads_json(worker.workspace_roots_json, [])
    canonical_root = next(
        (
            _canonical_workspace_root(str(root))
            for root in roots
            if isinstance(root, str) and _normalized_workspace_root(root, windows=windows) == requested
        ),
        None,
    )
    if canonical_root is None:
        raise HTTPException(
            status_code=403,
            detail={"message": "Workspace root is not registered for this worker", "code": "WORKSPACE_ROOT_NOT_ALLOWED"},
        )
    return worker, canonical_root


def _queue_file_job(
    *,
    db: DbSession,
    actor: Actor,
    payload: WorkspaceFileTargetIn,
    kind: str,
    job_payload: Mapping[str, object],
) -> dict[str, object]:
    worker, workspace_root = _require_workspace(db, actor, payload)
    job = Job(
        space_id=actor.space_id,
        kind=kind,
        target_session_id=None,
        worker_id=worker.worker_id,
        backend=None,
        workspace_root=workspace_root,
        namespace="default",
        payload_json=dumps_json(dict(job_payload)),
        created_by=actor.actor_id,
    )
    db.add(job)
    db.flush()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="job",
        source_id=job.job_id,
        event_type=f"workspace.{kind}",
        payload={
            "worker_id": worker.worker_id,
            "workspace_root": workspace_root,
            **({"reveal_sensitive": True} if job_payload.get("reveal_sensitive") is True else {}),
        },
    )
    db.commit()
    return {"job": job_out(job)}


@router.post("/api/workspaces/files/list")
def list_workspace_files(
    payload: WorkspaceFileListIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    return _queue_file_job(
        db=db,
        actor=actor,
        payload=payload,
        kind="file_list",
        job_payload={"path": payload.path.strip() or "."},
    )


@router.post("/api/workspaces/files/read")
def read_workspace_file(
    payload: WorkspaceFileReadIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    return _queue_file_job(
        db=db,
        actor=actor,
        payload=payload,
        kind="file_read",
        job_payload={
            "path": payload.path.strip(),
            "offset_bytes": payload.offset_bytes,
            "max_bytes": payload.max_bytes,
            **({"reveal_sensitive": True} if payload.reveal_sensitive else {}),
        },
    )


@router.post("/api/workspaces/files/search")
def search_workspace_files(
    payload: WorkspaceFileSearchIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    return _queue_file_job(
        db=db,
        actor=actor,
        payload=payload,
        kind="file_search",
        job_payload={
            "path": payload.path.strip() or ".",
            "query": payload.query.strip(),
            "max_results": payload.max_results,
            "include_hidden": payload.include_hidden,
        },
    )


@router.post("/api/workspaces/files/write")
def write_workspace_file(
    payload: WorkspaceFileWriteIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    return _queue_file_job(
        db=db,
        actor=actor,
        payload=payload,
        kind="file_write",
        job_payload={
            "path": payload.path.strip(),
            "text": payload.text,
            "expected_modified_at": payload.expected_modified_at,
        },
    )


@router.post("/api/workspaces/files/upload")
def upload_workspace_file(
    payload: WorkspaceFileUploadIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    return _queue_file_job(
        db=db,
        actor=actor,
        payload=payload,
        kind="file_upload",
        job_payload={
            "path": payload.path.strip() or ".",
            "filename": payload.filename.strip(),
            "content_type": payload.content_type.strip(),
            "data_base64": payload.data_base64,
            "overwrite": payload.overwrite,
        },
    )


@router.post("/api/workspaces/files/create")
def create_workspace_file(
    payload: WorkspaceFileCreateIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    return _queue_file_job(
        db=db,
        actor=actor,
        payload=payload,
        kind="file_create",
        job_payload={"path": payload.path.strip(), "text": payload.text, "overwrite": payload.overwrite},
    )


@router.post("/api/workspaces/files/mkdir")
def mkdir_workspace_file(
    payload: WorkspaceFileMkdirIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    return _queue_file_job(
        db=db,
        actor=actor,
        payload=payload,
        kind="file_mkdir",
        job_payload={"path": payload.path.strip()},
    )


@router.post("/api/workspaces/files/rename")
def rename_workspace_file(
    payload: WorkspaceFileRenameIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    return _queue_file_job(
        db=db,
        actor=actor,
        payload=payload,
        kind="file_rename",
        job_payload={
            "path": payload.path.strip(),
            "new_path": payload.new_path.strip(),
            "expected_modified_at": payload.expected_modified_at,
        },
    )


@router.post("/api/workspaces/files/transfers")
def create_workspace_file_transfer(
    payload: WorkspaceFileTransferCreateIn,
    request: Request,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    cleanup_expired_file_transfers(db, space_id=actor.space_id)
    worker, workspace_root = _require_workspace(db, actor, payload)
    capabilities = loads_json(worker.capabilities_json, {})
    if not isinstance(capabilities, dict) or capabilities.get("file_transfer_v2") is not True:
        raise HTTPException(
            status_code=409,
            detail={"message": "Worker does not support streamed file transfers", "code": "TRANSFER_UNSUPPORTED"},
        )
    now = utcnow()
    transfer = FileTransfer(
        space_id=actor.space_id,
        worker_id=worker.worker_id,
        workspace_root=workspace_root,
        relative_path=payload.path.strip(),
        created_by=actor.actor_id,
        expires_at=now + timedelta(seconds=request.app.state.settings.file_transfer_ttl_seconds),
        created_at=now,
        updated_at=now,
    )
    db.add(transfer)
    db.flush()
    job = Job(
        space_id=actor.space_id,
        kind="file_transfer_prepare",
        target_session_id=None,
        worker_id=worker.worker_id,
        backend=None,
        workspace_root=workspace_root,
        namespace="default",
        payload_json=dumps_json(
            {
                "transfer_id": transfer.transfer_id,
                "path": transfer.relative_path,
                **({"reveal_sensitive": True} if payload.reveal_sensitive else {}),
            }
        ),
        created_by=actor.actor_id,
    )
    db.add(job)
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="file_transfer",
        source_id=transfer.transfer_id,
        event_type="workspace.transfer.create",
        payload={
            "worker_id": worker.worker_id,
            "workspace_root": workspace_root,
            "path": transfer.relative_path,
            **({"reveal_sensitive": True} if payload.reveal_sensitive else {}),
        },
    )
    db.commit()
    return {"transfer": _transfer_out(transfer), "job": job_out(job)}


@router.post("/api/workspaces/files/upload-transfers")
def create_workspace_file_upload_transfer(
    payload: WorkspaceFileTransferUploadCreateIn,
    request: Request,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    cleanup_expired_file_transfers(db, space_id=actor.space_id)
    worker, workspace_root = _require_workspace(db, actor, payload)
    capabilities = loads_json(worker.capabilities_json, {})
    if not isinstance(capabilities, dict) or capabilities.get("file_transfer_v2") is not True:
        raise HTTPException(
            status_code=409,
            detail={"message": "Worker does not support streamed file transfers", "code": "TRANSFER_UNSUPPORTED"},
        )
    filename = payload.filename.replace("\\", "/").split("/")[-1].strip()
    if not filename or filename in {".", ".."}:
        raise HTTPException(status_code=422, detail={"message": "Invalid filename", "code": "TRANSFER_FILENAME_INVALID"})
    now = utcnow()
    transfer = FileTransfer(
        space_id=actor.space_id,
        worker_id=worker.worker_id,
        workspace_root=workspace_root,
        relative_path=payload.path.strip() or ".",
        direction="upload",
        status="awaiting_upload",
        created_by=actor.actor_id,
        filename=filename,
        content_type=payload.content_type.strip() or "application/octet-stream",
        overwrite=payload.overwrite,
        expires_at=now + timedelta(seconds=request.app.state.settings.file_transfer_ttl_seconds),
        created_at=now,
        updated_at=now,
    )
    db.add(transfer)
    db.flush()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="file_transfer",
        source_id=transfer.transfer_id,
        event_type="workspace.transfer.upload.create",
        payload={"worker_id": worker.worker_id, "workspace_root": workspace_root, "path": transfer.relative_path},
    )
    db.commit()
    return {"transfer": _transfer_out(transfer)}


@router.get("/api/workspaces/files/transfers/{transfer_id}")
def get_workspace_file_transfer(
    transfer_id: str,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    return {"transfer": _transfer_out(_require_user_transfer(db, actor, transfer_id))}


def _parse_byte_range(value: str, size_bytes: int) -> tuple[int, int] | None:
    if not value:
        return None
    if not value.startswith("bytes=") or "," in value:
        raise HTTPException(
            status_code=416,
            detail={"message": "Invalid byte range", "code": "TRANSFER_RANGE_INVALID"},
            headers={"Content-Range": f"bytes */{size_bytes}"},
        )
    raw_start, separator, raw_end = value[6:].partition("-")
    if not separator:
        raise HTTPException(status_code=416, detail={"message": "Invalid byte range", "code": "TRANSFER_RANGE_INVALID"})
    try:
        if raw_start:
            start = int(raw_start)
            end = int(raw_end) if raw_end else size_bytes - 1
        else:
            suffix = int(raw_end)
            start = max(0, size_bytes - suffix)
            end = size_bytes - 1
    except ValueError:
        raise HTTPException(status_code=416, detail={"message": "Invalid byte range", "code": "TRANSFER_RANGE_INVALID"}) from None
    if start < 0 or end < start or start >= size_bytes:
        raise HTTPException(
            status_code=416,
            detail={"message": "Byte range is outside the file", "code": "TRANSFER_RANGE_INVALID"},
            headers={"Content-Range": f"bytes */{size_bytes}"},
        )
    return start, min(end, size_bytes - 1)


def _iter_file_range(path: Path, start: int, length: int):
    with path.open("rb") as stream:
        stream.seek(start)
        remaining = length
        while remaining > 0:
            chunk = stream.read(min(64 * 1024, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


async def _receive_transfer_content(
    request: Request,
    db: DbSession,
    transfer: FileTransfer,
    *,
    filename: str,
    modified_at: str,
) -> None:
    content_length = request.headers.get("content-length", "")
    partial: Path | None = None
    digest = hashlib.sha256()
    size_bytes = 0
    try:
        if content_length.isdigit() and int(content_length) > request.app.state.settings.max_file_transfer_bytes:
            raise HTTPException(status_code=413, detail={"message": "Transfer is too large", "code": "TRANSFER_TOO_LARGE"})
        target = _transfer_storage_path(request, transfer.transfer_id)
        partial = target.with_name(f".{target.name}.{uuid4().hex}.part")
        with partial.open("wb") as stream:
            async for chunk in request.stream():
                if transfer.expires_at <= utcnow():
                    raise HTTPException(
                        status_code=410,
                        detail={"message": "Transfer expired", "code": "TRANSFER_EXPIRED"},
                    )
                size_bytes += len(chunk)
                if size_bytes > request.app.state.settings.max_file_transfer_bytes:
                    raise HTTPException(status_code=413, detail={"message": "Transfer is too large", "code": "TRANSFER_TOO_LARGE"})
                digest.update(chunk)
                stream.write(chunk)
        os.replace(partial, target)
    except Exception:
        if partial is not None:
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                pass
        transfer.status = "failed"
        transfer.updated_at = utcnow()
        db.commit()
        raise

    now = utcnow()
    transfer.status = "ready"
    transfer.filename = (filename.strip() or Path(transfer.relative_path).name)[:240]
    transfer.content_type = (request.headers.get("content-type") or transfer.content_type or "application/octet-stream")[:160]
    transfer.size_bytes = size_bytes
    transfer.sha256 = digest.hexdigest()
    transfer.source_modified_at = modified_at.strip()[:80]
    transfer.temp_path = str(target)
    transfer.completed_at = now
    transfer.updated_at = now


def _can_inline_transfer_content(content_type: str) -> bool:
    normalized = content_type.partition(";")[0].strip().lower()
    if normalized == "text/plain":
        return True
    if normalized.startswith(("audio/", "video/")):
        return True
    return normalized.startswith("image/") and "svg" not in normalized and "xml" not in normalized


def _claim_transfer_upload(db: DbSession, transfer: FileTransfer, *, expected_status: str) -> None:
    now = utcnow()
    claimed = (
        db.query(FileTransfer)
        .filter(
            FileTransfer.transfer_id == transfer.transfer_id,
            FileTransfer.space_id == transfer.space_id,
            FileTransfer.status == expected_status,
        )
        .update(
            {FileTransfer.status: "uploading", FileTransfer.updated_at: now},
            synchronize_session=False,
        )
    )
    db.commit()
    if claimed != 1:
        raise HTTPException(
            status_code=409,
            detail={"message": "Transfer cannot accept content", "code": "TRANSFER_STATE_INVALID"},
        )
    db.refresh(transfer)


def _transfer_content_response(transfer: FileTransfer, *, range_header: str = "") -> StreamingResponse:
    if transfer.status != "ready" or not transfer.temp_path or transfer.size_bytes is None:
        raise HTTPException(status_code=409, detail={"message": "Transfer is not ready", "code": "TRANSFER_NOT_READY"})
    path = Path(transfer.temp_path)
    if not path.is_file():
        raise HTTPException(status_code=410, detail={"message": "Transfer content is unavailable", "code": "TRANSFER_GONE"})
    size_bytes = transfer.size_bytes
    byte_range = _parse_byte_range(range_header, size_bytes)
    start, end = byte_range or (0, size_bytes - 1)
    length = max(0, end - start + 1)
    disposition = "inline" if _can_inline_transfer_content(transfer.content_type) else "attachment"
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Length": str(length),
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(transfer.filename or path.name)}",
        "Content-Encoding": "identity",
        "X-AgentHub-SHA256": transfer.sha256,
        "X-Content-Type-Options": "nosniff",
    }
    if disposition == "attachment":
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'"
    status_code = 200
    if byte_range is not None:
        status_code = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size_bytes}"
    return StreamingResponse(
        _iter_file_range(path, start, length),
        status_code=status_code,
        media_type=transfer.content_type,
        headers=headers,
    )


@router.get("/api/workspaces/files/transfers/{transfer_id}/content")
def download_workspace_file_transfer(
    transfer_id: str,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
    range_header: str = Header(default="", alias="Range"),
):
    transfer = _require_user_transfer(db, actor, transfer_id)
    try:
        return _transfer_content_response(transfer, range_header=range_header)
    except HTTPException as exc:
        if exc.status_code != 410:
            raise
        transfer.status = "failed"
        db.commit()
        raise


@router.post("/api/workspaces/files/transfers/{transfer_id}/download-ticket")
def create_workspace_file_download_ticket(
    transfer_id: str,
    request: Request,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    transfer = _require_user_transfer(db, actor, transfer_id)
    if transfer.status != "ready" or not transfer.temp_path:
        raise HTTPException(
            status_code=409,
            detail={"message": "Transfer is not ready", "code": "TRANSFER_NOT_READY"},
        )
    requested_expiry = utcnow() + timedelta(seconds=request.app.state.settings.file_transfer_download_ticket_seconds)
    expires_at = int(min(requested_expiry, transfer.expires_at).timestamp())
    signature = _download_ticket_signature(transfer, expires_at, request)
    return {
        "download_url": (
            f"/api/workspaces/files/transfers/{transfer.transfer_id}/download"
            f"?expires={expires_at}&signature={signature}"
        ),
        "expires_at": expires_at,
    }


@router.get("/api/workspaces/files/transfers/{transfer_id}/download")
def download_workspace_file_with_ticket(
    transfer_id: str,
    expires: int,
    signature: str,
    request: Request,
    db: DbSession,
    range_header: str = Header(default="", alias="Range"),
):
    transfer = db.query(FileTransfer).filter(FileTransfer.transfer_id == transfer_id).one_or_none()
    now = utcnow()
    if transfer is None or expires < int(now.timestamp()) or transfer.expires_at <= now:
        raise HTTPException(
            status_code=403,
            detail={"message": "Download ticket is invalid or expired", "code": "TRANSFER_TICKET_INVALID"},
        )
    expected = _download_ticket_signature(transfer, expires, request)
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(
            status_code=403,
            detail={"message": "Download ticket is invalid or expired", "code": "TRANSFER_TICKET_INVALID"},
        )
    return _transfer_content_response(transfer, range_header=range_header)


@router.put("/api/workspaces/files/transfers/{transfer_id}/content")
async def upload_user_workspace_file_transfer(
    transfer_id: str,
    request: Request,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    transfer = _require_user_transfer(db, actor, transfer_id)
    if transfer.direction != "upload" or transfer.status != "awaiting_upload":
        raise HTTPException(status_code=409, detail={"message": "Transfer cannot accept content", "code": "TRANSFER_STATE_INVALID"})
    _claim_transfer_upload(db, transfer, expected_status="awaiting_upload")
    await _receive_transfer_content(request, db, transfer, filename=transfer.filename, modified_at="")
    job = Job(
        space_id=actor.space_id,
        kind="file_transfer_apply",
        target_session_id=None,
        worker_id=transfer.worker_id,
        backend=None,
        workspace_root=transfer.workspace_root,
        namespace="default",
        payload_json=dumps_json(
            {
                "transfer_id": transfer.transfer_id,
                "path": transfer.relative_path,
                "filename": transfer.filename,
                "content_type": transfer.content_type,
                "overwrite": transfer.overwrite,
            }
        ),
        created_by=actor.actor_id,
    )
    db.add(job)
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="file_transfer",
        source_id=transfer.transfer_id,
        event_type="workspace.transfer.upload.ready",
        payload={"size_bytes": transfer.size_bytes, "sha256": transfer.sha256},
    )
    db.commit()
    return {"transfer": _transfer_out(transfer), "job": job_out(job)}


@router.get("/api/internal/transfers/{transfer_id}/content")
@router.get("/api/worker/transfers/{transfer_id}/content")
def download_worker_workspace_file_transfer(
    transfer_id: str,
    db: DbSession,
    actor: Actor = Depends(require_worker),
):
    worker = actor.worker
    assert worker is not None
    transfer = db.query(FileTransfer).filter(FileTransfer.space_id == worker.space_id, FileTransfer.transfer_id == transfer_id).one_or_none()
    if transfer is None:
        raise HTTPException(status_code=404, detail={"message": "Transfer not found", "code": "TRANSFER_NOT_FOUND"})
    if transfer.worker_id != worker.worker_id:
        raise HTTPException(status_code=403, detail={"message": "Transfer is bound to another worker", "code": "TRANSFER_WORKER_MISMATCH"})
    if transfer.expires_at <= utcnow():
        expire_file_transfer(transfer)
        db.commit()
        raise HTTPException(status_code=410, detail={"message": "Transfer expired", "code": "TRANSFER_EXPIRED"})
    if transfer.direction != "upload":
        raise HTTPException(status_code=409, detail={"message": "Transfer direction is invalid", "code": "TRANSFER_DIRECTION_INVALID"})
    return _transfer_content_response(transfer)


@router.put("/api/internal/transfers/{transfer_id}/content")
@router.put("/api/worker/transfers/{transfer_id}/content")
async def upload_workspace_file_transfer(
    transfer_id: str,
    request: Request,
    db: DbSession,
    actor: Actor = Depends(require_worker),
    filename: str = Header(default="", alias="X-AgentHub-Filename"),
    modified_at: str = Header(default="", alias="X-AgentHub-Modified-At"),
):
    worker = actor.worker
    assert worker is not None
    transfer = (
        db.query(FileTransfer)
        .filter(FileTransfer.space_id == worker.space_id, FileTransfer.transfer_id == transfer_id)
        .one_or_none()
    )
    if transfer is None:
        raise HTTPException(status_code=404, detail={"message": "Transfer not found", "code": "TRANSFER_NOT_FOUND"})
    if transfer.worker_id != worker.worker_id:
        raise HTTPException(
            status_code=403,
            detail={"message": "Transfer is bound to another worker", "code": "TRANSFER_WORKER_MISMATCH"},
        )
    if transfer.expires_at <= utcnow():
        expire_file_transfer(transfer)
        db.commit()
        raise HTTPException(status_code=410, detail={"message": "Transfer expired", "code": "TRANSFER_EXPIRED"})
    if transfer.status != "queued":
        raise HTTPException(status_code=409, detail={"message": "Transfer cannot accept content", "code": "TRANSFER_STATE_INVALID"})

    _claim_transfer_upload(db, transfer, expected_status="queued")
    await _receive_transfer_content(request, db, transfer, filename=unquote(filename), modified_at=modified_at)
    write_event(
        db,
        space_id=worker.space_id,
        actor_type="worker",
        actor_id=worker.worker_id,
        source_type="file_transfer",
        source_id=transfer.transfer_id,
        event_type="workspace.transfer.ready",
        payload={"size_bytes": transfer.size_bytes, "sha256": transfer.sha256},
    )
    db.commit()
    return {"transfer": _transfer_out(transfer)}
