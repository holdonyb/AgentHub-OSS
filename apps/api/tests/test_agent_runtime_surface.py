from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from conftest import auth_headers, bootstrap_owner, create_worker, login


def test_discovered_timeline_is_queryable_and_updates_session_tail(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]

    discovered = client.post(
        "/api/internal/sessions/discovered",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker_id,
            "sessions": [
                {
                    "session_id": "timeline-session",
                    "backend": "codex",
                    "worker_id": worker_id,
                    "workspace_root": "E:/work/AgentHub",
                    "project_name": "AgentHub",
                    "runtime_session_ref": "codex/timeline-session.jsonl",
                    "runtime_metadata": {
                        "timeline": [
                            {
                                "seq": 1,
                                "item_type": "user_message",
                                "role": "user",
                                "text": "给这个 session 起一个可读名字",
                                "created_at": "2026-04-26T10:00:00Z",
                            },
                            {
                                "seq": 2,
                                "item_type": "assistant_message",
                                "role": "assistant",
                                "text": "\u001b[7m<script>alert('xss')</script>\u001b[0m\n[7mTaskName[0m",
                                "created_at": "2026-04-26T10:00:01Z",
                            },
                        ]
                    },
                }
            ],
        },
    )
    assert discovered.status_code == 200, discovered.text

    timeline = client.get("/api/sessions/timeline-session/timeline", headers=auth_headers(owner_login))
    assert timeline.status_code == 200, timeline.text
    assert [item["item_type"] for item in timeline.json()["items"]] == ["user_message", "assistant_message"]
    assert timeline.json()["items"][1]["text"] == "<script>alert('xss')</script>\nTaskName"

    session = client.get("/api/sessions/timeline-session", headers=auth_headers(owner_login)).json()["session"]
    assert session["runtime_metadata"]["messages"][-1]["text"] == "<script>alert('xss')</script>\nTaskName"
    assert session["last_message"] == "<script>alert('xss')</script>\nTaskName"


def test_timeline_endpoint_reports_when_older_items_exist(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]

    client.post(
        "/api/sessions",
        headers=auth_headers(owner_login),
        json={
            "session_id": "paged-timeline",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/paged-timeline.jsonl",
            "status": "ready",
        },
    )
    published = client.post(
        "/api/internal/sessions/paged-timeline/timeline",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker_id,
            "replace": True,
            "items": [
                {"seq": index, "item_type": "assistant_message", "role": "assistant", "text": f"消息 {index}"}
                for index in range(1, 5)
            ],
        },
    )
    assert published.status_code == 200, published.text

    first_page = client.get("/api/sessions/paged-timeline/timeline?limit=2", headers=auth_headers(owner_login))

    assert first_page.status_code == 200, first_page.text
    assert first_page.json()["has_more"] is True
    assert [item["seq"] for item in first_page.json()["items"]] == [3, 4]

    older_page = client.get("/api/sessions/paged-timeline/timeline?limit=2&before=3", headers=auth_headers(owner_login))

    assert older_page.status_code == 200, older_page.text
    assert older_page.json()["has_more"] is False
    assert [item["seq"] for item in older_page.json()["items"]] == [1, 2]


def test_timeline_endpoint_pages_by_created_at_when_seq_is_replayed_out_of_order(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)

    session_response = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "time-ordered-timeline",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/time-ordered-timeline.jsonl",
            "status": "ready",
        },
    )
    assert session_response.status_code == 200, session_response.text

    published = client.post(
        "/api/internal/sessions/time-ordered-timeline/timeline",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker_id,
            "replace": True,
            "items": [
                {
                    "seq": 31865,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": "我还要再查一处边界",
                    "created_at": "2026-05-15T13:13:56Z",
                },
                {
                    "seq": 31961,
                    "item_type": "user_message",
                    "role": "user",
                    "text": "ASSISTANT 复制出来的长截图文本",
                    "created_at": "2026-05-15T13:58:13Z",
                },
                {
                    "seq": 32008,
                    "item_type": "user_message",
                    "role": "user",
                    "text": "根本没修好，整个顺序都乱了",
                    "created_at": "2026-05-15T12:38:25Z",
                },
            ],
        },
    )
    assert published.status_code == 200, published.text

    first_page = client.get("/api/sessions/time-ordered-timeline/timeline?limit=2", headers=headers)
    assert first_page.status_code == 200, first_page.text
    assert first_page.json()["has_more"] is True
    assert [item["seq"] for item in first_page.json()["items"]] == [31865, 31961]

    older_page = client.get(
        "/api/sessions/time-ordered-timeline/timeline",
        params={"limit": 2, "before_created_at": "2026-05-15T13:13:56Z", "before_seq": 31865},
        headers=headers,
    )
    assert older_page.status_code == 200, older_page.text
    assert older_page.json()["has_more"] is False
    assert [item["seq"] for item in older_page.json()["items"]] == [32008]


