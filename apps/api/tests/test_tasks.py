from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.models import AgentTask, Job, Worker, utcnow

from conftest import auth_headers, bootstrap_owner, create_worker, login


def test_task_create_list_and_detail_contract(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    response = client.post(
        "/api/tasks",
        headers=headers,
        json={
            "title": "修复登录页移动端布局",
            "brief_markdown": "登录页在 390px 宽度下按钮遮挡。",
            "success_criteria_markdown": "- npm run web:test passes\n- 390px no overlap",
            "target_worker_id": worker["worker"]["worker_id"],
            "backend": "codex",
            "workspace_root": "E:/work/AgentHub-OSS",
            "namespace": "default",
            "controls": {"sandbox_mode": "workspace-write"},
            "submit": False,
        },
    )

    assert response.status_code == 200, response.text
    task = response.json()["task"]
    assert task["task_id"].startswith("tsk_")
    assert task["status"] == "draft"
    assert task["title"] == "修复登录页移动端布局"
    assert task["artifact_count"] == 0
    assert task["latest_job_id"] is None

    listed = client.get("/api/tasks", headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["task_id"] == task["task_id"]

    detail = client.get(f"/api/tasks/{task['task_id']}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["task"]["task_id"] == task["task_id"]
    assert detail.json()["artifacts"] == []
    assert detail.json()["executions"] == []


def test_task_submit_creates_session_start_job_and_execution(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    response = client.post(
        "/api/tasks",
        headers=headers,
        json={
            "title": "实现 Workbench shell",
            "brief_markdown": "新增顶部 Workbench / Session 模式开关。",
            "success_criteria_markdown": "- Session Mode still renders\n- Workbench Mode renders task inbox",
            "target_worker_id": worker["worker"]["worker_id"],
            "backend": "codex",
            "workspace_root": "E:/work/AgentHub-OSS",
            "namespace": "default",
            "submit": True,
            "controls": {"sandbox_mode": "workspace-write"},
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    task = payload["task"]
    assert task["status"] == "queued"
    assert payload["job"]["kind"] == "session_start"
    assert payload["job"]["payload"]["task_id"] == task["task_id"]
    assert "AgentHub Task" in payload["job"]["payload"]["prompt"]

    detail = client.get(f"/api/tasks/{task['task_id']}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["executions"][0]["job_id"] == payload["job"]["job_id"]
    assert detail.json()["executions"][0]["attempt_number"] == 1


def _claim_and_complete_task_job(client: TestClient, worker_token: str, worker_id: str, job_id: str, result_text: str) -> None:
    claimed = _claim_task_job(client, worker_token, worker_id)
    assert claimed["job"]["job_id"] == job_id

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers={"Authorization": f"Bearer {worker_token}"},
        json={"worker_id": worker_id, "result_text": result_text},
    )
    assert completed.status_code == 200, completed.text


def _claim_task_job(client: TestClient, worker_token: str, worker_id: str) -> dict[str, object]:
    claimed = client.post(
        "/api/internal/jobs/claim",
        headers={"Authorization": f"Bearer {worker_token}"},
        json={"worker_id": worker_id},
    )
    assert claimed.status_code == 200, claimed.text
    return claimed.json()


def _create_submitted_task(
    client: TestClient,
    *,
    headers: dict[str, str],
    worker_id: str,
    title: str,
    controls: dict[str, object] | None = None,
) -> dict[str, object]:
    response = client.post(
        "/api/tasks",
        headers=headers,
        json={
            "title": title,
            "brief_markdown": "完成任务并提交验收报告。",
            "success_criteria_markdown": "- focused tests pass",
            "target_worker_id": worker_id,
            "backend": "codex",
            "workspace_root": "E:/work/AgentHub-OSS",
            "namespace": "default",
            "controls": controls or {},
            "submit": True,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_task_request_changes_dispatches_second_attempt_with_stored_controls(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    controls = {"sandbox_mode": "workspace-write", "model": "gpt-5"}

    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker_id,
        title="多轮验收任务",
        controls=controls,
    )
    task_id = created["task"]["task_id"]
    first_job_id = created["job"]["job_id"]
    _claim_and_complete_task_job(
        client,
        worker["worker_token"],
        worker_id,
        first_job_id,
        "第一轮交付报告",
    )

    reviewed = client.post(
        f"/api/tasks/{task_id}/review",
        headers=headers,
        json={"action": "request_changes", "note_markdown": "请补充失败路径测试。"},
    )

    assert reviewed.status_code == 200, reviewed.text
    review_payload = reviewed.json()
    assert review_payload["task"]["status"] == "queued"
    assert review_payload["job"]["kind"] == "session_start"
    assert review_payload["job"]["job_id"] != first_job_id
    assert review_payload["job"]["payload"]["controls"] == controls
    assert "请补充失败路径测试" in review_payload["job"]["payload"]["prompt"]

    second_job_id = review_payload["job"]["job_id"]
    _claim_and_complete_task_job(
        client,
        worker["worker_token"],
        worker_id,
        second_job_id,
        "第二轮交付报告",
    )
    detail = client.get(f"/api/tasks/{task_id}", headers=headers)
    assert detail.status_code == 200, detail.text
    payload = detail.json()
    assert payload["task"]["status"] == "ready_to_review"
    assert [(item["attempt_number"], item["job_id"]) for item in payload["executions"]] == [
        (2, second_job_id),
        (1, first_job_id),
    ]
    assert [item["status"] for item in payload["executions"]] == ["succeeded", "succeeded"]
    assert [item["kind"] for item in payload["artifacts"]].count("report") == 2
    review_notes = [item for item in payload["artifacts"] if item["kind"] == "review_note"]
    assert len(review_notes) == 1
    assert review_notes[0]["content_markdown"] == "请补充失败路径测试。"


def test_task_request_changes_requires_non_empty_note(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    created = _create_submitted_task(client, headers=headers, worker_id=worker_id, title="评审备注必填")
    task_id = created["task"]["task_id"]
    _claim_and_complete_task_job(
        client,
        worker["worker_token"],
        worker_id,
        created["job"]["job_id"],
        "等待验收",
    )

    response = client.post(
        f"/api/tasks/{task_id}/review",
        headers=headers,
        json={"action": "request_changes", "note_markdown": "   "},
    )

    assert response.status_code == 400, response.text
    assert response.json()["detail"]["code"] == "TASK_REVIEW_NOTE_REQUIRED"
    detail = client.get(f"/api/tasks/{task_id}", headers=headers).json()
    assert detail["task"]["status"] == "ready_to_review"
    assert len(detail["executions"]) == 1
    assert [item["kind"] for item in detail["artifacts"]] == ["report"]


@pytest.mark.parametrize("action", ["accept", "reject", "request_changes"])
def test_task_review_rejects_invalid_transitions(client: TestClient, action: str) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker["worker"]["worker_id"],
        title=f"非法状态转换 {action}",
    )

    response = client.post(
        f"/api/tasks/{created['task']['task_id']}/review",
        headers=headers,
        json={"action": action, "note_markdown": "需要修改" if action == "request_changes" else ""},
    )

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "TASK_REVIEW_STATE_INVALID"


def test_task_request_changes_invalid_state_precedes_note_validation(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker["worker"]["worker_id"],
        title="非法返工优先校验状态",
    )

    response = client.post(
        f"/api/tasks/{created['task']['task_id']}/review",
        headers=headers,
        json={"action": "request_changes", "note_markdown": ""},
    )

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "TASK_REVIEW_STATE_INVALID"


@pytest.mark.parametrize("action, expected_status", [("accept", "accepted"), ("reject", "rejected")])
def test_task_accept_and_reject_from_ready_to_review(
    client: TestClient,
    action: str,
    expected_status: str,
) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker_id,
        title=f"合法验收 {action}",
    )
    _claim_and_complete_task_job(
        client,
        worker["worker_token"],
        worker_id,
        created["job"]["job_id"],
        "等待验收",
    )

    response = client.post(
        f"/api/tasks/{created['task']['task_id']}/review",
        headers=headers,
        json={"action": action, "note_markdown": ""},
    )

    assert response.status_code == 200, response.text
    assert response.json()["task"]["status"] == expected_status


def test_task_archive_is_idempotent_and_restore_uses_report_history(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)

    draft = client.post(
        "/api/tasks",
        headers=headers,
        json={
            "title": "待恢复草稿",
            "brief_markdown": "没有交付报告时恢复为草稿。",
            "submit": False,
        },
    )
    assert draft.status_code == 200, draft.text
    draft_task_id = draft.json()["task"]["task_id"]

    first_archive = client.post(
        f"/api/tasks/{draft_task_id}/review",
        headers=headers,
        json={"action": "archive"},
    )
    second_archive = client.post(
        f"/api/tasks/{draft_task_id}/review",
        headers=headers,
        json={"action": "archive"},
    )
    assert first_archive.status_code == 200, first_archive.text
    assert second_archive.status_code == 200, second_archive.text
    assert second_archive.json()["task"]["archived_at"] == first_archive.json()["task"]["archived_at"]

    restored_draft = client.post(
        f"/api/tasks/{draft_task_id}/review",
        headers=headers,
        json={"action": "restore"},
    )
    assert restored_draft.status_code == 200, restored_draft.text
    assert restored_draft.json()["task"]["status"] == "draft"
    assert restored_draft.json()["task"]["archived_at"] is None

    worker_id = worker["worker"]["worker_id"]
    delivered = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker_id,
        title="待恢复报告",
    )
    delivered_task_id = delivered["task"]["task_id"]
    _claim_and_complete_task_job(
        client,
        worker["worker_token"],
        worker_id,
        delivered["job"]["job_id"],
        "已有交付报告",
    )
    archived_report = client.post(
        f"/api/tasks/{delivered_task_id}/review",
        headers=headers,
        json={"action": "archive"},
    )
    assert archived_report.status_code == 200, archived_report.text

    restored_report = client.post(
        f"/api/tasks/{delivered_task_id}/review",
        headers=headers,
        json={"action": "restore"},
    )
    assert restored_report.status_code == 200, restored_report.text
    assert restored_report.json()["task"]["status"] == "ready_to_review"
    assert restored_report.json()["task"]["archived_at"] is None

    events = client.get("/api/events", headers=headers).json()["items"]
    draft_archive_events = [
        item
        for item in events
        if item["source_id"] == draft_task_id and item["event_type"] == "task.archive"
    ]
    assert len(draft_archive_events) == 1
    assert any(
        item["source_id"] == draft_task_id and item["event_type"] == "task.restore"
        for item in events
    )


def test_task_rework_preserves_rbac_and_space_isolation(client: TestClient) -> None:
    from app.models import Space, SpaceMembership, User

    owner = bootstrap_owner(client)
    headers = auth_headers(owner)
    worker = create_worker(client)
    worker_id = worker["worker"]["worker_id"]
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker_id,
        title="租户隔离任务",
    )
    task_id = created["task"]["task_id"]
    _claim_and_complete_task_job(
        client,
        worker["worker_token"],
        worker_id,
        created["job"]["job_id"],
        "等待隔离验收",
    )

    invite = client.post(
        "/api/invites",
        headers=headers,
        json={"email": "task-viewer@example.com", "role": "viewer", "expires_in_hours": 2},
    )
    assert invite.status_code == 200, invite.text
    with TestClient(client.app) as viewer_client:
        accepted = viewer_client.post(
            "/api/invites/accept",
            json={
                "invite_token": invite.json()["invite_token"],
                "email": "task-viewer@example.com",
                "password": "Correct Horse Battery Staple 42",
            },
        )
        assert accepted.status_code == 200, accepted.text
        viewer_login = login(viewer_client, "task-viewer@example.com")
        forbidden = viewer_client.post(
            f"/api/tasks/{task_id}/review",
            headers=auth_headers(viewer_login),
            json={"action": "request_changes", "note_markdown": "越权修改"},
        )
    assert forbidden.status_code == 403, forbidden.text

    db = client.app.state.SessionLocal()
    try:
        owner_user = db.query(User).filter(User.email == "owner@example.com").one()
        other_space = Space(name="Other Space", slug="other-space", created_by=owner_user.id)
        db.add(other_space)
        db.flush()
        db.add(SpaceMembership(space_id=other_space.space_id, user_id=owner_user.id, role="owner"))
        db.commit()
        other_space_id = other_space.space_id
    finally:
        db.close()

    other_space_headers = {**headers, "X-AgentHub-Space": other_space_id}
    isolated = client.post(
        f"/api/tasks/{task_id}/review",
        headers=other_space_headers,
        json={"action": "request_changes", "note_markdown": "跨空间修改"},
    )
    assert isolated.status_code == 404, isolated.text
    assert isolated.json()["detail"]["code"] == "TASK_NOT_FOUND"

    detail = client.get(f"/api/tasks/{task_id}", headers=headers).json()
    assert detail["task"]["status"] == "ready_to_review"
    assert len(detail["executions"]) == 1
    assert [item["kind"] for item in detail["artifacts"]] == ["report"]


def test_task_job_completion_creates_report_artifact(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]

    created = client.post(
        "/api/tasks",
        headers=headers,
        json={
            "title": "生成 report artifact",
            "brief_markdown": "完成后应该进入验收。",
            "success_criteria_markdown": "- report artifact exists",
            "target_worker_id": worker_id,
            "backend": "codex",
            "workspace_root": "E:/work/AgentHub-OSS",
            "namespace": "default",
            "submit": True,
        },
    )
    assert created.status_code == 200, created.text
    task_id = created.json()["task"]["task_id"]
    job_id = created.json()["job"]["job_id"]

    _claim_and_complete_task_job(client, worker["worker_token"], worker_id, job_id, "完成：测试通过，风险较低。")

    detail = client.get(f"/api/tasks/{task_id}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["task"]["status"] == "ready_to_review"
    assert detail.json()["artifacts"][0]["kind"] == "report"
    assert "完成：测试通过" in detail.json()["artifacts"][0]["content_markdown"]
    assert detail.json()["executions"][0]["status"] == "succeeded"


def test_task_job_claim_marks_task_working(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]

    created = client.post(
        "/api/tasks",
        headers=headers,
        json={
            "title": "运行中任务",
            "brief_markdown": "领取后应该进入 working。",
            "target_worker_id": worker_id,
            "backend": "codex",
            "workspace_root": "E:/work/AgentHub-OSS",
            "submit": True,
        },
    )
    assert created.status_code == 200, created.text
    task_id = created.json()["task"]["task_id"]
    job_id = created.json()["job"]["job_id"]

    claimed = client.post(
        "/api/internal/jobs/claim",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={"worker_id": worker_id},
    )
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == job_id

    detail = client.get(f"/api/tasks/{task_id}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["task"]["status"] == "working"
    assert detail.json()["executions"][0]["status"] == "running"


def test_task_job_failure_marks_task_failed_with_log_artifact(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]

    created = client.post(
        "/api/tasks",
        headers=headers,
        json={
            "title": "失败任务",
            "brief_markdown": "失败时应该留下日志。",
            "target_worker_id": worker_id,
            "backend": "codex",
            "workspace_root": "E:/work/AgentHub-OSS",
            "submit": True,
        },
    )
    assert created.status_code == 200, created.text
    job_id = created.json()["job"]["job_id"]
    task_id = created.json()["task"]["task_id"]

    claimed = client.post(
        "/api/internal/jobs/claim",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={"worker_id": worker_id},
    )
    assert claimed.status_code == 200, claimed.text

    failed = client.post(
        f"/api/internal/jobs/{job_id}/fail",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={"worker_id": worker_id, "error_text": "runtime crashed"},
    )
    assert failed.status_code == 200, failed.text

    detail = client.get(f"/api/tasks/{task_id}", headers=headers)
    assert detail.json()["task"]["status"] == "failed"
    assert detail.json()["artifacts"][0]["kind"] == "log"
    assert "runtime crashed" in detail.json()["artifacts"][0]["content_markdown"]


def test_task_session_start_completion_links_anchored_created_session(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker_id,
        title="Link created session",
    )
    task_id = created["task"]["task_id"]
    job_id = created["job"]["job_id"]
    _claim_task_job(client, worker["worker_token"], worker_id)

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker_id,
            "result_text": "created_session_id=task-created-session\nDelivery complete.",
        },
    )

    assert completed.status_code == 200, completed.text
    assert completed.json()["job"]["target_session_id"] == "task-created-session"
    detail = client.get(f"/api/tasks/{task_id}", headers=headers).json()
    assert detail["task"]["latest_session_id"] == "task-created-session"
    assert detail["executions"][0]["session_id"] == "task-created-session"


def test_task_session_start_ignores_non_leading_created_session_marker(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker_id,
        title="Ignore embedded session marker",
    )
    task_id = created["task"]["task_id"]
    job_id = created["job"]["job_id"]
    _claim_task_job(client, worker["worker_token"], worker_id)

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker_id,
            "result_text": "Delivery complete.\ncreated_session_id=not-the-created-session",
        },
    )

    assert completed.status_code == 200, completed.text
    assert completed.json()["job"]["target_session_id"] is None
    detail = client.get(f"/api/tasks/{task_id}", headers=headers).json()
    assert detail["task"]["latest_session_id"] is None
    assert detail["executions"][0]["session_id"] is None


def test_task_job_manual_cancel_projects_cancelled_once(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker["worker"]["worker_id"],
        title="Cancel task",
    )
    task_id = created["task"]["task_id"]
    job_id = created["job"]["job_id"]

    cancelled = client.post(f"/api/jobs/{job_id}/cancel", headers=headers)
    duplicate = client.post(f"/api/jobs/{job_id}/cancel", headers=headers)

    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["job"]["status"] == "cancelled"
    assert duplicate.status_code == 409, duplicate.text
    detail = client.get(f"/api/tasks/{task_id}", headers=headers).json()
    assert detail["task"]["status"] == "cancelled"
    assert detail["executions"][0]["status"] == "cancelled"
    logs = [artifact for artifact in detail["artifacts"] if artifact["kind"] == "log"]
    assert len(logs) == 1
    assert "Cancelled by" in logs[0]["content_markdown"]


def test_stale_task_job_timeout_projects_failure_once(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker_id,
        title="Stale task",
    )
    task_id = created["task"]["task_id"]
    job_id = created["job"]["job_id"]
    _claim_task_job(client, worker["worker_token"], worker_id)
    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.job_id == job_id).one()
        job.claimed_at = utcnow() - timedelta(seconds=3700)
        job.updated_at = job.claimed_at
        db.commit()

    first_recovery = client.get("/api/jobs", headers=headers)
    second_recovery = client.get("/api/jobs", headers=headers)

    assert first_recovery.status_code == 200, first_recovery.text
    assert second_recovery.status_code == 200, second_recovery.text
    detail = client.get(f"/api/tasks/{task_id}", headers=headers).json()
    assert detail["task"]["status"] == "failed"
    assert detail["executions"][0]["status"] == "failed"
    logs = [artifact for artifact in detail["artifacts"] if artifact["kind"] == "log"]
    assert len(logs) == 1
    assert "timed out" in logs[0]["content_markdown"]


def test_orphaned_task_job_recovery_projects_failure_once(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    worker_headers = {"Authorization": f"Bearer {worker['worker_token']}"}
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker_id,
        title="Orphaned task",
    )
    task_id = created["task"]["task_id"]
    job_id = created["job"]["job_id"]
    _claim_task_job(client, worker["worker_token"], worker_id)
    with client.app.state.SessionLocal() as db:
        job = db.query(Job).filter(Job.job_id == job_id).one()
        job.claimed_at = utcnow() - timedelta(seconds=180)
        job.updated_at = job.claimed_at
        db.commit()

    first_recovery = client.post(
        f"/api/workers/{worker_id}/heartbeat",
        headers=worker_headers,
        json={"status": "online", "active_job_ids": []},
    )
    second_recovery = client.post(
        f"/api/workers/{worker_id}/heartbeat",
        headers=worker_headers,
        json={"status": "online", "active_job_ids": []},
    )

    assert first_recovery.status_code == 200, first_recovery.text
    assert second_recovery.status_code == 200, second_recovery.text
    detail = client.get(f"/api/tasks/{task_id}", headers=headers).json()
    assert detail["task"]["status"] == "failed"
    assert detail["executions"][0]["status"] == "failed"
    logs = [artifact for artifact in detail["artifacts"] if artifact["kind"] == "log"]
    assert len(logs) == 1
    assert "orphaned" in logs[0]["content_markdown"]


def test_offline_worker_task_recovery_projects_failure_once(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker_id,
        title="Offline worker task",
    )
    task_id = created["task"]["task_id"]
    job_id = created["job"]["job_id"]
    _claim_task_job(client, worker["worker_token"], worker_id)
    with client.app.state.SessionLocal() as db:
        db_worker = db.query(Worker).filter(Worker.worker_id == worker_id).one()
        db_worker.status = "online"
        db_worker.last_heartbeat_at = utcnow() - timedelta(seconds=240)
        job = db.query(Job).filter(Job.job_id == job_id).one()
        job.claimed_at = utcnow() - timedelta(seconds=180)
        job.updated_at = job.claimed_at
        db.commit()

    first_recovery = client.get("/api/workers", headers=headers)
    second_recovery = client.get("/api/workers", headers=headers)

    assert first_recovery.status_code == 200, first_recovery.text
    assert second_recovery.status_code == 200, second_recovery.text
    detail = client.get(f"/api/tasks/{task_id}", headers=headers).json()
    assert detail["task"]["status"] == "failed"
    assert detail["executions"][0]["status"] == "failed"
    logs = [artifact for artifact in detail["artifacts"] if artifact["kind"] == "log"]
    assert len(logs) == 1
    assert "heartbeat expired" in logs[0]["content_markdown"]


def test_offline_and_stale_task_recovery_projects_failure_once(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker_id,
        title="Offline and stale task",
    )
    task_id = created["task"]["task_id"]
    job_id = created["job"]["job_id"]
    _claim_task_job(client, worker["worker_token"], worker_id)
    with client.app.state.SessionLocal() as db:
        db_worker = db.query(Worker).filter(Worker.worker_id == worker_id).one()
        db_worker.status = "online"
        db_worker.last_heartbeat_at = utcnow() - timedelta(seconds=240)
        job = db.query(Job).filter(Job.job_id == job_id).one()
        job.claimed_at = utcnow() - timedelta(seconds=3700)
        job.updated_at = job.claimed_at
        db.commit()

    first_recovery = client.get("/api/jobs", headers=headers)
    second_recovery = client.get("/api/jobs", headers=headers)

    assert first_recovery.status_code == 200, first_recovery.text
    assert second_recovery.status_code == 200, second_recovery.text
    recovered_job = next(item for item in first_recovery.json()["items"] if item["job_id"] == job_id)
    assert recovered_job["status"] == "failed"
    detail = client.get(f"/api/tasks/{task_id}", headers=headers).json()
    assert detail["task"]["status"] == "failed"
    assert detail["executions"][0]["status"] == "failed"
    logs = [artifact for artifact in detail["artifacts"] if artifact["kind"] == "log"]
    assert len(logs) == 1
    assert "heartbeat expired" in logs[0]["content_markdown"]


def test_late_attempt_completion_does_not_overwrite_newer_task_projection(client: TestClient) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker_id,
        title="Late first attempt",
    )
    task_id = created["task"]["task_id"]
    first_job_id = created["job"]["job_id"]
    _claim_task_job(client, worker["worker_token"], worker_id)
    with client.app.state.SessionLocal() as db:
        task = db.query(AgentTask).filter(AgentTask.task_id == task_id).one()
        task.status = "failed"
        task.updated_at = utcnow()
        db.commit()

    rework = client.post(
        f"/api/tasks/{task_id}/review",
        headers=headers,
        json={"action": "request_changes", "note_markdown": "Run a second attempt."},
    )
    assert rework.status_code == 200, rework.text
    second_job_id = rework.json()["job"]["job_id"]

    completed = client.post(
        f"/api/internal/jobs/{first_job_id}/complete",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker_id,
            "result_text": "created_session_id=late-first-session\nLate first delivery.",
        },
    )

    assert completed.status_code == 200, completed.text
    detail = client.get(f"/api/tasks/{task_id}", headers=headers).json()
    assert detail["task"]["status"] == "queued"
    assert detail["task"]["latest_job_id"] == second_job_id
    assert detail["task"]["latest_session_id"] is None
    executions = {execution["job_id"]: execution for execution in detail["executions"]}
    assert executions[first_job_id]["status"] == "succeeded"
    assert executions[first_job_id]["session_id"] == "late-first-session"
    assert executions[second_job_id]["status"] == "queued"
    assert [artifact["kind"] for artifact in detail["artifacts"]].count("report") == 1


