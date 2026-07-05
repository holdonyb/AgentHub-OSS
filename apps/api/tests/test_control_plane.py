from __future__ import annotations

import base64
from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.dialects import sqlite

from conftest import auth_headers, bootstrap_owner, create_worker, login
from app.core.json import dumps_json, loads_json
from app.maintenance import backfill_session_summary_timeline_rows
from app.models import AgentPermission, AgentSession, AgentTimeline, Event, Job, ProviderSnapshot, Space, SpaceMembership, Worker
from app.routers.sessions import _session_ordering


VALID_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


def test_anonymous_business_apis_return_401(client: TestClient) -> None:
    response = client.get("/api/sessions")
    assert response.status_code == 401
    settings_response = client.get("/api/settings")
    assert settings_response.status_code == 401


def test_admin_can_update_worker_runtime_settings_and_worker_heartbeat_receives_them(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client, "win-runtime")
    headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    listed = client.get("/api/workers", headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["runtime_settings"] == {
        "max_concurrent_jobs": 2,
        "job_poll_interval_seconds": 5,
        "heartbeat_interval_seconds": 30,
    }

    patched = client.patch(
        "/api/workers/win-runtime/runtime-settings",
        headers=headers,
        json={
            "max_concurrent_jobs": 6,
            "job_poll_interval_seconds": 11,
            "heartbeat_interval_seconds": 44,
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["worker"]["runtime_settings"] == {
        "max_concurrent_jobs": 6,
        "job_poll_interval_seconds": 11,
        "heartbeat_interval_seconds": 44,
    }

    heartbeat = client.post(
        "/api/workers/win-runtime/heartbeat",
        headers=worker_headers,
        json={"status": "online"},
    )
    assert heartbeat.status_code == 200, heartbeat.text
    assert heartbeat.json()["worker"]["runtime_settings"] == {
        "max_concurrent_jobs": 6,
        "job_poll_interval_seconds": 11,
        "heartbeat_interval_seconds": 44,
    }

    events = client.get("/api/events", headers=headers).json()["items"]
    assert any(event["event_type"] == "worker.runtime_settings_update" for event in events)


def test_sync_status_changes_only_when_relevant_state_changes(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-sync",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-sync",
            "status": "ready",
            "title": "AgentHub sync",
            "last_message": "ready",
            "metadata": {},
        },
        headers=headers,
    )
    assert session_response.status_code == 200, session_response.text

    first = client.get("/api/sync/status?selected_session_id=sess-sync", headers=headers)
    assert first.status_code == 200, first.text
    first_payload = first.json()
    assert first_payload["selected_session_id"] == "sess-sync"

    unchanged = client.get("/api/sync/status?selected_session_id=sess-sync", headers=headers)
    assert unchanged.status_code == 200, unchanged.text
    assert unchanged.json() == first_payload

    input_response = client.post(
        "/api/sessions/sess-sync/input",
        json={"prompt": "同步状态应该变化"},
        headers=headers,
    )
    assert input_response.status_code == 200, input_response.text

    changed = client.get("/api/sync/status?selected_session_id=sess-sync", headers=headers)
    assert changed.status_code == 200, changed.text
    changed_payload = changed.json()
    assert changed_payload["sessions_digest"] != first_payload["sessions_digest"]
    assert changed_payload["jobs_digest"] != first_payload["jobs_digest"]
    assert changed_payload["selected_timeline_digest"] != first_payload["selected_timeline_digest"]
    assert changed_payload["workers_digest"] == first_payload["workers_digest"]


def test_sync_status_digest_changes_when_same_timeline_seq_is_updated(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-sync-status-same-seq",
            "backend": "claude",
            "worker_id": worker_id,
            "workspace_root": "E:/work",
            "project_name": "work",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "claude/sess-sync-status-same-seq",
            "status": "ready",
            "title": "Same seq sync",
            "metadata": {},
        },
        headers=headers,
    )
    assert session_response.status_code == 200, session_response.text

    first_publish = client.post(
        "/api/internal/sessions/sess-sync-status-same-seq/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 2,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "处理中",
                    "created_at": "2026-04-26T10:01:00Z",
                }
            ],
        },
    )
    assert first_publish.status_code == 200, first_publish.text
    first = client.get("/api/sync/status?selected_session_id=sess-sync-status-same-seq", headers=headers)
    assert first.status_code == 200, first.text

    second_publish = client.post(
        "/api/internal/sessions/sess-sync-status-same-seq/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 2,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "最终回复已经到了",
                    "created_at": "2026-04-26T10:01:00Z",
                }
            ],
        },
    )
    assert second_publish.status_code == 200, second_publish.text
    second = client.get("/api/sync/status?selected_session_id=sess-sync-status-same-seq", headers=headers)
    assert second.status_code == 200, second.text
    assert second.json()["selected_timeline_digest"] != first.json()["selected_timeline_digest"]


def test_cursor_session_sync_materializes_missing_summary_message(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-cursor-summary-reconcile",
            "backend": "claude",
            "worker_id": worker_id,
            "workspace_root": "E:/work",
            "project_name": "work",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "claude/sess-cursor-summary-reconcile",
            "status": "running",
            "title": "Cursor summary reconcile",
            "last_message": "处理中",
            "last_activity_at": "2026-04-26T10:03:00Z",
            "last_role": "assistant",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    old_timeline = client.post(
        "/api/internal/sessions/sess-cursor-summary-reconcile/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 1,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "处理中",
                    "created_at": "2026-04-26T10:03:00Z",
                },
                {
                    "seq": 2,
                    "item_type": "tool_call",
                    "role": "system",
                    "text": "[tool_use] Bash",
                    "created_at": "2026-04-26T10:06:00Z",
                },
            ],
        },
    )
    assert old_timeline.status_code == 200, old_timeline.text
    old_cursor = client.get("/api/sessions/sess-cursor-summary-reconcile/timeline", headers=headers).json()["next_after_cursor"]
    assert old_cursor

    updated_summary = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-cursor-summary-reconcile",
            "backend": "claude",
            "worker_id": worker_id,
            "workspace_root": "E:/work",
            "project_name": "work",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "claude/sess-cursor-summary-reconcile",
            "status": "needs_reply",
            "title": "Cursor summary reconcile",
            "last_message": "已经收口，可以继续下一步",
            "last_activity_at": "2026-04-26T10:07:00Z",
            "last_role": "assistant",
            "metadata": {},
        },
        headers=headers,
    )
    assert updated_summary.status_code == 200, updated_summary.text

    synced = client.get(
        "/api/sync/session/sess-cursor-summary-reconcile",
        params={"cursor": old_cursor},
        headers=headers,
    )
    assert synced.status_code == 200, synced.text
    assert [item["text"] for item in synced.json()["items"]] == ["已经收口，可以继续下一步"]
    assert synced.json()["items"][0]["payload"]["source"] == "session_summary_reconciliation"


def test_opening_timeline_materializes_missing_summary_message(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-open-summary-reconcile",
            "backend": "claude",
            "worker_id": worker_id,
            "workspace_root": "E:/work",
            "project_name": "work",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "claude/sess-open-summary-reconcile",
            "status": "ready",
            "title": "Open summary reconcile",
            "last_message": "旧消息",
            "last_activity_at": "2026-04-26T10:01:00Z",
            "last_role": "assistant",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    old_timeline = client.post(
        "/api/internal/sessions/sess-open-summary-reconcile/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 1,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "旧消息",
                    "created_at": "2026-04-26T10:01:00Z",
                },
                {
                    "seq": 2,
                    "item_type": "tool_call",
                    "role": "system",
                    "text": "[tool_use] Bash",
                    "created_at": "2026-04-26T10:06:00Z",
                },
            ],
        },
    )
    assert old_timeline.status_code == 200, old_timeline.text

    updated_summary = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-open-summary-reconcile",
            "backend": "claude",
            "worker_id": worker_id,
            "workspace_root": "E:/work",
            "project_name": "work",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "claude/sess-open-summary-reconcile",
            "status": "needs_reply",
            "title": "Open summary reconcile",
            "last_message": "最终消息已到",
            "last_activity_at": "2026-04-26T10:07:00Z",
            "last_role": "assistant",
            "metadata": {},
        },
        headers=headers,
    )
    assert updated_summary.status_code == 200, updated_summary.text

    timeline = client.get("/api/sessions/sess-open-summary-reconcile/timeline", headers=headers)
    assert timeline.status_code == 200, timeline.text
    assert "最终消息已到" in [item["text"] for item in timeline.json()["items"]]


def test_summary_timeline_backfill_repairs_legacy_sessions(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-maintenance-summary-reconcile",
            "backend": "claude",
            "worker_id": worker_id,
            "workspace_root": "E:/work",
            "project_name": "work",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "claude/sess-maintenance-summary-reconcile",
            "status": "ready",
            "title": "Maintenance summary reconcile",
            "last_message": "旧消息",
            "last_activity_at": "2026-04-26T10:01:00Z",
            "last_role": "assistant",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text
    old_timeline = client.post(
        "/api/internal/sessions/sess-maintenance-summary-reconcile/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 1,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "旧消息",
                    "created_at": "2026-04-26T10:01:00Z",
                }
            ],
        },
    )
    assert old_timeline.status_code == 200, old_timeline.text
    updated = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-maintenance-summary-reconcile",
            "backend": "claude",
            "worker_id": worker_id,
            "workspace_root": "E:/work",
            "project_name": "work",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "claude/sess-maintenance-summary-reconcile",
            "status": "needs_reply",
            "title": "Maintenance summary reconcile",
            "last_message": "最终消息已到",
            "last_activity_at": "2026-04-26T10:07:00Z",
            "last_role": "assistant",
            "metadata": {},
        },
        headers=headers,
    )
    assert updated.status_code == 200, updated.text

    with client.app.state.SessionLocal() as db:
        dry_run = backfill_session_summary_timeline_rows(db, dry_run=True)
        assert dry_run.as_dict()["by_backend"] == {"claude": 1}
        assert dry_run.candidates == 1
        assert dry_run.created == 0
        assert (
            db.query(AgentTimeline)
            .filter(AgentTimeline.session_id == "sess-maintenance-summary-reconcile", AgentTimeline.text == "最终消息已到")
            .count()
            == 0
        )

        applied = backfill_session_summary_timeline_rows(db, dry_run=False)
        db.commit()
        assert applied.candidates == 1
        assert applied.created == 1

        repeated = backfill_session_summary_timeline_rows(db, dry_run=False)
        assert repeated.candidates == 0
        assert repeated.created == 0
        assert (
            db.query(AgentTimeline)
            .filter(AgentTimeline.session_id == "sess-maintenance-summary-reconcile", AgentTimeline.text == "最终消息已到")
            .count()
            == 1
        )


def test_summary_timeline_backfill_handles_shared_runtime_ids_across_spaces(client: TestClient) -> None:
    bootstrap_owner(client)

    with client.app.state.SessionLocal() as db:
        db.add_all(
            [
                Space(space_id="space-a", name="Space A", slug="space-a"),
                Space(space_id="space-b", name="Space B", slug="space-b"),
            ]
        )
        db.flush()
        db.add_all(
            [
                AgentSession(
                    space_id="space-a",
                    session_id="shared-runtime-id",
                    backend="codex",
                    worker_id="worker-a",
                    workspace_root="E:/work/a",
                    project_name="a",
                    runtime_session_ref="shared-runtime-id",
                    status="needs_reply",
                    title="A",
                    display_title="A",
                    last_message="space a final",
                    last_role="assistant",
                    last_activity_at=datetime(2026, 4, 26, 10, 7),
                ),
                AgentSession(
                    space_id="space-b",
                    session_id="shared-runtime-id",
                    backend="codex",
                    worker_id="worker-b",
                    workspace_root="E:/work/b",
                    project_name="b",
                    runtime_session_ref="shared-runtime-id",
                    status="needs_reply",
                    title="B",
                    display_title="B",
                    last_message="space b final",
                    last_role="assistant",
                    last_activity_at=datetime(2026, 4, 26, 10, 8),
                ),
                AgentTimeline(
                    space_id="space-a",
                    session_id="shared-runtime-id",
                    seq=1,
                    item_type="assistant_message",
                    role="assistant",
                    text="space a old",
                    status="completed",
                    created_at=datetime(2026, 4, 26, 10, 1),
                    updated_at=datetime(2026, 4, 26, 10, 1),
                ),
            ]
        )
        db.commit()

        result = backfill_session_summary_timeline_rows(db, dry_run=False)
        db.commit()

        assert result.candidates == 2
        assert result.created == 2
        rows = (
            db.query(AgentTimeline)
            .filter(AgentTimeline.session_id == "shared-runtime-id")
            .order_by(AgentTimeline.seq.asc())
            .all()
        )
        assert [(row.space_id, row.seq, row.text) for row in rows] == [
            ("space-a", 1, "space a old"),
            ("space-b", 2, "space b final"),
            ("space-a", 3, "space a final"),
        ]


