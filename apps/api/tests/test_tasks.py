from __future__ import annotations

from fastapi.testclient import TestClient

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


def _claim_and_complete_task_job(client: TestClient, worker_token: str, worker_id: str, job_id: str, result_text: str) -> None:
    claimed = client.post(
        "/api/internal/jobs/claim",
        headers={"Authorization": f"Bearer {worker_token}"},
        json={"worker_id": worker_id},
    )
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["job"]["job_id"] == job_id

    completed = client.post(
        f"/api/internal/jobs/{job_id}/complete",
        headers={"Authorization": f"Bearer {worker_token}"},
        json={"worker_id": worker_id, "result_text": result_text},
    )
    assert completed.status_code == 200, completed.text


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
