from __future__ import annotations

import base64

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.dialects import sqlite

from conftest import auth_headers, bootstrap_owner, create_worker, login
from app.core.json import dumps_json, loads_json
from app.models import AgentSession, Event, Job, SpaceMembership
from app.routers.sessions import _session_ordering


VALID_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


def test_anonymous_business_apis_return_401(client: TestClient) -> None:
    response = client.get("/api/sessions")
    assert response.status_code == 401


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


def test_session_input_accepts_one_image_attachment_and_redacts_public_payload(client: TestClient) -> None:
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
                }
            ],
        },
        headers=auth_headers(owner_login),
    )
    assert input_response.status_code == 200, input_response.text

    public_payload = client.get("/api/jobs", headers=auth_headers(owner_login)).json()["items"][0]["payload"]
    assert public_payload["attachments"] == [
        {"filename": "screen.png", "content_type": "image/png", "size_bytes": len(VALID_PNG_BYTES)}
    ]
    assert "data_base64" not in str(public_payload)

    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.target_session_id == "sess-image").one()
        raw_payload = loads_json(job.payload_json, {})
    assert raw_payload["attachments"][0]["data_base64"] == image_data

    timeline = client.get("/api/sessions/sess-image/timeline", headers=auth_headers(owner_login)).json()["items"]
    assert timeline[0]["payload"]["attachments"][0]["filename"] == "screen.png"
    assert "data_base64" not in str(timeline)


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


def test_session_input_rejects_multiple_image_attachments(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    image_data = base64.b64encode(b"fake-png-bytes").decode("ascii")

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
                {"filename": "a.png", "content_type": "image/png", "data_base64": image_data},
                {"filename": "b.png", "content_type": "image/png", "data_base64": image_data},
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
            "backend": "codex",
            "workspace_root": "E:/work/AgentHub",
            "namespace": "default",
            "prompt": "新建一个 AgentHub UI 优化会话",
            "title": "AgentHub UI session",
            "controls": {"model": "gpt-5.4", "sandbox_mode": "danger-full-access", "approval_mode": "never"},
        },
    )

    assert response.status_code == 200, response.text
    job = response.json()["job"]
    assert job["kind"] == "session_start"
    assert job["target_session_id"] is None
    assert job["worker_id"] == worker["worker"]["worker_id"]
    assert job["backend"] == "codex"
    assert job["workspace_root"] == "E:/work/AgentHub"
    assert job["payload"]["prompt"] == "新建一个 AgentHub UI 优化会话"
    assert job["payload"]["title"] == "AgentHub UI session"
    assert job["payload"]["controls"]["approval_mode"] == "never"

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
        json={"model": "kimi-k2.5", "yolo": True, "sandbox_mode": "danger-full-access"},
        headers=headers,
    )
    assert controls.status_code == 200, controls.text
    assert controls.json()["session"]["controls"]["model"] == "kimi-k2.5"
    assert controls.json()["session"]["controls"]["yolo"] is True


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