def test_operator_can_enqueue_session_fast_refresh_and_toggle_jobs(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-fast",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-fast",
            "status": "ready",
            "title": "Fast state",
            "last_message": "",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    refresh = client.post("/api/sessions/sess-fast/fast/refresh", headers=headers)
    assert refresh.status_code == 200, refresh.text
    assert refresh.json()["job"]["kind"] == "session_fast_state_refresh"
    claimed_refresh = client.post(
        "/api/internal/jobs/claim",
        headers=worker_headers,
        json={"worker_id": worker_id},
    )
    assert claimed_refresh.status_code == 200, claimed_refresh.text
    assert claimed_refresh.json()["job"]["payload"]["runtime_session_ref"] == "codex/sess-fast"

    toggle = client.post("/api/sessions/sess-fast/fast", headers=headers, json={"enabled": True})
    assert toggle.status_code == 200, toggle.text
    assert toggle.json()["job"]["kind"] == "session_fast_toggle"
    assert toggle.json()["job"]["target_session_id"] == "sess-fast"
    claimed_toggle = client.post(
        "/api/internal/jobs/claim",
        headers=worker_headers,
        json={"worker_id": worker_id},
    )
    assert claimed_toggle.status_code == 200, claimed_toggle.text
    assert claimed_toggle.json()["job"]["payload"]["runtime_session_ref"] == "codex/sess-fast"


def test_fast_job_completion_updates_session_runtime_metadata(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-fast-complete",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-fast-complete",
            "status": "ready",
            "title": "Fast completion",
            "last_message": "",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    toggle = client.post("/api/sessions/sess-fast-complete/fast", headers=headers, json={"enabled": True})
    assert toggle.status_code == 200, toggle.text
    job_id = toggle.json()["job"]["job_id"]

    claimed = client.post(
        "/api/internal/jobs/claim",
        headers=worker_headers,
        json={"worker_id": worker_id},
    )
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == job_id

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "result_text": dumps_json(
                {
                    "state": "enabled",
                    "service_tier": "priority",
                    "reasoning_effort": "minimal",
                    "raw": {"settings": {"serviceTier": "priority", "reasoningEffort": "minimal"}},
                }
            ),
        },
    )
    assert completed.status_code == 200, completed.text

    listed = client.get("/api/sessions/sess-fast-complete", headers=headers)
    assert listed.status_code == 200, listed.text
    fast_mode = listed.json()["session"]["runtime_metadata"]["fast_mode"]
    assert fast_mode["state"] == "enabled"
    assert fast_mode["service_tier"] == "priority"
    assert fast_mode["reasoning_effort"] == "minimal"


def test_inbox_sync_returns_only_changed_sessions_and_archive_removals(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    for session_id, title in [("sess-alpha", "Alpha"), ("sess-beta", "Beta")]:
        response = client.post(
            "/api/sessions",
            json={
                "session_id": session_id,
                "backend": "codex",
                "worker_id": worker["worker"]["worker_id"],
                "workspace_root": "E:/work/AgentHub",
                "project_name": "AgentHub",
                "namespace": "default",
                "mode": "direct_reply",
                "runtime_session_ref": f"codex/{session_id}",
                "status": "ready",
                "title": title,
                "last_message": "ready",
                "metadata": {},
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text

    first = client.get("/api/sync/inbox", headers=headers)
    assert first.status_code == 200, first.text
    first_payload = first.json()
    assert {item["session_id"] for item in first_payload["items"]} == {"sess-alpha", "sess-beta"}
    assert first_payload["removed_session_ids"] == []
    assert first_payload["cursor"]

    unchanged = client.get("/api/sync/inbox", headers=headers, params={"cursor": first_payload["cursor"]})
    assert unchanged.status_code == 200, unchanged.text
    assert unchanged.json()["items"] == []
    assert unchanged.json()["removed_session_ids"] == []

    queued = client.post(
        "/api/sessions/sess-alpha/input",
        json={"prompt": "新的输入"},
        headers=headers,
    )
    assert queued.status_code == 200, queued.text

    changed = client.get("/api/sync/inbox", headers=headers, params={"cursor": first_payload["cursor"]})
    assert changed.status_code == 200, changed.text
    changed_payload = changed.json()
    assert [item["session_id"] for item in changed_payload["items"]] == ["sess-alpha"]
    assert changed_payload["items"][0]["status"] == "queued"
    assert changed_payload["removed_session_ids"] == []

    archived = client.post("/api/sessions/sess-beta/archive", headers=headers)
    assert archived.status_code == 200, archived.text

    removed = client.get("/api/sync/inbox", headers=headers, params={"cursor": changed_payload["cursor"]})
    assert removed.status_code == 200, removed.text
    removed_payload = removed.json()
    assert removed_payload["items"] == []
    assert removed_payload["removed_session_ids"] == ["sess-beta"]


def test_session_lists_return_compact_runtime_metadata_but_detail_keeps_full_payload(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    runtime_metadata = {
        "fast_mode": {
            "state": "enabled",
            "service_tier": "priority",
            "reasoning_effort": "minimal",
        },
        "messages": [
            {"kind": "assistant_message", "role": "assistant", "text": "x" * 4000, "created_at": "2026-05-01T10:00:00Z"}
        ],
        "nested": {"huge": "y" * 4000},
    }
    metadata = {"large_blob": "z" * 4000, "project": {"name": "AgentHub"}}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-compact-list",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-compact-list",
            "status": "ready",
            "title": "Compact list payload",
            "last_message": "ready",
            "runtime_metadata": runtime_metadata,
            "metadata": metadata,
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    listed = client.get("/api/sessions", headers=headers)
    assert listed.status_code == 200, listed.text
    listed_session = next(item for item in listed.json()["items"] if item["session_id"] == "sess-compact-list")
    assert listed_session["runtime_metadata"] == {}
    assert listed_session["metadata"] == {}

    inbox_sync = client.get("/api/sync/inbox", headers=headers)
    assert inbox_sync.status_code == 200, inbox_sync.text
    synced_session = next(item for item in inbox_sync.json()["items"] if item["session_id"] == "sess-compact-list")
    assert synced_session["runtime_metadata"] == {}
    assert synced_session["metadata"] == {}

    detail = client.get("/api/sessions/sess-compact-list", headers=headers)
    assert detail.status_code == 200, detail.text
    full_session = detail.json()["session"]
    assert full_session["runtime_metadata"]["messages"][0]["text"] == runtime_metadata["messages"][0]["text"]
    assert full_session["runtime_metadata"]["nested"]["huge"] == runtime_metadata["nested"]["huge"]
    assert full_session["metadata"]["large_blob"] == metadata["large_blob"]


def test_job_list_returns_compact_results_but_session_sync_keeps_full_job_output(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-job-compact",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-job-compact",
            "status": "ready",
            "title": "Compact job list",
            "last_message": "ready",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    huge_result = "R" * 4000
    huge_error = "E" * 4000
    with client.app.state.SessionLocal() as db:
        job = Job(
            space_id=created.json()["session"]["space_id"],
            kind="session_input",
            target_session_id="sess-job-compact",
            worker_id=worker["worker"]["worker_id"],
            backend="codex",
            workspace_root="E:/work/AgentHub",
            namespace="default",
            status="failed",
            payload_json=dumps_json({"prompt": "继续执行", "attachments": [{"filename": "image.png"}]}),
            result_text=huge_result,
            error_text=huge_error,
            created_by="usr_owner",
        )
        db.add(job)
        db.commit()
        job_id = job.job_id

    listed = client.get("/api/jobs", headers=headers)
    assert listed.status_code == 200, listed.text
    listed_job = next(item for item in listed.json()["items"] if item["job_id"] == job_id)
    assert listed_job["payload"]["prompt"] == "继续执行"
    assert listed_job["result_text"] is None
    assert listed_job["error_text"].startswith("E" * 50)
    assert len(listed_job["error_text"]) <= 400

    synced = client.get("/api/sync/session/sess-job-compact", headers=headers)
    assert synced.status_code == 200, synced.text
    synced_job = next(item for item in synced.json()["jobs"] if item["job_id"] == job_id)
    assert synced_job["result_text"] == huge_result
    assert synced_job["error_text"] == huge_error


def test_session_sync_returns_only_new_timeline_rows_and_recent_session_jobs(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-delta",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-delta",
            "status": "ready",
            "title": "Delta",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    first_publish = client.post(
        "/api/internal/sessions/sess-delta/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {"seq": 1, "item_type": "user_message", "role": "user", "text": "hello"},
                {"seq": 2, "item_type": "assistant_message", "role": "assistant", "text": "world"},
            ],
        },
    )
    assert first_publish.status_code == 200, first_publish.text

    first = client.get("/api/sync/session/sess-delta", headers=headers)
    assert first.status_code == 200, first.text
    first_payload = first.json()
    assert [item["seq"] for item in first_payload["items"]] == [1, 2]
    assert first_payload["next_after_seq"] == 2
    assert first_payload["session"]["session_id"] == "sess-delta"

    queued = client.post(
        "/api/sessions/sess-delta/input",
        json={"prompt": "继续执行"},
        headers=headers,
    )
    assert queued.status_code == 200, queued.text
    job_id = queued.json()["job"]["job_id"]

    second = client.get("/api/sync/session/sess-delta?after_seq=2", headers=headers)
    assert second.status_code == 200, second.text
    second_payload = second.json()
    assert [item["seq"] for item in second_payload["items"]] == [3]
    assert second_payload["items"][0]["text"] == "继续执行"
    assert second_payload["next_after_seq"] == 3
    assert any(job["job_id"] == job_id for job in second_payload["jobs"])

    unchanged = client.get("/api/sync/session/sess-delta?after_seq=3", headers=headers)
    assert unchanged.status_code == 200, unchanged.text
    assert unchanged.json()["items"] == []


def test_session_sync_cursor_returns_same_seq_timeline_updates(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-delta-cursor",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-delta-cursor",
            "status": "ready",
            "title": "Delta cursor",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    first_publish = client.post(
        "/api/internal/sessions/sess-delta-cursor/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {"seq": 1, "item_type": "user_message", "role": "user", "text": "hello"},
                {"seq": 2, "item_type": "assistant_message", "role": "assistant", "text": "draft"},
            ],
        },
    )
    assert first_publish.status_code == 200, first_publish.text

    first = client.get("/api/sync/session/sess-delta-cursor", headers=headers)
    assert first.status_code == 200, first.text
    first_payload = first.json()
    assert [item["seq"] for item in first_payload["items"]] == [1, 2]
    assert first_payload["items"][1]["text"] == "draft"
    assert first_payload["next_after_cursor"]

    second_publish = client.post(
        "/api/internal/sessions/sess-delta-cursor/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {"seq": 2, "item_type": "assistant_message", "role": "assistant", "text": "final"},
            ],
        },
    )
    assert second_publish.status_code == 200, second_publish.text

    second = client.get(
        "/api/sync/session/sess-delta-cursor",
        params={"cursor": first_payload["next_after_cursor"]},
        headers=headers,
    )
    assert second.status_code == 200, second.text
    second_payload = second.json()
    assert [item["seq"] for item in second_payload["items"]] == [2]
    assert second_payload["items"][0]["text"] == "final"


def test_session_sync_cursor_prioritizes_live_rows_when_history_touch_exceeds_page_limit(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-delta-cursor-history-touch-limit",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-delta-cursor-history-touch-limit",
            "status": "ready",
            "title": "Delta cursor history touch",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    old_created_at = (datetime.utcnow() - timedelta(days=10)).isoformat()
    initial_items = [
        {
            "seq": seq,
            "item_type": "user_message",
            "role": "user",
            "text": f"initial historical prompt {seq}",
            "created_at": old_created_at,
        }
        for seq in range(1, 301)
    ]
    first_publish = client.post(
        "/api/internal/sessions/sess-delta-cursor-history-touch-limit/timeline",
        headers=worker_headers,
        json={"worker_id": worker_id, "items": initial_items},
    )
    assert first_publish.status_code == 200, first_publish.text

    first = client.get(
        "/api/sync/session/sess-delta-cursor-history-touch-limit",
        params={"limit": 500},
        headers=headers,
    )
    assert first.status_code == 200, first.text
    first_payload = first.json()
    assert first_payload["next_after_seq"] == 300
    assert first_payload["next_after_cursor"]

    summary_text = "new assistant reply should not hide behind touched history"
    live_created_at = datetime.utcnow().isoformat()
    replay_items = [
        {
            "seq": seq,
            "item_type": "assistant_message" if seq == 250 else "user_message",
            "role": "assistant" if seq == 250 else "user",
            "text": summary_text if seq == 250 else f"replayed historical prompt {seq}",
            "created_at": live_created_at if seq == 250 else old_created_at,
        }
        for seq in range(1, 501)
    ]
    replay = client.post(
        "/api/internal/sessions/sess-delta-cursor-history-touch-limit/timeline",
        headers=worker_headers,
        json={"worker_id": worker_id, "items": replay_items},
    )
    assert replay.status_code == 200, replay.text

    with client.app.state.SessionLocal() as db:
        summary_row = (
            db.query(AgentTimeline)
            .filter(AgentTimeline.session_id == "sess-delta-cursor-history-touch-limit")
            .filter(AgentTimeline.seq == 250)
            .one()
        )
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-delta-cursor-history-touch-limit").one()
        session.last_message = summary_text
        session.last_role = "assistant"
        session.last_activity_at = summary_row.created_at
        session.updated_at = summary_row.updated_at
        db.commit()

    second = client.get(
        "/api/sync/session/sess-delta-cursor-history-touch-limit",
        params={"cursor": first_payload["next_after_cursor"], "limit": 200},
        headers=headers,
    )
    assert second.status_code == 200, second.text
    second_payload = second.json()
    by_seq = {item["seq"]: item for item in second_payload["items"]}
    assert by_seq[250]["text"] == summary_text


def test_session_sync_after_seq_returns_recent_same_seq_updates_for_legacy_clients(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-delta-after-seq-compat",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-delta-after-seq-compat",
            "status": "ready",
            "title": "Delta after-seq compat",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    first_publish = client.post(
        "/api/internal/sessions/sess-delta-after-seq-compat/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {"seq": 1, "item_type": "user_message", "role": "user", "text": "hello"},
                {"seq": 2, "item_type": "assistant_message", "role": "assistant", "text": "draft"},
            ],
        },
    )
    assert first_publish.status_code == 200, first_publish.text

    first = client.get("/api/sync/session/sess-delta-after-seq-compat", headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["next_after_seq"] == 2

    second_publish = client.post(
        "/api/internal/sessions/sess-delta-after-seq-compat/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {"seq": 2, "item_type": "assistant_message", "role": "assistant", "text": "final"},
            ],
        },
    )
    assert second_publish.status_code == 200, second_publish.text

    second = client.get(
        "/api/sync/session/sess-delta-after-seq-compat",
        params={"after_seq": 2},
        headers=headers,
    )
    assert second.status_code == 200, second.text
    second_payload = second.json()
    assert [item["seq"] for item in second_payload["items"]] == [2]
    assert second_payload["items"][0]["text"] == "final"


