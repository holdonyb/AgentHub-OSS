from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.core.json import dumps_json, loads_json
from app.models import SettingEntry, Worker, utcnow

SETTING_UI_LOCALE = "ui.locale"
SETTING_UI_THEME_MODE = "ui.theme_mode"
SETTING_VOICE_MODE = "voice.mode"
SETTING_VOICE_LANGUAGE = "voice.language"
SETTING_QUICK_REPLIES = "composer.quick_replies"
SETTING_WORKER_MAX_CONCURRENT_JOBS = "worker.max_concurrent_jobs"
SETTING_WORKER_JOB_POLL_INTERVAL = "worker.job_poll_interval_seconds"
SETTING_WORKER_HEARTBEAT_INTERVAL = "worker.heartbeat_interval_seconds"

USER_SETTING_KEYS = {
    SETTING_UI_LOCALE,
    SETTING_UI_THEME_MODE,
    SETTING_VOICE_MODE,
    SETTING_VOICE_LANGUAGE,
    SETTING_QUICK_REPLIES,
}

SPACE_SETTING_KEYS = {
    SETTING_WORKER_MAX_CONCURRENT_JOBS,
    SETTING_WORKER_JOB_POLL_INTERVAL,
    SETTING_WORKER_HEARTBEAT_INTERVAL,
}


@dataclass(frozen=True)
class EffectiveSettings:
    preferences: dict[str, Any]
    worker_runtime_defaults: dict[str, Any]


def _setting_row(db: Session, *, scope_type: str, scope_id: str, key: str) -> SettingEntry | None:
    return (
        db.query(SettingEntry)
        .filter(SettingEntry.scope_type == scope_type, SettingEntry.scope_id == scope_id, SettingEntry.key == key)
        .one_or_none()
    )


def get_setting(db: Session, *, scope_type: str, scope_id: str, key: str, default: Any = None) -> Any:
    row = _setting_row(db, scope_type=scope_type, scope_id=scope_id, key=key)
    if row is None:
        return default
    return loads_json(row.value_json, default)


def set_setting(db: Session, *, scope_type: str, scope_id: str, key: str, value: Any) -> SettingEntry:
    row = _setting_row(db, scope_type=scope_type, scope_id=scope_id, key=key)
    if row is None:
        row = SettingEntry(scope_type=scope_type, scope_id=scope_id, key=key)
        db.add(row)
    row.value_json = dumps_json(value)
    row.updated_at = utcnow()
    return row


def default_preferences() -> dict[str, Any]:
    return {
        "locale": "zh-CN",
        "theme_mode": "dark",
        "voice_mode": "streaming",
        "voice_language": "zh-CN",
        "quick_replies": ["继续", "不对，重新来", "等等", "收到，继续", "先停一下"],
    }


def default_worker_runtime_defaults() -> dict[str, Any]:
    return {
        "max_concurrent_jobs": 2,
        "job_poll_interval_seconds": 5.0,
        "heartbeat_interval_seconds": 30.0,
    }


def _runtime_baseline() -> dict[str, int]:
    defaults = default_worker_runtime_defaults()
    return {
        "max_concurrent_jobs": int(defaults["max_concurrent_jobs"]),
        "job_poll_interval_seconds": int(defaults["job_poll_interval_seconds"]),
        "heartbeat_interval_seconds": int(defaults["heartbeat_interval_seconds"]),
    }


def get_preferences(db: Session, *, user_id: str, space_id: str) -> dict[str, Any]:
    defaults = default_preferences()
    return {
        "locale": str(get_setting(db, scope_type="user", scope_id=f"{space_id}:{user_id}", key=SETTING_UI_LOCALE, default=defaults["locale"])),
        "theme_mode": str(get_setting(db, scope_type="user", scope_id=f"{space_id}:{user_id}", key=SETTING_UI_THEME_MODE, default=defaults["theme_mode"])),
        "voice_mode": str(get_setting(db, scope_type="user", scope_id=f"{space_id}:{user_id}", key=SETTING_VOICE_MODE, default=defaults["voice_mode"])),
        "voice_language": str(get_setting(db, scope_type="user", scope_id=f"{space_id}:{user_id}", key=SETTING_VOICE_LANGUAGE, default=defaults["voice_language"])),
        "quick_replies": list(get_setting(db, scope_type="user", scope_id=f"{space_id}:{user_id}", key=SETTING_QUICK_REPLIES, default=defaults["quick_replies"])),
    }