def test_permission_request_sets_attention_and_can_be_resolved_once(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    headers = auth_headers(owner_login)

    client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "needs-approval",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/needs-approval.jsonl",
        },
    )

    requested = client.post(
        "/api/internal/permissions/requested",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker_id,
            "permission": {
                "permission_id": "perm-tool-1",
                "session_id": "needs-approval",
                "backend": "codex",
                "kind": "tool",
                "title": "允许执行 pytest",
                "description": "Codex 请求执行测试命令",
                "detail": {"command": "pytest"},
                "actions": {"allow": True, "deny": True},
            },
        },
    )
    assert requested.status_code == 200, requested.text

    session = client.get("/api/sessions/needs-approval", headers=headers).json()["session"]
    assert session["status"] == "needs_reply"

    listed = client.get("/api/permissions", headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["permission_id"] == "perm-tool-1"
    assert listed.json()["items"][0]["status"] == "pending"

    resolved = client.post(
        "/api/permissions/perm-tool-1/respond",
        headers=headers,
        json={"action": "allow", "response": {"note": "可以执行"}},
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["permission"]["status"] == "allowed"

    duplicate = client.post(
        "/api/permissions/perm-tool-1/respond",
        headers=headers,
        json={"action": "deny", "response": {"note": "重复处理"}},
    )
    assert duplicate.status_code == 409


def test_legacy_plan_completion_creates_question_permission_and_answer_enqueues_continuation(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "plan-needs-choice",
            "backend": "claude",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "claude/plan-needs-choice.jsonl",
            "status": "ready",
        },
    )
    created = client.post(
        "/api/sessions/plan-needs-choice/input",
        headers=headers,
        json={"prompt": "优化消息流", "reply_mode": "plan"},
    )
    assert created.status_code == 200, created.text

    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text
    job_id = claimed.json()["job"]["job_id"]

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "result_text": "计划：先改输入区，再调历史加载。\n\nAGENTHUB_OPTIONS:\n1. 先调整 UI\n2. 直接执行全部",
        },
    )
    assert completed.status_code == 200, completed.text

    session = client.get("/api/sessions/plan-needs-choice", headers=headers).json()["session"]
    assert session["status"] == "needs_reply"
    permissions = client.get("/api/permissions?session_id=plan-needs-choice", headers=headers).json()["items"]
    assert permissions[0]["kind"] == "question"
    assert [choice["label"] for choice in permissions[0]["actions"]["choices"]] == ["先调整 UI", "直接执行全部"]

    answered = client.post(
        f"/api/permissions/{permissions[0]['permission_id']}/respond",
        headers=headers,
        json={"action": "answer", "response": {"choice": "choice_1", "label": "先调整 UI"}},
    )
    assert answered.status_code == 200, answered.text

    jobs = client.get("/api/jobs", headers=headers).json()["items"]
    continuation = next(job for job in jobs if job["status"] == "queued")
    assert continuation["kind"] == "session_input"
    assert continuation["target_session_id"] == "plan-needs-choice"
    assert "先调整 UI" in continuation["payload"]["prompt"]


def test_native_codex_plan_completion_does_not_create_fake_choice_permission(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "native-plan",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/native-plan.jsonl",
            "status": "ready",
        },
    )
    created = client.post(
        "/api/sessions/native-plan/input",
        headers=headers,
        json={"prompt": "优化消息流", "reply_mode": "plan"},
    )
    assert created.status_code == 200, created.text

    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text
    job_id = claimed.json()["job"]["job_id"]

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "result_text": "计划：先改输入区。\n\nAGENTHUB_OPTIONS:\n1. 伪选项不应出现",
        },
    )
    assert completed.status_code == 200, completed.text

    session = client.get("/api/sessions/native-plan", headers=headers).json()["session"]
    assert session["status"] == "needs_reply"
    permissions = client.get("/api/permissions?session_id=native-plan", headers=headers).json()["items"]
    assert len(permissions) == 1
    assert permissions[0]["kind"] == "plan_exit"
    assert permissions[0]["detail"]["source"] == "codex_plan_exit"
    assert [choice["id"] for choice in permissions[0]["actions"]["choices"]] == [
        "implement",
        "clear_context_implement",
        "keep_planning",
        "cancel",
    ]