def test_session_sync_after_seq_returns_newer_lower_seq_rows_for_legacy_clients(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-delta-lower-seq-compat",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-delta-lower-seq-compat",
            "status": "ready",
            "title": "Delta lower seq compat",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    initial_created_at = (datetime.utcnow() - timedelta(seconds=30)).isoformat()
    first_publish = client.post(
        "/api/internal/sessions/sess-delta-lower-seq-compat/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 10,
                    "item_type": "user_message",
                    "role": "user",
                    "text": "hello",
                    "created_at": initial_created_at,
                },
                {
                    "seq": 20,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "world",
                    "created_at": initial_created_at,
                },
            ],
        },
    )
    assert first_publish.status_code == 200, first_publish.text

    first = client.get("/api/sync/session/sess-delta-lower-seq-compat", headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["next_after_seq"] == 20

    later_created_at = datetime.utcnow().isoformat()
    second_publish = client.post(
        "/api/internal/sessions/sess-delta-lower-seq-compat/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 15,
                    "item_type": "user_message",
                    "role": "user",
                    "text": "preserved local input",
                    "created_at": later_created_at,
                },
            ],
        },
    )
    assert second_publish.status_code == 200, second_publish.text

    second = client.get(
        "/api/sync/session/sess-delta-lower-seq-compat",
        params={"after_seq": 20},
        headers=headers,
    )
    assert second.status_code == 200, second.text
    second_payload = second.json()
    by_seq = {item["seq"]: item for item in second_payload["items"]}
    assert 15 in by_seq
    assert by_seq[15]["text"] == "preserved local input"


def test_session_sync_after_seq_returns_updated_lower_seq_rows_for_legacy_clients(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-delta-lower-seq-updated-compat",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-delta-lower-seq-updated-compat",
            "status": "ready",
            "title": "Delta lower seq updated compat",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    old_created_at = (datetime.utcnow() - timedelta(hours=2)).isoformat()
    first_publish = client.post(
        "/api/internal/sessions/sess-delta-lower-seq-updated-compat/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 10,
                    "item_type": "user_message",
                    "role": "user",
                    "text": "old prompt",
                    "created_at": old_created_at,
                },
                {
                    "seq": 20,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "old visible reply",
                    "created_at": old_created_at,
                },
            ],
        },
    )
    assert first_publish.status_code == 200, first_publish.text

    first = client.get("/api/sync/session/sess-delta-lower-seq-updated-compat", headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["next_after_seq"] == 20

    second_publish = client.post(
        "/api/internal/sessions/sess-delta-lower-seq-updated-compat/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 15,
                    "item_type": "tool_call",
                    "role": "system",
                    "tool_name": "Agent",
                    "text": "late tool result with an old created_at",
                    "created_at": old_created_at,
                },
            ],
        },
    )
    assert second_publish.status_code == 200, second_publish.text

    with client.app.state.SessionLocal() as db:
        row = (
            db.query(AgentTimeline)
            .filter(AgentTimeline.session_id == "sess-delta-lower-seq-updated-compat")
            .filter(AgentTimeline.seq == 15)
            .one()
        )
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-delta-lower-seq-updated-compat").one()
        session.last_message = "old visible reply"
        session.last_role = "assistant"
        session.last_activity_at = row.updated_at - timedelta(seconds=1)
        session.updated_at = row.updated_at
        db.commit()

    second = client.get(
        "/api/sync/session/sess-delta-lower-seq-updated-compat",
        params={"after_seq": 20},
        headers=headers,
    )
    assert second.status_code == 200, second.text
    second_payload = second.json()
    by_seq = {item["seq"]: item for item in second_payload["items"]}
    assert 15 in by_seq
    assert by_seq[15]["text"] == "late tool result with an old created_at"


def test_session_sync_after_seq_includes_summary_row_when_replace_reorders_seq(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-delta-summary-compat",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-delta-summary-compat",
            "status": "ready",
            "title": "Delta summary compat",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    old_created_at = (datetime.utcnow() - timedelta(hours=2)).isoformat()
    first_publish = client.post(
        "/api/internal/sessions/sess-delta-summary-compat/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 10,
                    "item_type": "user_message",
                    "role": "user",
                    "text": "old prompt",
                    "created_at": old_created_at,
                },
                {
                    "seq": 20,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "old visible reply",
                    "created_at": old_created_at,
                },
            ],
        },
    )
    assert first_publish.status_code == 200, first_publish.text

    first = client.get("/api/sync/session/sess-delta-summary-compat", headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["next_after_seq"] == 20

    summary_text = "replace publish produced a lower seq final answer"
    second_publish = client.post(
        "/api/internal/sessions/sess-delta-summary-compat/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 15,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": summary_text,
                    "created_at": old_created_at,
                },
            ],
        },
    )
    assert second_publish.status_code == 200, second_publish.text

    with client.app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-delta-summary-compat").one()
        session.last_message = summary_text
        session.last_role = "assistant"
        session.last_activity_at = datetime.utcnow()
        session.updated_at = datetime.utcnow()
        db.commit()

    second = client.get(
        "/api/sync/session/sess-delta-summary-compat",
        params={"after_seq": 20},
        headers=headers,
    )
    assert second.status_code == 200, second.text
    second_payload = second.json()
    by_seq = {item["seq"]: item for item in second_payload["items"]}
    assert 15 in by_seq
    assert by_seq[15]["text"] == summary_text


