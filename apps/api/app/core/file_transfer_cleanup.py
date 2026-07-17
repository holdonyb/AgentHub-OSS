from __future__ import annotations

import logging
from pathlib import Path
from threading import Event as ThreadEvent, Thread

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import FileTransfer, utcnow


logger = logging.getLogger("agenthub.file-transfers")


def expire_file_transfer(transfer: FileTransfer, *, storage_dir: str | Path | None = None) -> None:
    paths: set[Path] = set()
    if transfer.temp_path:
        paths.add(Path(transfer.temp_path))
    if storage_dir is not None:
        root = Path(storage_dir).resolve()
        paths.add(root / transfer.transfer_id)
        paths.update(root.glob(f".{transfer.transfer_id}.*.part"))
    temp_removed = not transfer.temp_path
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Unable to remove expired transfer content %s: %s", transfer.transfer_id, path)
        if transfer.temp_path and path == Path(transfer.temp_path) and not path.exists():
            temp_removed = True
    if temp_removed:
        transfer.temp_path = ""
    transfer.status = "expired"
    transfer.updated_at = utcnow()


def cleanup_expired_file_transfers(
    db: Session,
    *,
    space_id: str | None = None,
    storage_dir: str | Path | None = None,
    limit: int = 500,
) -> int:
    query = db.query(FileTransfer).filter(
        FileTransfer.expires_at <= utcnow(),
        or_(FileTransfer.status != "expired", FileTransfer.temp_path != ""),
    )
    if space_id is not None:
        query = query.filter(FileTransfer.space_id == space_id)
    expired = query.order_by(FileTransfer.expires_at).limit(max(1, limit)).all()
    for transfer in expired:
        expire_file_transfer(transfer, storage_dir=storage_dir)
    return len(expired)


class FileTransferCleanupWorker:
    def __init__(self, session_factory, *, interval_seconds: float, storage_dir: str | Path):
        self._session_factory = session_factory
        self._interval_seconds = interval_seconds
        self._storage_dir = storage_dir
        self._stop_event = ThreadEvent()
        self._thread: Thread | None = None

    @property
    def is_alive(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def run_once(self) -> int:
        with self._session_factory() as db:
            count = cleanup_expired_file_transfers(db, storage_dir=self._storage_dir)
            if count:
                db.commit()
            return count

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except Exception:
                logger.exception("Background file-transfer cleanup pass failed")
            self._stop_event.wait(self._interval_seconds)

    def start(self) -> None:
        if self.is_alive:
            return
        self._stop_event.clear()
        self._thread = Thread(target=self._run, name="agenthub-file-transfer-cleanup", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=max(2.0, self._interval_seconds + 1.0))