def test_codex_plan_synced_from_timeline_creates_plan_exit_permission(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    created = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "timeline-native-plan",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/timeline-native-plan.jsonl",
            "status": "ready",
        },
    )
    assert created.status_code == 200, created.text

    plan_text = "<proposed_plan>\n# Admin 管理 Console 完整化方案\n\n## Summary\n升级 /admin。\n</proposed_plan>"
    published = client.post(
        "/api/internal/sessions/timeline-native-plan/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "replace": True,
            "items": [
                {
                    "seq": 1,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": plan_text,
                    "status": "completed",
                    "payload": {
                        "source": "codex_app_server",
                        "reply_mode": "plan",
                        "native_turn_mode": "plan",
                    },
                    "created_at": "2026-05-15T15:19:25Z",
                }
            ],
        },
    )
    assert published.status_code == 200, published.text

    session = client.get("/api/sessions/timeline-native-plan", headers=headers).json()["session"]
    assert session["status"] == "needs_reply"
    permissions = client.get("/api/permissions?session_id=timeline-native-plan&status=pending", headers=headers).json()["items"]
    assert len(permissions) == 1
    assert permissions[0]["kind"] == "plan_exit"
    assert permissions[0]["detail"]["source"] == "codex_plan_exit"
    assert permissions[0]["detail"]["source_type"] == "timeline"
    assert "Admin 管理 Console" in permissions[0]["detail"]["plan_text"]

    republished = client.post(
        "/api/internal/sessions/timeline-native-plan/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "replace": True,
            "items": [
                {
                    "seq": 1,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": plan_text,
                    "status": "completed",
                    "payload": {
                        "source": "codex_app_server",
                        "reply_mode": "plan",
                        "native_turn_mode": "plan",
                    },
                    "created_at": "2026-05-15T15:19:25Z",
                }
            ],
        },
    )
    assert republished.status_code == 200, republished.text
    permissions_after_replay = client.get(
        "/api/permissions?session_id=timeline-native-plan&status=pending",
        headers=headers,
    ).json()["items"]
    assert len(permissions_after_replay) == 1

    answered = client.post(
        f"/api/permissions/{permissions[0]['permission_id']}/respond",
        headers=headers,
        json={"action": "answer", "response": {"choice": "implement", "label": "执行计划"}},
    )
    assert answered.status_code == 200, answered.text

    jobs = client.get("/api/jobs", headers=headers).json()["items"]
    continuation = next(job for job in jobs if job["status"] == "queued")
    assert continuation["target_session_id"] == "timeline-native-plan"
    assert continuation["payload"]["prompt"] == "Implement the plan."
    assert continuation["payload"]["reply_mode"] == "direct"
    assert continuation["payload"]["native_turn_mode"] == "default"


def test_codex_plan_timeline_publish_and_job_complete_share_one_plan_exit(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "native-plan-single-permission",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/native-plan-single-permission.jsonl",
            "status": "ready",
        },
    )
    client.post(
        "/api/sessions/native-plan-single-permission/input",
        headers=headers,
        json={"prompt": "整理 admin console 计划", "reply_mode": "plan"},
    )
    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text
    job_id = claimed.json()["job"]["job_id"]
    plan_text = "# Admin 管理 Console 完整化方案\n\n## Summary\n升级 /admin。"

    published = client.post(
        "/api/internal/sessions/native-plan-single-permission/timeline",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "items": [
                {
                    "seq": 1,
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": plan_text,
                    "status": "completed",
                    "payload": {
                        "source": "codex_app_server",
                        "reply_mode": "plan",
                        "native_turn_mode": "plan",
                    },
                }
            ],
        },
    )
    assert published.status_code == 200, published.text

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers=worker_headers,
        json={"worker_id": worker_id, "result_text": plan_text},
    )
    assert completed.status_code == 200, completed.text

    permissions = client.get(
        "/api/permissions?session_id=native-plan-single-permission&status=pending",
        headers=headers,
    ).json()["items"]
    assert len(permissions) == 1
    assert permissions[0]["kind"] == "plan_exit"
    assert permissions[0]["detail"]["source_type"] == "timeline"