def test_session_sync_after_seq_prioritizes_summary_when_history_touch_exceeds_page_limit(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-delta-history-touch-limit",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-delta-history-touch-limit",
            "status": "ready",
            "title": "Delta history touch limit",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    old_created_at = (datetime.utcnow() - timedelta(hours=2)).isoformat()
    initial_items = [
        {
            "seq": seq,
            "item_type": "user_message",
            "role": "user",
            "text": f"initial historical prompt {seq}",
            "created_at": old_created_at,
        }
        for seq in range(1, 301)
    ]
    first_publish = client.post(
        "/api/internal/sessions/sess-delta-history-touch-limit/timeline",
        headers=worker_headers,
        json={"worker_id": worker_id, "items": initial_items},
    )
    assert first_publish.status_code == 200, first_publish.text

    first = client.get("/api/sync/session/sess-delta-history-touch-limit", params={"limit": 500}, headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["next_after_seq"] == 300

    summary_text = "final assistant answer hidden behind touched historical rows"
    replay_items = [
        {
            "seq": seq,
            "item_type": "assistant_message" if seq == 250 else "user_message",
            "role": "assistant" if seq == 250 else "user",
            "text": summary_text if seq == 250 else f"replayed historical prompt {seq}",
            "created_at": old_created_at,
        }
        for seq in range(1, 401)
    ]
    replay = client.post(
        "/api/internal/sessions/sess-delta-history-touch-limit/timeline",
        headers=worker_headers,
        json={"worker_id": worker_id, "items": replay_items},
    )
    assert replay.status_code == 200, replay.text

    with client.app.state.SessionLocal() as db:
        summary_row = (
            db.query(AgentTimeline)
            .filter(AgentTimeline.session_id == "sess-delta-history-touch-limit")
            .filter(AgentTimeline.seq == 250)
            .one()
        )
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-delta-history-touch-limit").one()
        session.last_message = summary_text
        session.last_role = "assistant"
        session.last_activity_at = summary_row.updated_at - timedelta(seconds=1)
        session.updated_at = summary_row.updated_at
        db.commit()

    response = client.get(
        "/api/sync/session/sess-delta-history-touch-limit",
        params={"after_seq": 300, "limit": 200},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    by_seq = {item["seq"]: item for item in payload["items"]}
    assert by_seq[250]["text"] == summary_text
    assert by_seq[400]["text"] == "replayed historical prompt 400"
    assert payload["next_after_seq"] > 300


def test_session_sync_after_seq_materializes_missing_summary_row_before_history_backfill(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-delta-summary-missing",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-delta-summary-missing",
            "status": "ready",
            "title": "Delta missing summary",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    old_created_at = (datetime.utcnow() - timedelta(hours=2)).isoformat()
    historical_items = [
        {
            "seq": seq,
            "item_type": "user_message",
            "role": "user",
            "text": f"historical prompt {seq}",
            "created_at": old_created_at,
        }
        for seq in range(1, 31)
    ]
    publish = client.post(
        "/api/internal/sessions/sess-delta-summary-missing/timeline",
        headers=worker_headers,
        json={"worker_id": worker_id, "items": historical_items},
    )
    assert publish.status_code == 200, publish.text

    summary_text = "current assistant answer only present on the session summary"
    with client.app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-delta-summary-missing").one()
        session.last_message = summary_text
        session.last_role = "assistant"
        session.last_activity_at = datetime.utcnow()
        session.updated_at = datetime.utcnow()
        db.commit()

    response = client.get(
        "/api/sync/session/sess-delta-summary-missing",
        params={"after_seq": 20, "limit": 5},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert any(item["text"] == summary_text and item["role"] == "assistant" for item in payload["items"])
    assert payload["next_after_seq"] > 30

    with client.app.state.SessionLocal() as db:
        materialized = (
            db.query(AgentTimeline)
            .filter(AgentTimeline.session_id == "sess-delta-summary-missing")
            .filter(AgentTimeline.text == summary_text)
            .one_or_none()
        )
        assert materialized is not None
        assert materialized.seq > 30
        assert materialized.item_type == "assistant_message"


def test_permission_sync_returns_incremental_pending_and_resolved_updates(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-perm-delta",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-perm-delta",
            "status": "needs_reply",
            "title": "Permission delta",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text

    with client.app.state.SessionLocal() as db:
        permission = AgentPermission(
            space_id=created.json()["session"]["space_id"],
            session_id="sess-perm-delta",
            worker_id=worker_id,
            backend="codex",
            kind="plan_exit",
            title="计划已生成",
            description="请选择下一步",
            status="pending",
        )
        db.add(permission)
        db.commit()
        permission_id = permission.permission_id

    first = client.get("/api/sync/permissions", headers=headers)
    assert first.status_code == 200, first.text
    first_payload = first.json()
    assert [item["permission_id"] for item in first_payload["items"]] == [permission_id]
    assert first_payload["items"][0]["status"] == "pending"
    assert first_payload["cursor"]

    answered = client.post(
        f"/api/permissions/{permission_id}/respond",
        json={"action": "answer", "response": {"text": "直接实现"}},
        headers=headers,
    )
    assert answered.status_code == 200, answered.text

    second = client.get("/api/sync/permissions", headers=headers, params={"cursor": first_payload["cursor"]})
    assert second.status_code == 200, second.text
    second_payload = second.json()
    assert [item["permission_id"] for item in second_payload["items"]] == [permission_id]
    assert second_payload["items"][0]["status"] == "answered"

    unchanged = client.get("/api/sync/permissions", headers=headers, params={"cursor": second_payload["cursor"]})
    assert unchanged.status_code == 200, unchanged.text
    assert unchanged.json()["items"] == []


def test_session_ordering_compiles_for_old_sqlite_without_nulls_last() -> None:
    statement = select(AgentSession).order_by(*_session_ordering())
    compiled = str(statement.compile(dialect=sqlite.dialect())).upper()

    assert "NULLS LAST" not in compiled
    assert "LAST_ACTIVITY_AT IS NULL" in compiled


def test_viewer_cannot_create_jobs(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    invite = client.post(
        "/api/invites",
        json={"email": "viewer@example.com", "role": "viewer", "expires_in_hours": 1},
        headers=auth_headers(owner_login),
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
            json={"email": "viewer@example.com", "password": "Correct Horse Battery Staple 42"},
            headers={"X-Forwarded-For": "203.0.113.20"},
        ).json()
        forbidden = viewer_browser.post(
            "/api/jobs",
            json={"kind": "health_check"},
            headers=auth_headers(viewer_login),
        )
        assert forbidden.status_code == 403
        worker_runtime_forbidden = viewer_browser.patch(
            "/api/settings/worker-runtime",
            json={"max_concurrent_jobs": 4},
            headers=auth_headers(viewer_login),
        )
        assert worker_runtime_forbidden.status_code == 403


def test_settings_default_and_updates_round_trip(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client, "win-defaults")
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    baseline = client.get("/api/settings", headers=headers)
    assert baseline.status_code == 200, baseline.text
    baseline_payload = baseline.json()
    assert baseline_payload["preferences"] == {
        "locale": "zh-CN",
        "theme_mode": "dark",
        "voice_mode": "streaming",
        "voice_language": "zh-CN",
        "quick_replies": ["继续", "不对，重新来", "等等", "收到，继续", "先停一下"],
    }
    assert [option["value"] for option in baseline_payload["options"]["locales"]] == ["zh-CN", "zh-TW", "en-US"]
    assert baseline_payload["worker_runtime_defaults"] == {
        "max_concurrent_jobs": 2,
        "job_poll_interval_seconds": 5.0,
        "heartbeat_interval_seconds": 30.0,
    }

    pref_patch = client.patch(
        "/api/settings/preferences",
        json={"locale": "zh-TW", "voice_mode": "standard", "voice_language": "zh-TW", "theme_mode": "light"},
        headers=headers,
    )
    assert pref_patch.status_code == 200, pref_patch.text
    assert pref_patch.json()["preferences"]["locale"] == "zh-TW"

    runtime_patch = client.patch(
        "/api/settings/worker-runtime",
        json={"max_concurrent_jobs": 4, "job_poll_interval_seconds": 9, "heartbeat_interval_seconds": 45},
        headers=headers,
    )
    assert runtime_patch.status_code == 200, runtime_patch.text
    assert runtime_patch.json()["worker_runtime_defaults"]["max_concurrent_jobs"] == 4

    listed = client.get("/api/workers", headers=headers)
    assert listed.status_code == 200, listed.text
    updated_worker = next(item for item in listed.json()["items"] if item["worker_id"] == "win-defaults")
    assert updated_worker["runtime_settings"] == {
        "max_concurrent_jobs": 4,
        "job_poll_interval_seconds": 9,
        "heartbeat_interval_seconds": 45,
    }

    heartbeat = client.post(
        "/api/workers/win-defaults/heartbeat",
        headers=worker_headers,
        json={"status": "online"},
    )
    assert heartbeat.status_code == 200, heartbeat.text
    assert heartbeat.json()["worker"]["runtime_settings"] == {
        "max_concurrent_jobs": 4,
        "job_poll_interval_seconds": 9,
        "heartbeat_interval_seconds": 45,
    }
    assert heartbeat.json()["runtime_settings"] == {
        "max_concurrent_jobs": 4,
        "job_poll_interval_seconds": 9,
        "heartbeat_interval_seconds": 45,
    }

    refreshed = client.get("/api/settings", headers=headers)
    assert refreshed.status_code == 200, refreshed.text
    refreshed_payload = refreshed.json()
    assert refreshed_payload["preferences"] == {
        "locale": "zh-TW",
        "theme_mode": "light",
        "voice_mode": "standard",
        "voice_language": "zh-TW",
        "quick_replies": ["继续", "不对，重新来", "等等", "收到，继续", "先停一下"],
    }
    assert refreshed_payload["worker_runtime_defaults"] == {
        "max_concurrent_jobs": 4,
        "job_poll_interval_seconds": 9.0,
        "heartbeat_interval_seconds": 45.0,
    }
    assert any(event["event_type"] == "settings.preferences_update" for event in client.get("/api/events").json()["items"])
    assert any(event["event_type"] == "settings.worker_runtime_update" for event in client.get("/api/events").json()["items"])


def test_user_quick_replies_are_account_preferences(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)

    patch = client.patch(
        "/api/settings/preferences",
        json={"quick_replies": ["继续", "不对，重新来", "等一下"]},
        headers=headers,
    )
    assert patch.status_code == 200, patch.text
    assert patch.json()["preferences"]["quick_replies"] == ["继续", "不对，重新来", "等一下"]

    refreshed = client.get("/api/settings", headers=headers)
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["preferences"]["quick_replies"] == ["继续", "不对，重新来", "等一下"]

    invalid = client.patch(
        "/api/settings/preferences",
        json={"quick_replies": [""]},
        headers=headers,
    )
    assert invalid.status_code == 422


def test_worker_registration_and_heartbeat_return_runtime_settings(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    patch = client.patch(
        "/api/settings/worker-runtime",
        json={"max_concurrent_jobs": 6, "job_poll_interval_seconds": 7, "heartbeat_interval_seconds": 40},
        headers=headers,
    )
    assert patch.status_code == 200, patch.text

    worker = create_worker(client)
    assert worker["runtime_settings"] == {
        "max_concurrent_jobs": 6,
        "job_poll_interval_seconds": 7.0,
        "heartbeat_interval_seconds": 40.0,
    }

    heartbeat = client.post(
        f"/api/workers/{worker['worker']['worker_id']}/heartbeat",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={"status": "online"},
    )
    assert heartbeat.status_code == 200, heartbeat.text
    assert heartbeat.json()["runtime_settings"]["max_concurrent_jobs"] == 6


def test_worker_heartbeat_backfills_historically_stale_runtime_defaults(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client, "win-stale")
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    runtime_patch = client.patch(
        "/api/settings/worker-runtime",
        json={"max_concurrent_jobs": 4, "job_poll_interval_seconds": 9, "heartbeat_interval_seconds": 45},
        headers=headers,
    )
    assert runtime_patch.status_code == 200, runtime_patch.text

    with client.app.state.SessionLocal() as db:
        worker_row = db.query(Worker).filter(Worker.worker_id == "win-stale").one()
        worker_row.max_concurrent_jobs = 2
        worker_row.job_poll_interval_seconds = 5
        worker_row.heartbeat_interval_seconds = 30
        db.commit()

    heartbeat = client.post(
        "/api/workers/win-stale/heartbeat",
        headers=worker_headers,
        json={"status": "online"},
    )
    assert heartbeat.status_code == 200, heartbeat.text
    assert heartbeat.json()["worker"]["runtime_settings"] == {
        "max_concurrent_jobs": 4,
        "job_poll_interval_seconds": 9,
        "heartbeat_interval_seconds": 45,
    }


def test_session_input_creates_queued_job_and_audit_event(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-1",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-1",
            "status": "ready",
            "title": "AgentHub planning",
            "last_message": "ready",
            "metadata": {"branch": "main"},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-1/input",
        json={"prompt": "继续执行安全计划\n保留第二行"},
        headers=auth_headers(owner_login),
    )
    assert input_response.status_code == 200, input_response.text
    assert input_response.json()["job"]["kind"] == "session_input"
    assert input_response.json()["job"]["status"] == "queued"

    jobs = client.get("/api/jobs").json()["items"]
    assert jobs[0]["target_session_id"] == "sess-1"
    assert jobs[0]["payload"]["timeout_seconds"] == 3600

    timeline = client.get("/api/sessions/sess-1/timeline", headers=auth_headers(owner_login)).json()["items"]
    assert len(timeline) == 1
    assert timeline[0]["item_type"] == "user_message"
    assert timeline[0]["role"] == "user"
    assert timeline[0]["text"] == "继续执行安全计划\n保留第二行"
    assert timeline[0]["payload"]["source"] == "session_input"
    assert timeline[0]["payload"]["job_id"] == input_response.json()["job"]["job_id"]

    events = client.get("/api/events").json()["items"]
    assert any(event["event_type"] == "job.create" for event in events)


def test_virtual_autopilot_session_rejects_session_input_in_oss_runtime(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "autopilot-cockpit-2026-06-13",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/Work",
            "project_name": "Autopilot Cockpit",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "autopilot-cockpit-2026-06-13",
            "status": "ready",
            "title": "Autopilot 驾驶舱 2026-06-13",
            "last_message": "ready",
            "runtime_metadata": {"source": "autopilot_cockpit", "date": "2026-06-13"},
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/autopilot-cockpit-2026-06-13/input",
        json={"prompt": "继续"},
        headers=auth_headers(owner_login),
    )
    assert input_response.status_code == 409, input_response.text
    assert input_response.json()["detail"]["code"] == "UNSUPPORTED_VIRTUAL_SESSION"
    assert input_response.json()["detail"]["source"] == "autopilot_cockpit"

    jobs = client.get("/api/jobs").json()["items"]
    assert jobs == []


def test_stale_worker_discovery_does_not_rewind_recent_user_input(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-rewind",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-rewind",
            "status": "ready",
            "title": "AgentHub planning",
            "last_message": "旧的 assistant 消息",
            "last_activity_at": "2026-04-25T10:00:00Z",
            "metadata": {},
        },
        headers=headers,
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-rewind/input",
        json={"prompt": "刚从手机发出的新消息"},
        headers=headers,
    )
    assert input_response.status_code == 200, input_response.text

    with client.app.state.SessionLocal() as db:
        local_session = db.query(AgentSession).filter(AgentSession.session_id == "sess-rewind").one()
        local_activity = local_session.last_activity_at
        assert local_session.last_message == "刚从手机发出的新消息"
        assert local_session.status == "queued"

    stale_discovery = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-rewind",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-rewind",
            "status": "ready",
            "title": "AgentHub planning",
            "last_message": "旧的 assistant 消息",
            "last_activity_at": "2026-04-25T10:00:00Z",
            "metadata": {},
        },
        headers=headers,
    )
    assert stale_discovery.status_code == 200, stale_discovery.text

    with client.app.state.SessionLocal() as db:
        refreshed = db.query(AgentSession).filter(AgentSession.session_id == "sess-rewind").one()
        assert refreshed.last_activity_at == local_activity
        assert refreshed.last_message == "刚从手机发出的新消息"
        assert refreshed.status == "queued"


def test_unchanged_worker_discovery_does_not_advance_session_updated_at(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    session_payload = {
        "session_id": "sess-unchanged-discovery",
        "backend": "claude",
        "worker_id": worker["worker"]["worker_id"],
        "workspace_root": "E:/work/AgentHub",
        "project_name": "AgentHub",
        "namespace": "default",
        "mode": "direct_reply",
        "runtime_session_ref": "claude/sess-unchanged-discovery",
        "status": "needs_reply",
        "title": "Unchanged discovery",
        "activity_summary": "等你回复：旧消息",
        "last_message": "旧消息",
        "last_activity_at": "2026-04-25T10:00:00Z",
        "metadata": {},
    }

    created = client.post("/api/sessions", json=session_payload, headers=headers)
    assert created.status_code == 200, created.text
    frozen_updated_at = datetime(2026, 4, 25, 10, 1, 0)
    with client.app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-unchanged-discovery").one()
        session.updated_at = frozen_updated_at
        db.commit()

    first_sync = client.get("/api/sync/inbox", headers=headers)
    assert first_sync.status_code == 200, first_sync.text
    cursor = first_sync.json()["cursor"]

    rediscovered = client.post("/api/sessions", json=session_payload, headers=headers)
    assert rediscovered.status_code == 200, rediscovered.text

    with client.app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-unchanged-discovery").one()
        assert session.updated_at == frozen_updated_at

    unchanged_delta = client.get("/api/sync/inbox", params={"cursor": cursor}, headers=headers)
    assert unchanged_delta.status_code == 200, unchanged_delta.text
    assert unchanged_delta.json()["items"] == []
    assert unchanged_delta.json()["removed_session_ids"] == []


def test_unchanged_timeline_discovery_does_not_advance_session_updated_at(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}
    worker_id = worker["worker"]["worker_id"]
    session_payload = {
        "session_id": "sess-unchanged-timeline-discovery",
        "backend": "claude",
        "worker_id": worker_id,
        "workspace_root": "E:/work/AgentHub",
        "project_name": "AgentHub",
        "namespace": "default",
        "mode": "direct_reply",
        "runtime_session_ref": "claude/sess-unchanged-timeline-discovery.jsonl",
        "status": "needs_reply",
        "title": "Unchanged timeline discovery",
        "activity_summary": "等你回复：旧消息",
        "last_message": "旧消息",
        "last_activity_at": "2026-04-25T10:00:00Z",
        "runtime_metadata": {
            "timeline": [
                {
                    "seq": 1,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "旧消息",
                    "created_at": "2026-04-25T10:00:00Z",
                }
            ]
        },
        "metadata": {},
    }

    discovered = client.post(
        "/api/internal/sessions/discovered",
        json={"worker_id": worker_id, "sessions": [session_payload]},
        headers=worker_headers,
    )
    assert discovered.status_code == 200, discovered.text
    frozen_updated_at = datetime(2026, 4, 25, 10, 1, 0)
    with client.app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-unchanged-timeline-discovery").one()
        session.updated_at = frozen_updated_at
        db.commit()

    first_sync = client.get("/api/sync/inbox", headers=headers)
    assert first_sync.status_code == 200, first_sync.text
    cursor = first_sync.json()["cursor"]

    rediscovered = client.post(
        "/api/internal/sessions/discovered",
        json={"worker_id": worker_id, "sessions": [session_payload]},
        headers=worker_headers,
    )
    assert rediscovered.status_code == 200, rediscovered.text

    with client.app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-unchanged-timeline-discovery").one()
        assert session.updated_at == frozen_updated_at

    unchanged_delta = client.get("/api/sync/inbox", params={"cursor": cursor}, headers=headers)
    assert unchanged_delta.status_code == 200, unchanged_delta.text
    assert unchanged_delta.json()["items"] == []
    assert unchanged_delta.json()["removed_session_ids"] == []


def test_stale_timeline_replace_does_not_swallow_repeated_recent_user_input(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-repeat-rewind",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-repeat-rewind",
            "status": "ready",
            "title": "AgentHub repeated prompt",
            "last_message": "ready",
            "metadata": {},
        },
        headers=headers,
    )
    assert session_response.status_code == 200, session_response.text

    old_timeline = {
        "worker_id": worker_id,
        "replace": True,
        "items": [
            {
                "seq": 1,
                "item_type": "user_message",
                "role": "user",
                "text": "Implement the plan",
                "created_at": "2026-04-25T10:00:00Z",
            },
            {
                "seq": 2,
                "item_type": "assistant_message",
                "role": "assistant",
                "text": "旧回复",
                "created_at": "2026-04-25T10:01:00Z",
            },
        ],
    }
    timeline_response = client.post(
        "/api/internal/sessions/sess-repeat-rewind/timeline",
        headers=worker_headers,
        json=old_timeline,
    )
    assert timeline_response.status_code == 200, timeline_response.text

    input_response = client.post(
        "/api/sessions/sess-repeat-rewind/input",
        json={"prompt": "Implement the plan"},
        headers=headers,
    )
    assert input_response.status_code == 200, input_response.text

    with client.app.state.SessionLocal() as db:
        local_session = db.query(AgentSession).filter(AgentSession.session_id == "sess-repeat-rewind").one()
        local_activity = local_session.last_activity_at
        assert local_activity is not None
        assert local_activity > datetime(2026, 4, 25, 10, 1)
        assert local_session.last_message == "Implement the plan"

    stale_replace = client.post(
        "/api/internal/sessions/sess-repeat-rewind/timeline",
        headers=worker_headers,
        json=old_timeline,
    )
    assert stale_replace.status_code == 200, stale_replace.text

    with client.app.state.SessionLocal() as db:
        refreshed = db.query(AgentSession).filter(AgentSession.session_id == "sess-repeat-rewind").one()
        rows = (
            db.query(AgentTimeline)
            .filter(AgentTimeline.session_id == "sess-repeat-rewind")
            .order_by(AgentTimeline.seq.asc())
            .all()
        )
        local_rows = [row for row in rows if loads_json(row.payload_json, {}).get("source") == "session_input"]
        assert len(local_rows) == 1
        assert local_rows[0].text == "Implement the plan"
        assert refreshed.last_activity_at == local_activity
        assert refreshed.last_message == "Implement the plan"


def test_session_input_claim_and_completion_refresh_session_activity(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-activity-refresh",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-activity-refresh",
            "status": "ready",
            "title": "AgentHub activity refresh",
            "last_message": "旧消息",
            "last_activity_at": "2026-04-25T10:00:00Z",
            "metadata": {},
        },
        headers=headers,
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-activity-refresh/input",
        json={"prompt": "继续"},
        headers=headers,
    )
    assert input_response.status_code == 200, input_response.text
    job_id = input_response.json()["job"]["job_id"]
    stale_activity = datetime(2026, 4, 25, 10, 0)

    with client.app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-activity-refresh").one()
        session.last_activity_at = stale_activity
        session.updated_at = stale_activity
        db.commit()

    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == job_id

    with client.app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-activity-refresh").one()
        claimed_activity = session.last_activity_at
        assert claimed_activity is not None
        assert claimed_activity > stale_activity
        assert session.status == "running"

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers=worker_headers,
        json={"worker_id": worker_id, "result_text": "执行完成，等待下一步"},
    )
    assert completed.status_code == 200, completed.text

    with client.app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-activity-refresh").one()
        assert session.last_activity_at is not None
        assert session.last_activity_at > claimed_activity
        assert session.status == "ready"
        assert session.last_message == "执行完成，等待下一步"


def test_stale_timeline_sync_does_not_rewind_claim_activity(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-claim-rewind",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-claim-rewind",
            "status": "ready",
            "title": "AgentHub claim rewind",
            "last_message": "旧消息",
            "last_activity_at": "2026-04-25T10:00:00Z",
            "metadata": {},
        },
        headers=headers,
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-claim-rewind/input",
        json={"prompt": "继续"},
        headers=headers,
    )
    assert input_response.status_code == 200, input_response.text

    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text

    with client.app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-claim-rewind").one()
        claimed_activity = session.last_activity_at
        assert claimed_activity is not None
        assert session.status == "running"

    stale_timeline = client.post(
        "/api/internal/sessions/sess-claim-rewind/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "replace": True,
            "items": [
                {
                    "seq": 1,
                    "item_type": "user_message",
                    "role": "user",
                    "text": "旧问题",
                    "created_at": "2026-04-25T10:00:00Z",
                },
                {
                    "seq": 2,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "旧回复",
                    "created_at": "2026-04-25T10:01:00Z",
                },
            ],
        },
    )
    assert stale_timeline.status_code == 200, stale_timeline.text

    with client.app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "sess-claim-rewind").one()
        assert session.last_activity_at == claimed_activity
        assert session.status == "running"


