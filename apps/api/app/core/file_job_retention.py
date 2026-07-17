from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.core.json import dumps_json, loads_json
from app.models import Job, utcnow


FILE_JOB_KINDS = {
    "file_create",
    "file_list",
    "file_mkdir",
    "file_read",
    "file_rename",
    "file_upload",
    "file_write",
}
BODY_FIELDS = {"data_base64", "text"}


def _strip_body(value: Any) -> tuple[dict[str, Any], bool]:
    if not isinstance(value, dict):
        return {}, False
    stripped = {key: item for key, item in value.items() if key not in BODY_FIELDS}
    changed = len(stripped) != len(value)
    if changed:
        stripped["body_expired"] = True
    return stripped, changed


def prune_expired_file_job_bodies(
    db: Session,
    *,
    ttl_seconds: int,
    space_id: str | None = None,
    now: datetime | None = None,
) -> int:
    cutoff = (now or utcnow()) - timedelta(seconds=max(60, ttl_seconds))
    query = db.query(Job).filter(
        Job.kind.in_(FILE_JOB_KINDS),
        Job.completed_at.is_not(None),
        Job.completed_at < cutoff,
    )
    if space_id is not None:
        query = query.filter(Job.space_id == space_id)

    changed_count = 0
    for job in query.all():
        payload, payload_changed = _strip_body(loads_json(job.payload_json, {}))
        result, result_changed = _strip_body(loads_json(job.result_text, {}))
        if payload_changed:
            job.payload_json = dumps_json(payload)
        if result_changed:
            job.result_text = dumps_json(result)
        if payload_changed or result_changed:
            job.updated_at = now or utcnow()
            changed_count += 1
    return changed_count