def test_api_startup_does_not_globally_backfill_existing_codex_plan_timeline(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "agenthub-startup-no-plan-backfill.db"
    db_url = f"sqlite+pysqlite:///{db_path.as_posix()}"
    monkeypatch.setenv("AGENTHUB_DATABASE_URL", db_url)
    monkeypatch.setenv("AGENTHUB_BOOTSTRAP_TOKEN", "bootstrap-test-token")
    monkeypatch.setenv("AGENTHUB_WORKER_REGISTRATION_TOKEN", "worker-register-test-token")
    monkeypatch.setenv("AGENTHUB_COOKIE_SECURE", "false")

    from app.core.config import Settings
    from app.core.database import create_db_engine, create_session_local, init_database
    from app.factory import create_app
    from app.models import AgentPermission, AgentSession, AgentTimeline, Space, Worker

    engine = create_db_engine(db_url)
    init_database(engine)
    SessionLocal = create_session_local(engine)
    with SessionLocal() as db:
        db.add(Space(space_id="spc-plan-startup", name="Plan Startup", slug="plan-startup"))
        db.add(
            Worker(
                space_id="spc-plan-startup",
                worker_id="win-main",
                machine_name="win-main",
                os="windows",
                token_hash="test-worker-token-hash",
                reachable_backends_json='["codex"]',
                workspace_roots_json='["E:/work/AgentHub"]',
                capabilities_json="{}",
                status="online",
            )
        )
        db.flush()
        db.add(
            AgentSession(
                space_id="spc-plan-startup",
                session_id="old-plan-at-startup",
                backend="codex",
                worker_id="win-main",
                workspace_root="E:/work/AgentHub",
                project_name="AgentHub",
                namespace="default",
                mode="direct_reply",
                runtime_session_ref="codex/old-plan-at-startup.jsonl",
                status="ready",
                title="Old plan",
            )
        )
        db.add(
            AgentTimeline(
                space_id="spc-plan-startup",
                session_id="old-plan-at-startup",
                seq=42,
                item_type="assistant_message",
                role="assistant",
                text="# 历史计划\n\n## Summary\n这是一条旧 plan。",
                status="completed",
                payload_json='{"source":"codex_app_server","reply_mode":"plan","native_turn_mode":"plan"}',
            )
        )
        db.commit()

    app = create_app(
        Settings(
            database_url=db_url,
            bootstrap_token="bootstrap-test-token",
            worker_registration_token="worker-register-test-token",
            cookie_secure=False,
        )
    )

    with app.state.SessionLocal() as db:
        session = db.query(AgentSession).filter(AgentSession.session_id == "old-plan-at-startup").one()
        assert session.status == "ready"
        assert db.query(AgentPermission).count() == 0


def test_opening_existing_codex_plan_timeline_lazily_creates_only_that_session_plan_exit(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    space_id = worker["worker"]["space_id"]

    from app.models import AgentSession, AgentTimeline

    with client.app.state.SessionLocal() as db:
        for session_id, title in (
            ("existing-plan-without-permission", "Existing plan"),
            ("other-existing-plan-without-permission", "Other existing plan"),
        ):
            db.add(
                AgentSession(
                    space_id=space_id,
                    session_id=session_id,
                    backend="codex",
                    worker_id=worker_id,
                    workspace_root="E:/work/AgentHub",
                    project_name="AgentHub",
                    namespace="default",
                    mode="direct_reply",
                    runtime_session_ref=f"codex/{session_id}.jsonl",
                    status="ready",
                    title=title,
                )
            )
            db.add(
                AgentTimeline(
                    space_id=space_id,
                    session_id=session_id,
                    seq=42,
                    item_type="assistant_message",
                    role="assistant",
                    text=f"# Admin 管理 Console 完整化方案\n\n## Summary\n升级 /admin。{session_id}",
                    status="completed",
                    payload_json='{"source":"codex_app_server","reply_mode":"plan","native_turn_mode":"plan"}',
                )
            )
        db.commit()

    assert client.get("/api/permissions?status=pending", headers=headers).json()["items"] == []

    opened = client.get("/api/sessions/existing-plan-without-permission/timeline", headers=headers)
    assert opened.status_code == 200, opened.text

    session_out = client.get("/api/sessions/existing-plan-without-permission", headers=headers).json()["session"]
    assert session_out["status"] == "needs_reply"
    permissions = client.get(
        "/api/permissions?session_id=existing-plan-without-permission&status=pending",
        headers=headers,
    ).json()["items"]
    assert len(permissions) == 1
    assert permissions[0]["kind"] == "plan_exit"
    assert permissions[0]["detail"]["source_type"] == "timeline_open"
    other_permissions = client.get(
        "/api/permissions?session_id=other-existing-plan-without-permission&status=pending",
        headers=headers,
    ).json()["items"]
    assert other_permissions == []
    other_session = client.get("/api/sessions/other-existing-plan-without-permission", headers=headers).json()["session"]
    assert other_session["status"] == "ready"


def test_opening_timeline_does_not_recover_plan_exit_after_later_user_message(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    space_id = worker["worker"]["space_id"]

    from app.models import AgentSession, AgentTimeline

    with client.app.state.SessionLocal() as db:
        db.add(
            AgentSession(
                space_id=space_id,
                session_id="stale-plan-after-user",
                backend="codex",
                worker_id=worker_id,
                workspace_root="E:/work/AgentHub",
                project_name="AgentHub",
                namespace="default",
                mode="direct_reply",
                runtime_session_ref="codex/stale-plan-after-user.jsonl",
                status="ready",
                title="Stale plan",
            )
        )
        db.add(
            AgentTimeline(
                space_id=space_id,
                session_id="stale-plan-after-user",
                seq=10,
                item_type="assistant_message",
                role="assistant",
                text="# 旧计划\n\n## Summary\n这条计划已经被后续用户输入覆盖。",
                status="completed",
                payload_json='{"source":"codex_app_server","reply_mode":"plan","native_turn_mode":"plan"}',
            )
        )
        db.add(
            AgentTimeline(
                space_id=space_id,
                session_id="stale-plan-after-user",
                seq=11,
                item_type="user_message",
                role="user",
                text="不用这个计划了，直接修 bug。",
                status="completed",
                payload_json='{"source":"session_input","reply_mode":"direct","native_turn_mode":"default"}',
            )
        )
        db.commit()

    opened = client.get("/api/sessions/stale-plan-after-user/timeline", headers=headers)
    assert opened.status_code == 200, opened.text

    permissions = client.get(
        "/api/permissions?session_id=stale-plan-after-user&status=pending",
        headers=headers,
    ).json()["items"]
    assert permissions == []


def test_opening_timeline_does_not_recover_plan_exit_after_later_tool_activity(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    space_id = worker["worker"]["space_id"]

    from app.models import AgentSession, AgentTimeline

    with client.app.state.SessionLocal() as db:
        db.add(
            AgentSession(
                space_id=space_id,
                session_id="stale-plan-after-tool",
                backend="codex",
                worker_id=worker_id,
                workspace_root="E:/work/AgentHub",
                project_name="AgentHub",
                namespace="default",
                mode="direct_reply",
                runtime_session_ref="codex/stale-plan-after-tool.jsonl",
                status="ready",
                title="Stale plan after tool",
            )
        )
        db.add(
            AgentTimeline(
                space_id=space_id,
                session_id="stale-plan-after-tool",
                seq=10,
                item_type="assistant_message",
                role="assistant",
                text="# 旧计划\n\n## Summary\n这条计划后面已经执行过工具。",
                status="completed",
                payload_json='{"source":"codex_app_server","reply_mode":"plan","native_turn_mode":"plan"}',
            )
        )
        db.add(
            AgentTimeline(
                space_id=space_id,
                session_id="stale-plan-after-tool",
                seq=11,
                item_type="tool_call",
                role="system",
                text="执行命令: npm run web:test\n退出码: 0",
                status="completed",
                payload_json='{"source":"codex_app_server"}',
            )
        )
        db.commit()

    opened = client.get("/api/sessions/stale-plan-after-tool/timeline", headers=headers)
    assert opened.status_code == 200, opened.text

    permissions = client.get(
        "/api/permissions?session_id=stale-plan-after-tool&status=pending",
        headers=headers,
    ).json()["items"]
    assert permissions == []
    session_out = client.get("/api/sessions/stale-plan-after-tool", headers=headers).json()["session"]
    assert session_out["status"] == "ready"


def test_opening_timeline_expires_pending_plan_exit_after_later_tool_activity(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    space_id = worker["worker"]["space_id"]

    from app.core.json import dumps_json
    from app.services import CODEX_PLAN_EXIT_CHOICES
    from app.models import AgentPermission, AgentSession, AgentTimeline

    plan_text = "# 旧计划\n\n## Summary\n这条计划后面已经执行过工具。"
    with client.app.state.SessionLocal() as db:
        db.add(
            AgentSession(
                space_id=space_id,
                session_id="pending-plan-after-tool",
                backend="codex",
                worker_id=worker_id,
                workspace_root="E:/work/AgentHub",
                project_name="AgentHub",
                namespace="default",
                mode="direct_reply",
                runtime_session_ref="codex/pending-plan-after-tool.jsonl",
                status="needs_reply",
                title="Pending stale plan",
            )
        )
        db.add(
            AgentTimeline(
                space_id=space_id,
                session_id="pending-plan-after-tool",
                seq=10,
                item_type="assistant_message",
                role="assistant",
                text=plan_text,
                status="completed",
                payload_json='{"source":"codex_app_server","reply_mode":"plan","native_turn_mode":"plan"}',
            )
        )
        db.add(
            AgentTimeline(
                space_id=space_id,
                session_id="pending-plan-after-tool",
                seq=11,
                item_type="tool_call",
                role="system",
                text="执行命令: npm run api:test\n退出码: 0",
                status="completed",
                payload_json='{"source":"codex_app_server"}',
            )
        )
        db.add(
            AgentPermission(
                space_id=space_id,
                session_id="pending-plan-after-tool",
                worker_id=worker_id,
                backend="codex",
                kind="plan_exit",
                title="计划已生成",
                description="旧计划审批",
                detail_json=dumps_json({"source": "codex_plan_exit", "source_type": "timeline_open", "plan_text": plan_text}),
                actions_json=dumps_json({"choices": CODEX_PLAN_EXIT_CHOICES}),
                status="pending",
                response_json=dumps_json({}),
            )
        )
        db.commit()

    opened = client.get("/api/sessions/pending-plan-after-tool/timeline", headers=headers)
    assert opened.status_code == 200, opened.text

    pending = client.get(
        "/api/permissions?session_id=pending-plan-after-tool&status=pending",
        headers=headers,
    ).json()["items"]
    assert pending == []
    permissions = client.get(
        "/api/permissions?session_id=pending-plan-after-tool",
        headers=headers,
    ).json()["items"]
    expired = next(item for item in permissions if item["kind"] == "plan_exit")
    assert expired["status"] == "expired"
    assert expired["response"]["reason"] == "timeline_no_longer_waiting"


def test_pending_permission_list_expires_stale_plan_exit_after_later_tool_activity(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    space_id = worker["worker"]["space_id"]

    from app.core.json import dumps_json
    from app.services import CODEX_PLAN_EXIT_CHOICES
    from app.models import AgentPermission, AgentSession, AgentTimeline

    plan_text = "# 旧计划\n\n## Summary\n这条计划不应该再推通知。"
    with client.app.state.SessionLocal() as db:
        db.add(
            AgentSession(
                space_id=space_id,
                session_id="permission-list-stale-plan",
                backend="codex",
                worker_id=worker_id,
                workspace_root="E:/work/AgentHub",
                project_name="AgentHub",
                namespace="default",
                mode="direct_reply",
                runtime_session_ref="codex/permission-list-stale-plan.jsonl",
                status="needs_reply",
                title="Pending stale plan in list",
            )
        )
        db.add(
            AgentTimeline(
                space_id=space_id,
                session_id="permission-list-stale-plan",
                seq=10,
                item_type="assistant_message",
                role="assistant",
                text=plan_text,
                status="completed",
                payload_json='{"source":"codex_app_server","reply_mode":"plan","native_turn_mode":"plan"}',
            )
        )
        db.add(
            AgentTimeline(
                space_id=space_id,
                session_id="permission-list-stale-plan",
                seq=11,
                item_type="tool_call",
                role="system",
                text="工具结果: 已经继续执行",
                status="completed",
                payload_json='{"source":"codex_app_server"}',
            )
        )
        db.add(
            AgentPermission(
                space_id=space_id,
                session_id="permission-list-stale-plan",
                worker_id=worker_id,
                backend="codex",
                kind="plan_exit",
                title="计划已生成",
                description="旧计划审批",
                detail_json=dumps_json({"source": "codex_plan_exit", "source_type": "timeline_open", "plan_text": plan_text}),
                actions_json=dumps_json({"choices": CODEX_PLAN_EXIT_CHOICES}),
                status="pending",
                response_json=dumps_json({}),
            )
        )
        db.commit()

    pending = client.get("/api/permissions?status=pending", headers=headers).json()["items"]
    assert all(item["session_id"] != "permission-list-stale-plan" for item in pending)

    permissions = client.get(
        "/api/permissions?session_id=permission-list-stale-plan",
        headers=headers,
    ).json()["items"]
    expired = next(item for item in permissions if item["kind"] == "plan_exit")
    assert expired["status"] == "expired"
    assert expired["response"]["reason"] == "timeline_no_longer_waiting"


def test_worker_synced_user_message_expires_stale_pending_interaction(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    space_id = worker["worker"]["space_id"]

    from app.core.json import dumps_json
    from app.models import AgentPermission, AgentSession

    with client.app.state.SessionLocal() as db:
        db.add(
            AgentSession(
                space_id=space_id,
                session_id="stale-question-after-cli-input",
                backend="codex",
                worker_id=worker_id,
                workspace_root="E:/work/AgentHub",
                project_name="AgentHub",
                namespace="default",
                mode="direct_reply",
                runtime_session_ref="codex/stale-question-after-cli-input.jsonl",
                status="needs_reply",
                title="Stale question",
            )
        )
        db.add(
            AgentPermission(
                space_id=space_id,
                session_id="stale-question-after-cli-input",
                worker_id=worker_id,
                backend="codex",
                kind="question",
                title="选择下一步",
                description="旧问题",
                detail_json=dumps_json({"source": "codex_request_user_input"}),
                actions_json=dumps_json({"choices": [{"id": "q:0", "label": "旧选项"}]}),
                status="pending",
                response_json=dumps_json({}),
            )
        )
        db.commit()

    published = client.post(
        "/api/internal/sessions/stale-question-after-cli-input/timeline",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker_id,
            "replace": False,
            "items": [
                {
                    "seq": 20,
                    "item_type": "user_message",
                    "role": "user",
                    "text": "我已经在本机继续输入了，不再回答旧问题。",
                    "payload": {"source": "codex_app_server"},
                }
            ],
        },
    )
    assert published.status_code == 200, published.text

    pending = client.get(
        "/api/permissions?session_id=stale-question-after-cli-input&status=pending",
        headers=headers,
    ).json()["items"]
    assert pending == []
    permissions = client.get(
        "/api/permissions?session_id=stale-question-after-cli-input",
        headers=headers,
    ).json()["items"]
    expired = next(item for item in permissions if item["kind"] == "question")
    assert expired["status"] == "expired"
    assert expired["response"]["reason"] == "timeline_superseded"


def test_interactions_alias_lists_and_responds_to_plan_exit(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "codex-plan-exit",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/codex-plan-exit.jsonl",
            "status": "ready",
        },
    )
    created = client.post(
        "/api/sessions/codex-plan-exit/input",
        headers=headers,
        json={"prompt": "先规划交互协议", "reply_mode": "plan"},
    )
    assert created.status_code == 200, created.text

    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    job_id = claimed.json()["job"]["job_id"]
    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers=worker_headers,
        json={"worker_id": worker_id, "result_text": "计划：\n1. 建 interaction bus\n2. 接 Codex plan exit"},
    )
    assert completed.status_code == 200, completed.text

    listed = client.get("/api/interactions?session_id=codex-plan-exit&status=pending", headers=headers)
    assert listed.status_code == 200, listed.text
    interaction = listed.json()["items"][0]
    assert interaction["kind"] == "plan_exit"

    answered = client.post(
        f"/api/interactions/{interaction['permission_id']}/respond",
        headers=headers,
        json={"action": "answer", "response": {"choice": "implement", "label": "执行计划"}},
    )
    assert answered.status_code == 200, answered.text
    assert answered.json()["interaction"]["status"] == "answered"

    jobs = client.get("/api/jobs", headers=headers).json()["items"]
    continuation = next(job for job in jobs if job["status"] == "queued")
    assert continuation["target_session_id"] == "codex-plan-exit"
    assert continuation["payload"]["reply_mode"] == "direct"
    assert continuation["payload"]["native_turn_mode"] == "default"
    assert continuation["payload"]["answered_permission_id"] == interaction["permission_id"]
    assert continuation["payload"]["prompt"] == "Implement the plan."


def test_keep_planning_plan_exit_enqueues_native_plan_turn(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "codex-keep-planning",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/codex-keep-planning.jsonl",
            "status": "ready",
        },
    )
    client.post(
        "/api/sessions/codex-keep-planning/input",
        headers=headers,
        json={"prompt": "先规划", "reply_mode": "plan"},
    )
    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    job_id = claimed.json()["job"]["job_id"]
    client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers=worker_headers,
        json={"worker_id": worker_id, "result_text": "计划：先做 API，再做 UI。"},
    )
    interaction = client.get("/api/interactions?session_id=codex-keep-planning", headers=headers).json()["items"][0]

    answered = client.post(
        f"/api/interactions/{interaction['permission_id']}/respond",
        headers=headers,
        json={"action": "answer", "response": {"choice": "keep_planning", "label": "继续规划", "note": "先补测试矩阵"}},
    )
    assert answered.status_code == 200, answered.text

    jobs = client.get("/api/jobs", headers=headers).json()["items"]
    continuation = next(job for job in jobs if job["status"] == "queued")
    assert continuation["payload"]["reply_mode"] == "plan"
    assert continuation["payload"]["native_plan_mode"] is True
    assert continuation["payload"]["native_turn_mode"] == "plan"
    assert "先补测试矩阵" in continuation["payload"]["prompt"]


def test_native_turn_permission_answer_is_polled_by_worker_without_extra_job(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "native-turn-choice",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/native-turn-choice.jsonl",
            "status": "ready",
        },
    )
    created = client.post(
        "/api/sessions/native-turn-choice/input",
        headers=headers,
        json={"prompt": "先进入计划模式", "reply_mode": "plan"},
    )
    assert created.status_code == 200, created.text
    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text

    requested = client.post(
        "/api/internal/permissions/requested",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "permission": {
                "permission_id": "perm-native-plan-choice",
                "session_id": "native-turn-choice",
                "backend": "codex",
                "kind": "question",
                "title": "选择计划方向",
                "description": "Codex Plan 请求用户选择下一步。",
                "detail": {"source": "codex_request_user_input", "server_request_id": 7},
                "actions": {"choices": [{"id": "q1:0", "label": "先做 UI"}]},
            },
        },
    )
    assert requested.status_code == 200, requested.text

    answered = client.post(
        "/api/permissions/perm-native-plan-choice/respond",
        headers=headers,
        json={"action": "answer", "response": {"choice": "q1:0", "label": "先做 UI"}},
    )
    assert answered.status_code == 200, answered.text

    polled = client.get("/api/internal/permissions/perm-native-plan-choice", headers=worker_headers)
    assert polled.status_code == 200, polled.text
    assert polled.json()["permission"]["status"] == "answered"
    assert polled.json()["permission"]["response"]["response"]["label"] == "先做 UI"

    jobs = client.get("/api/jobs", headers=headers).json()["items"]
    assert [job["status"] for job in jobs] == ["running"]
    session = client.get("/api/sessions/native-turn-choice", headers=headers).json()["session"]
    assert session["status"] == "running"