def test_session_archive_hides_from_inbox_and_can_be_restored(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    for session_id, title in [("keep-session", "Keep visible"), ("archive-session", "Archive this")]:
        response = client.post(
            "/api/sessions",
            json={
                "session_id": session_id,
                "backend": "codex",
                "worker_id": worker["worker"]["worker_id"],
                "workspace_root": "E:/work/AgentHub",
                "project_name": "AgentHub",
                "namespace": "default",
                "mode": "direct_reply",
                "runtime_session_ref": f"codex/{session_id}",
                "status": "ready",
                "title": title,
                "last_message": "ready",
                "metadata": {},
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text

    archived = client.post("/api/sessions/archive-session/archive", headers=headers)
    assert archived.status_code == 200, archived.text
    assert archived.json()["session"]["archived_at"] is not None

    inbox = client.get("/api/sessions", headers=headers).json()["items"]
    assert [session["session_id"] for session in inbox] == ["keep-session"]

    archived_list = client.get("/api/sessions?archived=true", headers=headers).json()["items"]
    assert [session["session_id"] for session in archived_list] == ["archive-session"]

    restored = client.post("/api/sessions/archive-session/unarchive", headers=headers)
    assert restored.status_code == 200, restored.text
    assert restored.json()["session"]["archived_at"] is None

    restored_inbox = client.get("/api/sessions", headers=headers).json()["items"]
    assert {session["session_id"] for session in restored_inbox} == {"keep-session", "archive-session"}

    events = client.get("/api/events", headers=headers).json()["items"]
    assert any(event["event_type"] == "session.archive" for event in events)
    assert any(event["event_type"] == "session.unarchive" for event in events)


def test_session_input_accepts_multiple_image_attachments_and_redacts_public_payload(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    image_data = base64.b64encode(VALID_PNG_BYTES).decode("ascii")

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-image",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-image",
            "status": "ready",
            "title": "Image input",
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-image/input",
        json={
            "prompt": "看一下这个截图",
            "attachments": [
                {
                    "filename": "screen.png",
                    "content_type": "image/png",
                    "data_base64": image_data,
                },
                {
                    "filename": "detail.png",
                    "content_type": "image/png",
                    "data_base64": image_data,
                },
            ],
        },
        headers=auth_headers(owner_login),
    )
    assert input_response.status_code == 200, input_response.text

    public_payload = client.get("/api/jobs", headers=auth_headers(owner_login)).json()["items"][0]["payload"]
    assert public_payload["attachments"] == [
        {"filename": "screen.png", "content_type": "image/png", "size_bytes": len(VALID_PNG_BYTES)},
        {"filename": "detail.png", "content_type": "image/png", "size_bytes": len(VALID_PNG_BYTES)},
    ]
    assert "data_base64" not in str(public_payload)

    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.target_session_id == "sess-image").one()
        raw_payload = loads_json(job.payload_json, {})
    assert [item["data_base64"] for item in raw_payload["attachments"]] == [image_data, image_data]

    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}
    claimed = client.post(
        "/api/internal/jobs/claim",
        headers=worker_headers,
        json={"worker_id": worker["worker"]["worker_id"]},
    )
    assert claimed.status_code == 200, claimed.text
    claimed_attachments = claimed.json()["job"]["payload"]["attachments"]
    assert [item["filename"] for item in claimed_attachments] == ["screen.png", "detail.png"]
    assert [item["data_base64"] for item in claimed_attachments] == [image_data, image_data]

    timeline = client.get("/api/sessions/sess-image/timeline", headers=auth_headers(owner_login)).json()["items"]
    assert timeline[0]["payload"]["attachments"][0]["filename"] == "screen.png"
    assert timeline[0]["payload"]["attachments"][1]["filename"] == "detail.png"
    assert "data_base64" not in str(timeline)


def test_worker_timeline_replace_preserves_session_input_attachment_metadata(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    image_data = base64.b64encode(VALID_PNG_BYTES).decode("ascii")
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-image-preserve",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-image-preserve",
            "status": "ready",
            "title": "Attachment preserve",
            "last_message": "ready",
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-image-preserve/input",
        json={
            "prompt": "",
            "attachments": [
                {
                    "filename": "screen.png",
                    "content_type": "image/png",
                    "data_base64": image_data,
                }
            ],
        },
        headers=auth_headers(owner_login),
    )
    assert input_response.status_code == 200, input_response.text

    timeline_response = client.post(
        "/api/internal/sessions/sess-image-preserve/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "replace": True,
            "items": [
                {"seq": 1, "item_type": "assistant_message", "role": "assistant", "text": "旧 transcript 快照"},
            ],
        },
    )
    assert timeline_response.status_code == 200, timeline_response.text

    timeline = client.get("/api/sessions/sess-image-preserve/timeline", headers=auth_headers(owner_login)).json()["items"]
    attachment_row = next(item for item in timeline if item["item_type"] == "user_message")
    assert attachment_row["text"] == "请看这张图片。"
    assert attachment_row["payload"]["attachments"][0]["filename"] == "screen.png"
    assert attachment_row["payload"]["job_id"] == input_response.json()["job"]["job_id"]


def test_session_input_rejects_invalid_image_attachment_bytes(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-invalid-image",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-invalid-image",
            "status": "ready",
            "title": "Invalid image input",
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-invalid-image/input",
        json={
            "prompt": "看截图继续",
            "attachments": [
                {
                    "filename": "screen.png",
                    "content_type": "image/png",
                    "data_base64": base64.b64encode(b"fake-png-bytes").decode("ascii"),
                }
            ],
        },
        headers=auth_headers(owner_login),
    )

    assert input_response.status_code == 400
    assert input_response.json()["detail"]["code"] == "ATTACHMENT_INVALID"


def test_session_input_accepts_one_file_attachment_and_redacts_public_payload(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    file_data = base64.b64encode(b"OPENAI_API_KEY=test").decode("ascii")

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-file",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-file",
            "status": "ready",
            "title": "File input",
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-file/input",
        json={
            "prompt": "用这个配置测试",
            "attachments": [
                {
                    "filename": "config.txt",
                    "content_type": "text/plain",
                    "data_base64": file_data,
                }
            ],
        },
        headers=auth_headers(owner_login),
    )
    assert input_response.status_code == 200, input_response.text

    public_payload = client.get("/api/jobs", headers=auth_headers(owner_login)).json()["items"][0]["payload"]
    assert public_payload["attachments"] == [
        {"filename": "config.txt", "content_type": "text/plain", "size_bytes": len(b"OPENAI_API_KEY=test")}
    ]
    assert "OPENAI_API_KEY" not in str(public_payload)
    assert "data_base64" not in str(public_payload)

    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.target_session_id == "sess-file").one()
        raw_payload = loads_json(job.payload_json, {})
    assert raw_payload["attachments"][0]["data_base64"] == file_data

    timeline = client.get("/api/sessions/sess-file/timeline", headers=auth_headers(owner_login)).json()["items"]
    assert timeline[0]["payload"]["attachments"][0]["filename"] == "config.txt"
    assert "data_base64" not in str(timeline)