def set_preferences(db: Session, *, user_id: str, space_id: str, values: dict[str, Any]) -> dict[str, Any]:
    scope_id = f"{space_id}:{user_id}"
    mapping = {
        "locale": SETTING_UI_LOCALE,
        "theme_mode": SETTING_UI_THEME_MODE,
        "voice_mode": SETTING_VOICE_MODE,
        "voice_language": SETTING_VOICE_LANGUAGE,
        "quick_replies": SETTING_QUICK_REPLIES,
    }
    for field, key in mapping.items():
        if field in values:
            set_setting(db, scope_type="user", scope_id=scope_id, key=key, value=values[field])
    db.flush()
    return get_preferences(db, user_id=user_id, space_id=space_id)


def get_worker_runtime_defaults(db: Session, *, space_id: str) -> dict[str, Any]:
    defaults = default_worker_runtime_defaults()
    return {
        "max_concurrent_jobs": int(get_setting(db, scope_type="space", scope_id=space_id, key=SETTING_WORKER_MAX_CONCURRENT_JOBS, default=defaults["max_concurrent_jobs"])),
        "job_poll_interval_seconds": float(get_setting(db, scope_type="space", scope_id=space_id, key=SETTING_WORKER_JOB_POLL_INTERVAL, default=defaults["job_poll_interval_seconds"])),
        "heartbeat_interval_seconds": float(get_setting(db, scope_type="space", scope_id=space_id, key=SETTING_WORKER_HEARTBEAT_INTERVAL, default=defaults["heartbeat_interval_seconds"])),
    }


def set_worker_runtime_defaults(db: Session, *, space_id: str, values: dict[str, Any]) -> dict[str, Any]:
    previous = get_worker_runtime_defaults(db, space_id=space_id)
    baseline = _runtime_baseline()
    mapping = {
        "max_concurrent_jobs": SETTING_WORKER_MAX_CONCURRENT_JOBS,
        "job_poll_interval_seconds": SETTING_WORKER_JOB_POLL_INTERVAL,
        "heartbeat_interval_seconds": SETTING_WORKER_HEARTBEAT_INTERVAL,
    }
    for field, key in mapping.items():
        if field in values:
            set_setting(db, scope_type="space", scope_id=space_id, key=key, value=values[field])
    db.flush()
    current = get_worker_runtime_defaults(db, space_id=space_id)
    workers = db.query(Worker).filter(Worker.space_id == space_id).all()
    changed_fields = set(values.keys())
    for worker in workers:
        updated = False
        if "max_concurrent_jobs" in changed_fields and worker.max_concurrent_jobs in {
            int(previous["max_concurrent_jobs"]),
            baseline["max_concurrent_jobs"],
        }:
            worker.max_concurrent_jobs = int(current["max_concurrent_jobs"])
            updated = True
        if (
            "job_poll_interval_seconds" in changed_fields
            and worker.job_poll_interval_seconds in {
                int(previous["job_poll_interval_seconds"]),
                baseline["job_poll_interval_seconds"],
            }
        ):
            worker.job_poll_interval_seconds = int(current["job_poll_interval_seconds"])
            updated = True
        if (
            "heartbeat_interval_seconds" in changed_fields
            and worker.heartbeat_interval_seconds in {
                int(previous["heartbeat_interval_seconds"]),
                baseline["heartbeat_interval_seconds"],
            }
        ):
            worker.heartbeat_interval_seconds = int(current["heartbeat_interval_seconds"])
            updated = True
        if updated:
            worker.updated_at = utcnow()
    db.flush()
    return current


def get_effective_settings(db: Session, *, user_id: str, space_id: str) -> EffectiveSettings:
    return EffectiveSettings(
        preferences=get_preferences(db, user_id=user_id, space_id=space_id),
        worker_runtime_defaults=get_worker_runtime_defaults(db, space_id=space_id),
    )
