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