def test_admin_can_cancel_running_session_input_to_unblock_session(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        json={
            "session_id": "cancel-stuck-session",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/cancel-stuck-session",
            "status": "ready",
            "title": "Cancel stuck job",
            "last_message": "ready",
            "metadata": {},
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text
    queued = client.post(
        "/api/sessions/cancel-stuck-session/input",
        json={"prompt": "这条会卡住"},
        headers=headers,
    )
    assert queued.status_code == 200, queued.text
    job_id = queued.json()["job"]["job_id"]

    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == job_id

    cancelled = client.post(f"/api/jobs/{job_id}/cancel", headers=headers)
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["job"]["status"] == "cancelled"
    assert "Cancelled by" in cancelled.json()["job"]["error_text"]

    session = client.get("/api/sessions/cancel-stuck-session", headers=headers).json()["session"]
    assert session["status"] == "ready"

    stale_worker_complete = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers=worker_headers,
        json={"worker_id": worker_id, "result_text": "迟到的完成不能覆盖取消"},
    )
    assert stale_worker_complete.status_code == 409


def test_session_input_rejects_too_many_attachments(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    image_data = base64.b64encode(VALID_PNG_BYTES).decode("ascii")

    client.post(
        "/api/sessions",
        json={
            "session_id": "sess-too-many-images",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-too-many-images",
            "status": "ready",
            "title": "Image input",
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )

    input_response = client.post(
        "/api/sessions/sess-too-many-images/input",
        json={
            "prompt": "",
            "attachments": [
                {"filename": f"{index}.png", "content_type": "image/png", "data_base64": image_data}
                for index in range(6)
            ],
        },
        headers=auth_headers(owner_login),
    )

    assert input_response.status_code == 400
    assert input_response.json()["detail"]["code"] == "ATTACHMENT_LIMIT"


def test_session_input_preserves_http_urls_query_fragments_and_newlines(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    prompt = (
        "请检查这个 HTTP 链接：\n"
        "http://example.com/a/b?x=1&next=https%3A%2F%2Fagenthub.example.com%2Fcb%3Fa%3D1#frag\n"
        "以及 HTTPS 链接：https://agenthub.example.com/path?q=http%3A%2F%2Fnested.local%2Fa%3Fb%3D1&ok=true"
    )

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-url",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-url",
            "status": "ready",
            "title": "URL preservation",
            "last_message": "ready",
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-url/input",
        json={"prompt": prompt},
        headers=auth_headers(owner_login),
    )
    assert input_response.status_code == 200, input_response.text

    job_payload = client.get("/api/jobs", headers=auth_headers(owner_login)).json()["items"][0]["payload"]
    assert job_payload["prompt"] == prompt
    assert job_payload["raw_prompt"] == prompt

    timeline = client.get("/api/sessions/sess-url/timeline", headers=auth_headers(owner_login)).json()["items"]
    assert timeline[0]["text"] == prompt


def test_session_input_payload_includes_filtered_handoff_context(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-with-timeline",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-with-timeline",
            "status": "ready",
            "title": "AgentHub deploy fix",
            "activity_summary": "已经完成 API 和 worker 排查，当前需要继续处理旧会话上下文满。",
            "last_message": "准备继续修自动接续",
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    timeline_response = client.post(
        "/api/internal/sessions/sess-with-timeline/timeline",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker["worker"]["worker_id"],
            "replace": True,
            "items": [
                {"seq": 1, "item_type": "user_message", "role": "user", "text": "请实现 AgentHub 控制面"},
                {"seq": 2, "item_type": "tool_call", "role": "system", "text": "very noisy command output"},
                {"seq": 3, "item_type": "assistant_message", "role": "assistant", "text": "已经完成 API 和 worker 基础修复"},
            ],
        },
    )
    assert timeline_response.status_code == 200, timeline_response.text

    input_response = client.post(
        "/api/sessions/sess-with-timeline/input",
        json={"prompt": "继续做 compact fallback"},
        headers=auth_headers(owner_login),
    )
    assert input_response.status_code == 200, input_response.text

    job_payload = client.get("/api/jobs", headers=auth_headers(owner_login)).json()["items"][0]["payload"]
    handoff = job_payload["handoff_context"]
    assert handoff["session_id"] == "sess-with-timeline"
    assert handoff["title"] == "AgentHub deploy fix"
    assert "上下文满" in handoff["activity_summary"]
    assert [item["role"] for item in handoff["timeline"]] == ["user", "assistant"]
    assert "very noisy command output" not in str(handoff)


def test_codex_plan_session_input_uses_native_payload_without_downgrading_controls(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-plan",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-plan",
            "status": "ready",
            "title": "AgentHub plan mode",
            "last_message": "ready",
            "controls": {"sandbox_mode": "danger-full-access", "approval_mode": "never", "yolo": True},
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-plan/input",
        json={"prompt": "优化移动端消息流", "reply_mode": "plan"},
        headers=auth_headers(owner_login),
    )

    assert input_response.status_code == 200, input_response.text
    job_payload = client.get("/api/jobs", headers=auth_headers(owner_login)).json()["items"][0]["payload"]
    assert job_payload["reply_mode"] == "plan"
    assert job_payload["raw_prompt"] == "优化移动端消息流"
    assert job_payload["prompt"] == "优化移动端消息流"
    assert job_payload["native_plan_mode"] is True
    assert job_payload["timeout_seconds"] == 3600
    assert "AGENTHUB_OPTIONS" not in job_payload["prompt"]
    assert job_payload["controls"]["sandbox_mode"] == "danger-full-access"
    assert job_payload["controls"]["approval_mode"] == "never"
    assert job_payload["controls"]["yolo"] is True


def test_codex_plan_completion_writes_plan_timeline_for_cli_fallback(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-plan-fallback",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-plan-fallback",
            "status": "ready",
            "title": "AgentHub plan fallback",
            "last_message": "ready",
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-plan-fallback/input",
        json={"prompt": "先列计划", "reply_mode": "plan"},
        headers=auth_headers(owner_login),
    )
    assert input_response.status_code == 200, input_response.text

    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text
    job_id = claimed.json()["job"]["job_id"]
    result_text = "<proposed_plan>\n1. 修复附件\n2. 修复计划模式\n</proposed_plan>"
    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers=worker_headers,
        json={"worker_id": worker_id, "result_text": result_text},
    )
    assert completed.status_code == 200, completed.text

    timeline = client.get("/api/sessions/sess-plan-fallback/timeline", headers=auth_headers(owner_login)).json()["items"]
    plan_item = next(item for item in timeline if item["item_type"] == "assistant_message" and "修复计划模式" in item["text"])
    assert plan_item["payload"]["source"] == "job_complete_plan_result"
    assert plan_item["payload"]["job_id"] == job_id

    permissions = client.get("/api/permissions", headers=auth_headers(owner_login)).json()["items"]
    permission = next(item for item in permissions if item["session_id"] == "sess-plan-fallback")
    assert permission["kind"] == "plan_exit"
    assert "修复附件" in permission["detail"]["plan_text"]


def test_codex_goal_session_input_uses_native_default_turn(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-goal",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-goal",
            "status": "ready",
            "title": "AgentHub goal mode",
            "last_message": "ready",
            "controls": {"sandbox_mode": "danger-full-access", "approval_mode": "never"},
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-goal/input",
        json={"prompt": "/goal 完成移动端收件箱打磨并通过测试"},
        headers=auth_headers(owner_login),
    )

    assert input_response.status_code == 200, input_response.text
    job_payload = client.get("/api/jobs", headers=auth_headers(owner_login)).json()["items"][0]["payload"]
    assert job_payload["reply_mode"] == "direct"
    assert job_payload["raw_prompt"] == "/goal 完成移动端收件箱打磨并通过测试"
    assert job_payload["prompt"] == "/goal 完成移动端收件箱打磨并通过测试"
    assert job_payload["native_plan_mode"] is False
    assert job_payload["native_goal_command"] is True
    assert job_payload["native_turn_mode"] == "default"


def test_codex_goal_session_input_falls_back_when_provider_snapshot_disables_native_goal(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    space_id = worker["worker"]["space_id"]

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-goal-fallback",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-goal-fallback",
            "status": "ready",
            "title": "AgentHub goal fallback",
            "last_message": "ready",
            "controls": {"sandbox_mode": "danger-full-access", "approval_mode": "never"},
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    with client.app.state.SessionLocal() as db:
        db.add(
            ProviderSnapshot(
                space_id=space_id,
                worker_id=worker_id,
                backend="codex",
                status="ready",
                features_json=dumps_json({"native_goal_command": False}),
                diagnostics_json=dumps_json({"auth_status": "ready"}),
            )
        )
        db.commit()

    input_response = client.post(
        "/api/sessions/sess-goal-fallback/input",
        json={"prompt": "/goal 完成 provider parity 验证"},
        headers=auth_headers(owner_login),
    )

    assert input_response.status_code == 200, input_response.text
    job_payload = client.get("/api/jobs", headers=auth_headers(owner_login)).json()["items"][0]["payload"]
    assert job_payload["reply_mode"] == "direct"
    assert job_payload["raw_prompt"] == "/goal 完成 provider parity 验证"
    assert "进入 AgentHub 目标推进模式" in job_payload["prompt"]
    assert "目标：完成 provider parity 验证" in job_payload["prompt"]
    assert job_payload["native_plan_mode"] is False
    assert "native_goal_command" not in job_payload or job_payload["native_goal_command"] is False
    assert job_payload["native_turn_mode"] == "default"


def test_codex_direct_session_input_uses_native_default_turn(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-direct-default",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-direct-default",
            "status": "ready",
            "title": "AgentHub direct default",
            "last_message": "ready",
            "controls": {"sandbox_mode": "danger-full-access", "approval_mode": "never"},
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-direct-default/input",
        json={"prompt": "不用计划了，直接执行这个修复。"},
        headers=auth_headers(owner_login),
    )

    assert input_response.status_code == 200, input_response.text
    job_payload = client.get("/api/jobs", headers=auth_headers(owner_login)).json()["items"][0]["payload"]
    assert job_payload["reply_mode"] == "direct"
    assert job_payload["raw_prompt"] == "不用计划了，直接执行这个修复。"
    assert job_payload["prompt"] == "不用计划了，直接执行这个修复。"
    assert job_payload["native_plan_mode"] is False
    assert job_payload["native_turn_mode"] == "default"


def test_new_session_input_expires_prior_pending_plan_exit(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    space_id = worker["worker"]["space_id"]

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "expire-old-plan",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/expire-old-plan",
            "status": "needs_reply",
            "title": "Expire old plan",
            "last_message": "计划已生成",
            "metadata": {},
        },
        headers=headers,
    )
    assert session_response.status_code == 200, session_response.text

    from app.core.json import dumps_json
    from app.models import AgentPermission

    with client.app.state.SessionLocal() as db:
        db.add(
            AgentPermission(
                space_id=space_id,
                session_id="expire-old-plan",
                worker_id=worker_id,
                backend="codex",
                kind="plan_exit",
                title="计划已生成",
                description="旧计划",
                detail_json=dumps_json({"source": "codex_plan_exit", "plan_hash": "old", "plan_text": "旧计划"}),
                actions_json=dumps_json({"choices": []}),
                status="pending",
                response_json=dumps_json({}),
            )
        )
        db.commit()

    response = client.post(
        "/api/sessions/expire-old-plan/input",
        json={"prompt": "不用旧计划了，直接修复。"},
        headers=headers,
    )
    assert response.status_code == 200, response.text

    pending = client.get("/api/permissions?session_id=expire-old-plan&status=pending", headers=headers).json()["items"]
    assert pending == []
    permissions = client.get("/api/permissions?session_id=expire-old-plan", headers=headers).json()["items"]
    expired = next(item for item in permissions if item["kind"] == "plan_exit")
    assert expired["status"] == "expired"
    assert expired["response"]["action"] == "expired"


def test_claude_goal_session_input_uses_agenthub_goal_alias_prompt(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-claude-goal",
            "backend": "claude",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "claude/sess-claude-goal",
            "status": "ready",
            "title": "AgentHub Claude goal",
            "last_message": "ready",
            "controls": {"permission_mode": "auto"},
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-claude-goal/input",
        json={"prompt": "  /goal 所有移动端搜索体验测试通过"},
        headers=auth_headers(owner_login),
    )

    assert input_response.status_code == 200, input_response.text
    job_payload = client.get("/api/jobs", headers=auth_headers(owner_login)).json()["items"][0]["payload"]
    assert job_payload["reply_mode"] == "direct"
    assert job_payload["raw_prompt"] == "/goal 所有移动端搜索体验测试通过"
    assert "进入 AgentHub 目标推进模式" in job_payload["prompt"]
    assert "目标：所有移动端搜索体验测试通过" in job_payload["prompt"]
    assert job_payload["native_plan_mode"] is False
    assert "native_goal_command" not in job_payload or job_payload["native_goal_command"] is False


def test_opencode_plan_session_input_uses_plan_agent_without_claiming_native_codex_flow(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker_response = client.post(
        "/api/workers/register",
        headers={"Authorization": "Bearer worker-register-test-token"},
        json={
            "worker_id": "worker-opencode",
            "machine_name": "DevBox",
            "os": "windows",
            "reachable_backends": ["opencode"],
            "workspace_roots": ["E:/work"],
            "capabilities": {"opencode": True},
        },
    )
    assert worker_response.status_code == 200, worker_response.text
    worker = worker_response.json()
    headers = auth_headers(owner_login)
    response = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "sess-opencode-plan",
            "backend": "opencode",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "opencode/sess-opencode-plan",
            "status": "needs_reply",
            "title": "AgentHub OpenCode plan",
            "display_title": "OpenCode 规划",
            "activity_summary": "等你回复：先规划再执行",
            "last_message": "先规划再执行",
        },
    )
    assert response.status_code == 200

    input_response = client.post(
        "/api/sessions/sess-opencode-plan/input",
        headers=headers,
        json={"prompt": "梳理 provider 接入差异", "reply_mode": "plan"},
    )
    assert input_response.status_code == 200

    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.target_session_id == "sess-opencode-plan").order_by(Job.created_at.desc()).first()
        assert job is not None
        job_payload = loads_json(job.payload_json, {})

    assert job_payload["reply_mode"] == "plan"
    assert job_payload["native_plan_mode"] is False
    assert job_payload["controls"]["agent"] == "plan"
    assert "按这个计划执行" in job_payload["prompt"]
    assert "native_turn_mode" not in job_payload


