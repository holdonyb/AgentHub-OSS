from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.audit import write_event
from app.core.config import get_settings
from app.core.deps import Actor, DbSession, require_min_role, require_space_user
from app.core.settings_store import get_effective_settings, set_preferences, set_worker_runtime_defaults
from app.schemas import SettingsOut, UserPreferencesIn, WorkerRuntimeSettingsIn

router = APIRouter()


@router.get("/api/settings")
def get_settings_view(db: DbSession, actor: Actor = Depends(require_space_user)):
    assert actor.user is not None
    assert actor.space_id is not None
    effective = get_effective_settings(db, user_id=actor.user.id, space_id=actor.space_id)
    app_settings = get_settings()
    return SettingsOut(
        preferences=effective.preferences,
        worker_runtime_defaults=effective.worker_runtime_defaults,
        options={
            "locales": [
                {"value": "zh-CN", "label": "简体中文"},
                {"value": "zh-TW", "label": "繁體中文"},
                {"value": "en-US", "label": "English"},
            ],
            "theme_modes": [
                {"value": "dark", "label": "深色"},
                {"value": "light", "label": "浅色"},
            ],
            "voice_modes": [
                {"value": "streaming", "label": "流式"},
                {"value": "standard", "label": "标准"},
            ],
            "voice_languages": [
                {"value": "zh-CN", "label": "中文"},
                {"value": "zh-TW", "label": "繁體中文"},
                {"value": "en-US", "label": "English"},
            ],
        },
        limits={
            "max_session_attachments": app_settings.max_session_attachments,
            "max_session_attachment_bytes": app_settings.max_session_attachment_bytes,
            "max_voice_audio_bytes": app_settings.max_voice_audio_bytes,
        },
    )


@router.patch("/api/settings/preferences")
def patch_preferences(payload: UserPreferencesIn, db: DbSession, actor: Actor = Depends(require_space_user)):
    assert actor.user is not None
    assert actor.space_id is not None
    values = payload.model_dump(exclude_none=True)
    preferences = set_preferences(db, user_id=actor.user.id, space_id=actor.space_id, values=values)
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.user.id,
        source_type="settings",
        source_id=f"user:{actor.user.id}",
        event_type="settings.preferences_update",
        payload={"fields": sorted(values.keys())},
    )
    db.commit()
    return {"preferences": preferences}


@router.patch("/api/settings/worker-runtime")
def patch_worker_runtime(
    payload: WorkerRuntimeSettingsIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("admin")),
):
    assert actor.space_id is not None
    values = payload.model_dump(exclude_none=True)
    runtime_defaults = set_worker_runtime_defaults(db, space_id=actor.space_id, values=values)
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="settings",
        source_id=f"space:{actor.space_id}",
        event_type="settings.worker_runtime_update",
        payload=runtime_defaults,
    )
    db.commit()
    return {"worker_runtime_defaults": runtime_defaults}