def test_late_native_turn_permission_answer_enqueues_continuation_after_timeout(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}

    client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "native-turn-timeout",
            "backend": "codex",
            "worker_id": worker_id,
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "runtime_session_ref": "codex/native-turn-timeout.jsonl",
            "status": "ready",
        },
    )
    created = client.post(
        "/api/sessions/native-turn-timeout/input",
        headers=headers,
        json={"prompt": "先进入计划模式", "reply_mode": "plan"},
    )
    assert created.status_code == 200, created.text
    claimed = client.post("/api/internal/jobs/claim", headers=worker_headers, json={"worker_id": worker_id})
    assert claimed.status_code == 200, claimed.text
    running_job_id = claimed.json()["job"]["job_id"]

    requested = client.post(
        "/api/internal/permissions/requested",
        headers=worker_headers,
        json={
            "worker_id": worker_id,
            "permission": {
                "permission_id": "perm-native-timeout-choice",
                "session_id": "native-turn-timeout",
                "backend": "codex",
                "kind": "question",
                "title": "维护窗口",
                "description": "Codex Plan 请求用户选择下一步。",
                "detail": {"source": "codex_request_user_input", "server_request_id": 7},
                "actions": {"choices": [{"id": "maintenance_window:1", "label": "只允许关应用"}]},
            },
        },
    )
    assert requested.status_code == 200, requested.text

    failed = client.post(
        f"/api/internal/jobs/{running_job_id}/fail",
        headers=worker_headers,
        json={"worker_id": worker_id, "error_text": "Timed out waiting for AgentHub user input"},
    )
    assert failed.status_code == 200, failed.text

    answered = client.post(
        "/api/permissions/perm-native-timeout-choice/respond",
        headers=headers,
        json={"action": "answer", "response": {"choice": "maintenance_window:1", "label": "只允许关应用"}},
    )
    assert answered.status_code == 200, answered.text

    jobs = client.get("/api/jobs", headers=headers).json()["items"]
    continuation = next(job for job in jobs if job["status"] == "queued")
    assert continuation["target_session_id"] == "native-turn-timeout"
    assert continuation["payload"]["answered_permission_id"] == "perm-native-timeout-choice"
    assert "只允许关应用" in continuation["payload"]["prompt"]
    session = client.get("/api/sessions/native-turn-timeout", headers=headers).json()["session"]
    assert session["status"] == "queued"


def test_provider_snapshot_is_worker_only_and_visible_to_users(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]

    worker_cannot_read_user_api = client.get(
        "/api/providers",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
    )
    assert worker_cannot_read_user_api.status_code == 403

    published = client.post(
        "/api/internal/providers/snapshot",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker_id,
            "providers": [
                {
                    "backend": "codex",
                    "status": "ready",
                    "models": [{"id": "gpt-5.4", "label": "GPT-5.4"}],
                    "modes": [{"id": "workspace-write", "label": "Workspace write", "kind": "sandbox_mode"}],
                    "features": {"yolo": True},
                    "diagnostics": {"version": "codex 1.0", "auth_status": "ready"},
                }
            ],
        },
    )
    assert published.status_code == 200, published.text

    listed = client.get("/api/providers", headers=auth_headers(owner_login))
    assert listed.status_code == 200, listed.text
    item = listed.json()["items"][0]
    assert item["worker_id"] == worker_id
    assert item["backend"] == "codex"
    assert item["auth_status"] == "ready"
    assert item["models"][0]["id"] == "gpt-5.4"
    assert item["features"]["yolo"] is True