def test_session_input_rejects_worker_without_backend(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker_response = client.post(
        "/api/workers/register",
        headers={"Authorization": "Bearer worker-register-test-token"},
        json={
            "worker_id": "vm-main",
            "machine_name": "VM",
            "os": "linux",
            "reachable_backends": ["tmux"],
            "workspace_roots": ["/opt/work"],
            "capabilities": {"tmux": True},
        },
    )
    assert worker_response.status_code == 200, worker_response.text

    session_response = client.post(
        "/api/sessions",
        json={
            "session_id": "sess-missing-codex",
            "backend": "codex",
            "worker_id": "vm-main",
            "workspace_root": "/opt/work",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-missing-codex",
            "status": "ready",
            "title": "VM Codex",
            "last_message": "ready",
            "metadata": {},
        },
        headers=auth_headers(owner_login),
    )
    assert session_response.status_code == 200, session_response.text

    input_response = client.post(
        "/api/sessions/sess-missing-codex/input",
        json={"prompt": "继续执行"},
        headers=auth_headers(owner_login),
    )

    assert input_response.status_code == 409
    assert input_response.json()["detail"]["code"] == "WORKER_BACKEND_UNAVAILABLE"


def test_session_start_creates_worker_owned_job_with_controls_and_audit(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)

    response = client.post(
        "/api/sessions/start",
        headers=auth_headers(owner_login),
        json={
            "worker_id": worker["worker"]["worker_id"],
            "backend": "claude",
            "workspace_root": "E:/work/AgentHub",
            "namespace": "default",
            "prompt": "新建一个 AgentHub UI 优化会话",
            "title": "AgentHub UI session",
            "controls": {"model": "sonnet", "permission_mode": "auto", "interaction_bridge": "tmux"},
        },
    )

    assert response.status_code == 200, response.text
    job = response.json()["job"]
    assert job["kind"] == "session_start"
    assert job["target_session_id"] is None
    assert job["worker_id"] == worker["worker"]["worker_id"]
    assert job["backend"] == "claude"
    assert job["workspace_root"] == "E:/work/AgentHub"
    assert job["payload"]["prompt"] == "新建一个 AgentHub UI 优化会话"
    assert job["payload"]["title"] == "AgentHub UI session"
    assert job["payload"]["controls"]["permission_mode"] == "auto"
    assert job["payload"]["controls"]["interaction_bridge"] == "tmux"
    assert job["payload"]["timeout_seconds"] == 3600

    timed_response = client.post(
        "/api/sessions/start",
        headers=auth_headers(owner_login),
        json={
            "worker_id": worker["worker"]["worker_id"],
            "backend": "claude",
            "workspace_root": "E:/work/AgentHub",
            "namespace": "default",
            "prompt": "短超时 smoke",
            "timeout_seconds": 180,
        },
    )
    assert timed_response.status_code == 200, timed_response.text
    assert timed_response.json()["job"]["payload"]["timeout_seconds"] == 180

    with client.app.state.SessionLocal() as db:
        event_types = [row.event_type for row in db.query(Event).order_by(Event.created_at.asc()).all()]
    assert "session.start" in event_types


def test_session_start_rejects_worker_without_backend(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker_response = client.post(
        "/api/workers/register",
        headers={"Authorization": "Bearer worker-register-test-token"},
        json={
            "worker_id": "linux-no-codex",
            "machine_name": "VM",
            "os": "linux",
            "reachable_backends": ["tmux"],
            "workspace_roots": ["/opt/work"],
            "capabilities": {"tmux": True},
        },
    )
    assert worker_response.status_code == 200, worker_response.text

    response = client.post(
        "/api/sessions/start",
        headers=auth_headers(owner_login),
        json={
            "worker_id": "linux-no-codex",
            "backend": "codex",
            "workspace_root": "/opt/work",
            "prompt": "should fail",
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "WORKER_BACKEND_UNAVAILABLE"


def test_session_fork_creates_job_with_handoff_context_and_keeps_source_ready(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]

    session_response = client.post(
        "/api/sessions",
        headers=auth_headers(owner_login),
        json={
            "session_id": "fork-source",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "runtime_session_ref": "codex/fork-source.jsonl",
            "status": "ready",
            "title": "AgentHub fork source",
            "activity_summary": "已经完成登录和移动端排查",
            "controls": {"sandbox_mode": "danger-full-access", "approval_mode": "never"},
        },
    )
    assert session_response.status_code == 200, session_response.text
    timeline_response = client.post(
        "/api/internal/sessions/fork-source/timeline",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker_id,
            "replace": True,
            "items": [
                {"seq": 1, "item_type": "user_message", "role": "user", "text": "先修 UI"},
                {"seq": 2, "item_type": "assistant_message", "role": "assistant", "text": "已经改好回复区"},
            ],
        },
    )
    assert timeline_response.status_code == 200, timeline_response.text

    response = client.post(
        "/api/sessions/fork-source/fork",
        headers=auth_headers(owner_login),
        json={"prompt": "基于当前上下文开一个新会话继续处理新建 session", "title": "Fork: 新建 session"},
    )

    assert response.status_code == 200, response.text
    job = response.json()["job"]
    assert job["kind"] == "session_fork"
    assert job["target_session_id"] == "fork-source"
    assert job["worker_id"] == worker_id
    assert job["backend"] == "codex"
    assert job["payload"]["prompt"] == "基于当前上下文开一个新会话继续处理新建 session"
    assert job["payload"]["title"] == "Fork: 新建 session"
    assert job["payload"]["source_session_id"] == "fork-source"
    assert job["payload"]["handoff_context"]["title"] == "AgentHub fork source"
    assert [item["role"] for item in job["payload"]["handoff_context"]["timeline"]] == ["user", "assistant"]

    source = client.get("/api/sessions/fork-source", headers=auth_headers(owner_login)).json()["session"]
    assert source["status"] == "ready"


def test_session_fork_claim_and_complete_do_not_mutate_source_session_state(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}
    client.post(
        "/api/sessions",
        headers=auth_headers(owner_login),
        json={
            "session_id": "fork-source-running",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/fork-source-running.jsonl",
            "status": "ready",
        },
    )
    created = client.post(
        "/api/sessions/fork-source-running/fork",
        headers=auth_headers(owner_login),
        json={"prompt": "fork 一条新线"},
    )
    assert created.status_code == 200, created.text
    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text
    completed = client.post(
        f"/api/internal/jobs/{claimed.json()['job']['job_id']}/complete",
        headers=worker_headers,
        json={"worker_id": worker_id, "result_text": "created_session_id=new-fork"},
    )
    assert completed.status_code == 200, completed.text

    source = client.get("/api/sessions/fork-source-running", headers=auth_headers(owner_login)).json()["session"]
    assert source["status"] == "ready"
    assert source["last_message"] != "created_session_id=new-fork"


def test_session_btw_creates_sidecar_job_and_attaches_result_without_queueing_source(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "btw-source",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/btw-source.jsonl",
            "status": "running",
            "title": "主线任务",
            "activity_summary": "正在实现主线功能",
            "controls": {"sandbox_mode": "danger-full-access", "approval_mode": "never"},
        },
    )
    assert created.status_code == 200, created.text
    timeline_response = client.post(
        "/api/internal/sessions/btw-source/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "replace": True,
            "items": [
                {"seq": 1, "item_type": "user_message", "role": "user", "text": "先实现交互总线"},
                {"seq": 2, "item_type": "assistant_message", "role": "assistant", "text": "交互总线已经接近完成"},
            ],
        },
    )
    assert timeline_response.status_code == 200, timeline_response.text

    response = client.post(
        "/api/sessions/btw-source/btw",
        headers=headers,
        json={"prompt": "顺便分析一下 Secrets 应该怎么接入"},
    )

    assert response.status_code == 200, response.text
    job = response.json()["job"]
    assert job["kind"] == "session_btw"
    assert job["target_session_id"] == "btw-source"
    assert job["payload"]["prompt"] == "顺便分析一下 Secrets 应该怎么接入"
    assert job["payload"]["source_session_id"] == "btw-source"
    assert [item["role"] for item in job["payload"]["handoff_context"]["timeline"]] == ["user", "assistant"]

    source_after_enqueue = client.get("/api/sessions/btw-source", headers=headers).json()["session"]
    assert source_after_enqueue["status"] == "running"

    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == job["job_id"]
    completed = client.post(
        f"/api/internal/jobs/{job['job_id']}/complete",
        headers=worker_headers,
        json={"worker_id": worker_id, "result_text": "Secrets 应该按环境和命名空间隔离。"},
    )
    assert completed.status_code == 200, completed.text

    source_after_complete = client.get("/api/sessions/btw-source", headers=headers).json()["session"]
    assert source_after_complete["status"] == "running"
    timeline = client.get("/api/sessions/btw-source/timeline", headers=headers).json()["items"]
    assert timeline[-1]["item_type"] == "assistant_message"
    assert timeline[-1]["payload"]["source"] == "btw"
    assert timeline[-1]["payload"]["job_id"] == job["job_id"]
    assert timeline[-1]["text"] == "Secrets 应该按环境和命名空间隔离。"


def test_session_file_list_creates_sidecar_job_that_can_claim_while_session_is_busy(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "files-source",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/files-source.jsonl",
            "status": "running",
            "title": "移动端文件入口",
        },
    )
    assert created.status_code == 200, created.text
    with client.app.state.SessionLocal() as db:
        running = Job(
            kind="session_input",
            target_session_id="files-source",
            worker_id=worker_id,
            backend="codex",
            workspace_root="E:/work/AgentHub",
            namespace="default",
            status="running",
            payload_json=dumps_json({"prompt": "主线还在运行"}),
        )
        db.add(running)
        db.commit()

    response = client.post(
        "/api/sessions/files-source/files/list",
        headers=headers,
        json={"path": "."},
    )

    assert response.status_code == 200, response.text
    job = response.json()["job"]
    assert job["kind"] == "file_list"
    assert job["target_session_id"] == "files-source"
    assert job["payload"] == {"path": "."}

    source_after_enqueue = client.get("/api/sessions/files-source", headers=headers).json()["session"]
    assert source_after_enqueue["status"] == "running"

    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == job["job_id"]


def test_session_file_read_creates_read_job_without_mutating_session_status(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)

    created = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "files-read-source",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/files-read-source.jsonl",
            "status": "ready",
            "title": "读取文件",
        },
    )
    assert created.status_code == 200, created.text

    response = client.post(
        "/api/sessions/files-read-source/files/read",
        headers=headers,
        json={"path": "README.md", "max_bytes": 4096},
    )

    assert response.status_code == 200, response.text
    job = response.json()["job"]
    assert job["kind"] == "file_read"
    assert job["payload"] == {"path": "README.md", "max_bytes": 4096}
    source_after_enqueue = client.get("/api/sessions/files-read-source", headers=headers).json()["session"]
    assert source_after_enqueue["status"] == "ready"


def test_session_file_read_accepts_large_mobile_preview_request(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)

    created = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "files-read-large",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/files-read-large.jsonl",
            "status": "ready",
            "title": "读取大文件预览",
        },
    )
    assert created.status_code == 200, created.text

    response = client.post(
        "/api/sessions/files-read-large/files/read",
        headers=headers,
        json={"path": "src/diagram.png", "max_bytes": 5_000_000},
    )

    assert response.status_code == 200, response.text
    job = response.json()["job"]
    assert job["kind"] == "file_read"
    assert job["payload"] == {"path": "src/diagram.png", "max_bytes": 5_000_000}


def test_session_file_write_creates_write_job_without_mutating_session_status(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)

    created = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "files-write-source",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/files-write-source.jsonl",
            "status": "ready",
            "title": "编辑文件",
        },
    )
    assert created.status_code == 200, created.text

    response = client.post(
        "/api/sessions/files-write-source/files/write",
        headers=headers,
        json={"path": "README.md", "text": "# AgentHub\n", "expected_modified_at": "2026-06-15T12:00:00Z"},
    )

    assert response.status_code == 200, response.text
    job = response.json()["job"]
    assert job["kind"] == "file_write"
    assert job["payload"] == {
        "path": "README.md",
        "text": "# AgentHub\n",
        "expected_modified_at": "2026-06-15T12:00:00Z",
    }
    source_after_enqueue = client.get("/api/sessions/files-write-source", headers=headers).json()["session"]
    assert source_after_enqueue["status"] == "ready"