@pytest.mark.parametrize("terminal_status", ["accepted", "archived"])
def test_late_completion_does_not_overwrite_terminal_task_state(
    client: TestClient,
    terminal_status: str,
) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    worker = create_worker(client)
    headers = auth_headers(owner_login)
    worker_id = worker["worker"]["worker_id"]
    created = _create_submitted_task(
        client,
        headers=headers,
        worker_id=worker_id,
        title=f"Protected {terminal_status} task",
    )
    task_id = created["task"]["task_id"]
    job_id = created["job"]["job_id"]
    _claim_task_job(client, worker["worker_token"], worker_id)
    with client.app.state.SessionLocal() as db:
        task = db.query(AgentTask).filter(AgentTask.task_id == task_id).one()
        task.status = terminal_status
        task.latest_session_id = "reviewed-session"
        if terminal_status == "archived":
            task.archived_at = utcnow()
        task.updated_at = utcnow()
        db.commit()

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers={"Authorization": f"Bearer {worker['worker_token']}"},
        json={
            "worker_id": worker_id,
            "result_text": "created_session_id=late-terminal-session\nLate delivery.",
        },
    )

    assert completed.status_code == 200, completed.text
    detail = client.get(f"/api/tasks/{task_id}", headers=headers).json()
    assert detail["task"]["status"] == terminal_status
    assert detail["task"]["latest_session_id"] == "reviewed-session"
    assert detail["executions"][0]["status"] == "succeeded"
    assert detail["executions"][0]["session_id"] == "late-terminal-session"
    assert [artifact["kind"] for artifact in detail["artifacts"]].count("report") == 1
