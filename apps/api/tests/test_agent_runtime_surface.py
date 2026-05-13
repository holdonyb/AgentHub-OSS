from __future__ import annotations

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