def test_session_file_mutation_jobs_are_whitelisted_sidecars(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)

    created = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "files-mutate-source",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/files-mutate-source.jsonl",
            "status": "running",
            "title": "文件变更",
        },
    )
    assert created.status_code == 200, created.text

    responses = [
        client.post(
            "/api/sessions/files-mutate-source/files/upload",
            headers=headers,
            json={
                "path": ".",
                "filename": "hello.txt",
                "content_type": "text/plain",
                "data_base64": "aGVsbG8=",
                "overwrite": False,
            },
        ),
        client.post(
            "/api/sessions/files-mutate-source/files/create",
            headers=headers,
            json={"path": "notes/today.md", "text": "# today\n", "overwrite": False},
        ),
        client.post(
            "/api/sessions/files-mutate-source/files/mkdir",
            headers=headers,
            json={"path": "notes"},
        ),
        client.post(
            "/api/sessions/files-mutate-source/files/rename",
            headers=headers,
            json={"path": "notes/today.md", "new_path": "notes/tomorrow.md"},
        ),
    ]

    for response, expected_kind in zip(responses, ["file_upload", "file_create", "file_mkdir", "file_rename"], strict=False):
        assert response.status_code == 200, response.text
        assert response.json()["job"]["kind"] == expected_kind

    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}
    claimed_kinds: list[str] = []
    for _ in range(4):
        claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
        assert claimed.status_code == 200, claimed.text
        claimed_kinds.append(claimed.json()["job"]["kind"])
    assert claimed_kinds == ["file_upload", "file_create", "file_mkdir", "file_rename"]


def test_provider_auth_requires_admin_and_creates_whitelisted_job(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    invite = client.post(
        "/api/invites",
        headers=auth_headers(owner_login),
        json={"email": "operator@example.com", "role": "operator", "expires_in_hours": 1},
    ).json()
    client.post(
        "/api/invites/accept",
        json={
            "invite_token": invite["invite_token"],
            "email": "operator@example.com",
            "password": "Correct Horse Battery Staple 42",
        },
    )
    owner_login = login(client)
    with TestClient(client.app) as operator_browser:
        operator_login = operator_browser.post(
            "/api/auth/login",
            headers={"X-Forwarded-For": "203.0.113.21"},
            json={"email": "operator@example.com", "password": "Correct Horse Battery Staple 42"},
        ).json()
        forbidden = operator_browser.post(
            f"/api/providers/{worker['worker']['worker_id']}/codex/login",
            headers=auth_headers(operator_login),
        )
        assert forbidden.status_code == 403

    response = client.post(
        f"/api/providers/{worker['worker']['worker_id']}/codex/logout",
        headers=auth_headers(owner_login),
    )

    assert response.status_code == 200, response.text
    job = response.json()["job"]
    assert job["kind"] == "provider_logout"
    assert job["worker_id"] == worker["worker"]["worker_id"]
    assert job["backend"] == "codex"
    assert job["payload"] == {"backend": "codex", "action": "logout"}


def test_auth_logout_revokes_session_and_writes_audit(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)

    response = client.post("/api/auth/logout", headers=auth_headers(owner_login))

    assert response.status_code == 200, response.text
    assert client.get("/api/auth/me").status_code == 401
    with client.app.state.SessionLocal() as db:
        assert db.query(Event).filter(Event.event_type == "auth.logout").count() == 1


def test_unknown_job_kind_is_rejected(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    response = client.post(
        "/api/jobs",
        json={"kind": "shell", "payload": {"cmd": "whoami"}},
        headers=auth_headers(owner_login),
    )
    assert response.status_code == 400


def test_discovered_sessions_deduplicates_payload_session_ids(client: TestClient) -> None:
    worker = create_worker(client, "linux-main")
    token = worker["worker_token"]
    payload = {
        "worker_id": "linux-main",
        "sessions": [
            {
                "session_id": "dup-session",
                "backend": "claude",
                "worker_id": "linux-main",
                "workspace_root": "/root/project",
                "project_name": "project",
                "runtime_session_ref": "parent.jsonl",
                "title": "Parent",
            },
            {
                "session_id": "dup-session",
                "backend": "claude",
                "worker_id": "linux-main",
                "workspace_root": "/root/project",
                "project_name": "project",
                "runtime_session_ref": "subagent.jsonl",
                "title": "Subagent",
            },
        ],
    }

    response = client.post(
        "/api/internal/sessions/discovered",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
    )

    assert response.status_code == 200, response.text
    assert response.json()["items"] == [{"session_id": "dup-session"}]


def test_discovered_session_does_not_downgrade_claimed_input_to_needs_reply(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client, "win-main")
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}
    user_headers = auth_headers(owner_login)

    created = client.post(
        "/api/sessions",
        headers=user_headers,
        json={
            "session_id": "sess-running-race",
            "backend": "codex",
            "worker_id": "win-main",
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-running-race",
            "status": "ready",
            "title": "数采平台开发",
            "last_message": "上一轮已经等你回复",
        },
    )
    assert created.status_code == 200, created.text

    queued = client.post(
        "/api/sessions/sess-running-race/input",
        headers=user_headers,
        json={"prompt": "好的，你开始干吧"},
    )
    assert queued.status_code == 200, queued.text

    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": "win-main"})
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["status"] == "running"
    assert client.get("/api/sessions/sess-running-race", headers=user_headers).json()["session"]["status"] == "running"

    discovered = client.post(
        "/api/internal/sessions/discovered",
        headers=worker_headers,
        json={
            "worker_id": "win-main",
            "sessions": [
                {
                    "session_id": "sess-running-race",
                    "backend": "codex",
                    "worker_id": "win-main",
                    "workspace_root": "E:/work/AgentHub",
                    "project_name": "AgentHub",
                    "namespace": "default",
                    "mode": "direct_reply",
                    "runtime_session_ref": "codex/sess-running-race",
                    "status": "needs_reply",
                    "title": "数采平台开发",
                    "last_message": "上一轮已经等你回复",
                    "last_role": "assistant",
                }
            ],
        },
    )
    assert discovered.status_code == 200, discovered.text

    session = client.get("/api/sessions/sess-running-race", headers=user_headers).json()["session"]
    assert session["status"] == "running"


def test_sessions_sort_by_last_activity_and_support_rename_and_controls(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    for session_id, title, last_activity_at in [
        ("older-session", "Older readable title", "2026-04-20T10:00:00Z"),
        ("newer-session", "Newer readable title", "2026-04-26T10:00:00Z"),
    ]:
        response = client.post(
            "/api/sessions",
            json={
                "session_id": session_id,
                "backend": "codex",
                "worker_id": worker["worker"]["worker_id"],
                "workspace_root": "E:/work/AgentHub",
                "project_name": "AgentHub",
                "runtime_session_ref": f"{session_id}.jsonl",
                "display_title": title,
                "activity_summary": f"最近上下文：{title}",
                "last_activity_at": last_activity_at,
                "last_role": "assistant",
                "controls": {"model": "gpt-5.2"},
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text

    items = client.get("/api/sessions", headers=headers).json()["items"]
    assert [item["session_id"] for item in items[:2]] == ["newer-session", "older-session"]
    assert items[0]["display_title"] == "Newer readable title"
    assert items[0]["title"] == "Newer readable title"

    rename = client.post(
        "/api/sessions/newer-session/rename",
        json={"custom_title": "手机端控制台修复"},
        headers=headers,
    )
    assert rename.status_code == 200, rename.text
    assert rename.json()["session"]["display_title"] == "手机端控制台修复"

    controls = client.patch(
        "/api/sessions/newer-session/controls",
        json={"model": "kimi-k2.5", "yolo": True, "sandbox_mode": "danger-full-access", "interaction_bridge": "tmux"},
        headers=headers,
    )
    assert controls.status_code == 200, controls.text
    assert controls.json()["session"]["controls"]["model"] == "kimi-k2.5"
    assert controls.json()["session"]["controls"]["yolo"] is True
    assert controls.json()["session"]["controls"]["interaction_bridge"] == "tmux"


def test_session_without_title_gets_readable_default_name(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    response = client.post(
        "/api/sessions",
        json={
            "session_id": "rollout-20260426-abcdef123456",
            "backend": "codex",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "rollout-20260426-abcdef123456.jsonl",
        },
        headers=headers,
    )

    assert response.status_code == 200, response.text
    title = response.json()["session"]["display_title"]
    assert title
    assert title != "rollout-20260426-abcdef123456"
    assert "AgentHub" in title
    assert "codex" in title


def test_claude_controls_patch_normalizes_legacy_approval_mode(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    response = client.post(
        "/api/sessions",
        json={
            "session_id": "claude-legacy-controls",
            "backend": "claude",
            "worker_id": worker["worker"]["worker_id"],
            "workspace_root": "E:/work/CourseAgent",
            "project_name": "CourseAgent",
            "runtime_session_ref": "claude-legacy-controls.jsonl",
            "controls": {},
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text

    controls = client.patch(
        "/api/sessions/claude-legacy-controls/controls",
        json={"approval_mode": "never"},
        headers=headers,
    )
    assert controls.status_code == 200, controls.text
    payload = controls.json()["session"]["controls"]
    assert payload["permission_mode"] == "bypassPermissions"
    assert "approval_mode" not in payload


def test_legacy_machine_session_titles_are_not_exposed(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    raw_id = "rollout-2026-04-20T10-11-12-019d1234-1b02-7d10-a610-22093589458b"

    db = client.app.state.SessionLocal()
    try:
        owner_space = db.query(SpaceMembership).order_by(SpaceMembership.created_at.asc()).one()
        db.add(
            AgentSession(
                space_id=owner_space.space_id,
                session_id=raw_id,
                backend="codex",
                worker_id="win-main",
                workspace_root="/root/.codex/sessions/2026/04/20",
                project_name="20",
                runtime_session_ref=f"/root/.codex/sessions/2026/04/20/{raw_id}.jsonl",
                status="ready",
                title=raw_id,
                display_title=raw_id,
                heuristic_title="",
                activity_summary="",
                last_message="",
                runtime_metadata_json=dumps_json({}),
                metadata_json=dumps_json({}),
            )
        )
        db.commit()
    finally:
        db.close()

    items = client.get("/api/sessions", headers=headers).json()["items"]
    session = next(item for item in items if item["session_id"] == raw_id)

    assert session["display_title"] == "Codex · 04-20 10:11"
    assert session["title"] == "Codex · 04-20 10:11"
    assert session["activity_summary"] == "当前空闲"


def test_short_ack_session_title_falls_back_to_runtime_identity(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)

    response = client.post(
        "/api/sessions",
        json={
            "session_id": "ack-title-session",
            "backend": "codex",
            "worker_id": "win-main",
            "workspace_root": "E:/work",
            "project_name": "work",
            "runtime_session_ref": "rollout-2026-04-26T18-26-34-ack-title-session.jsonl",
            "title": "回复了",
            "display_title": "回复了",
            "heuristic_title": "回复了",
            "last_message": "回复了",
        },
        headers=headers,
    )

    assert response.status_code == 200, response.text
    session = response.json()["session"]
    assert session["display_title"] == "Codex · 04-26 18:26"
    assert session["title"] == "Codex · 04-26 18:26"


def test_schedules_crud_creates_only_whitelisted_jobs(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)

    created = client.post(
        "/api/schedules",
        json={
            "name": "Windows health check",
            "job_kind": "health_check",
            "interval_seconds": 300,
            "target_worker_id": "win-main",
            "enabled": True,
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text
    schedule_id = created.json()["schedule"]["schedule_id"]

    invalid = client.post(
        "/api/schedules",
        json={"name": "shell", "job_kind": "shell", "interval_seconds": 60},
        headers=headers,
    )
    assert invalid.status_code == 400

    listed = client.get("/api/schedules", headers=headers)
    assert listed.status_code == 200
    assert listed.json()["items"][0]["schedule_id"] == schedule_id

    updated = client.patch(
        f"/api/schedules/{schedule_id}",
        json={"enabled": False, "interval_seconds": 600},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["schedule"]["enabled"] is False

    deleted = client.delete(f"/api/schedules/{schedule_id}", headers=headers)
    assert deleted.status_code == 200, deleted.text


def test_due_schedule_is_materialized_when_worker_claims(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client, "win-main")
    headers = auth_headers(owner_login)

    created = client.post(
        "/api/schedules",
        json={
            "name": "Windows health check",
            "job_kind": "health_check",
            "interval_seconds": 300,
            "target_worker_id": "win-main",
            "enabled": True,
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text
    schedule_id = created.json()["schedule"]["schedule_id"]

    claimed = client.post(
        "/api/internal/jobs/claim",
        json={"worker_id": "win-main"},
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
    )

    assert claimed.status_code == 200, claimed.text
    job = claimed.json()["job"]
    assert job["kind"] == "health_check"
    assert job["status"] == "running"
    assert job["worker_id"] == "win-main"
    assert job["payload"]["schedule_id"] == schedule_id

    schedules = client.get("/api/schedules", headers=headers).json()["items"]
    assert schedules[0]["last_run_at"] is not None
    assert schedules[0]["next_run_at"] is not None
