from __future__ import annotations

import json
from pathlib import Path

import pytest

from agenthub_worker.task_workspace import (
    finalize_task_result,
    normalize_relevant_path,
    prepare_task_workspace,
)


def task_job(workspace_root: Path, *, attempt_number: int = 1, review_note: str = "") -> dict[str, object]:
    task_id = "tsk_0123456789abcdef0123456789abcdef"
    controls = {
        "sandbox_mode": "workspace-write",
        "approval_mode": "on-request",
        "yolo": False,
    }
    return {
        "job_id": f"job-attempt-{attempt_number}",
        "kind": "session_start",
        "backend": "codex",
        "workspace_root": str(workspace_root),
        "payload": {
            "task_id": task_id,
            "prompt": "AgentHub task prompt",
            "controls": controls,
            "task_workspace": {
                "schema_version": 1,
                "task_id": task_id,
                "relative_path": f".agenthub/tasks/{task_id}",
                "title": "修复任务目录",
                "brief_markdown": "建立可恢复的任务目录。",
                "success_criteria_markdown": "- report.md exists",
                "template_key": "fix_bug",
                "authority_preset": "code_fix",
                "relevant_paths": ["workers\\shared\\agenthub_worker", "apps/api/tests"],
                "attempt_number": attempt_number,
                "review_note": review_note,
                "authority": {
                    "read_paths": ["workers/shared/agenthub_worker", "apps/api/tests"],
                    "write_paths": ["workers/shared/agenthub_worker", "apps/api/tests"],
                    "runtime_controls": controls,
                    "enforcement": {
                        "runtime_controls": "mapped",
                        "command_level": "declared_only",
                    },
                },
            },
        },
    }


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (r"apps\api\app\routers\tasks.py", "apps/api/app/routers/tasks.py"),
        ("./workers/shared/agenthub_worker", "workers/shared/agenthub_worker"),
        ("docs/spec.md", "docs/spec.md"),
    ],
)
def test_normalize_relevant_path_is_cross_platform(raw: str, expected: str) -> None:
    assert normalize_relevant_path(raw) == expected


@pytest.mark.parametrize(
    "task_id",
    ["../escape", r"..\escape", "tsk_valid/child", "tsk_custom", "CON", r"C:\escape", "."],
)
def test_prepare_task_workspace_rejects_unsafe_task_ids(tmp_path: Path, task_id: str) -> None:
    job = task_job(tmp_path)
    job["payload"]["task_id"] = task_id  # type: ignore[index]
    job["payload"]["task_workspace"]["task_id"] = task_id  # type: ignore[index]

    with pytest.raises(ValueError, match="task_id"):
        prepare_task_workspace(job)

    assert not (tmp_path / ".agenthub").exists()


def test_prepare_task_workspace_writes_task_contract_and_prompt(tmp_path: Path) -> None:
    prepared = prepare_task_workspace(task_job(tmp_path))

    assert prepared is not None
    assert prepared.relative_path == ".agenthub/tasks/tsk_0123456789abcdef0123456789abcdef"
    assert prepared.task_file.read_text(encoding="utf-8").startswith("# 修复任务目录")
    assert "report.md" in prepared.prompt
    assert "agenthub.task.json" in prepared.prompt
    metadata = json.loads(prepared.metadata_file.read_text(encoding="utf-8"))
    assert metadata["relevant_paths"] == ["workers/shared/agenthub_worker", "apps/api/tests"]
    assert metadata["authority"]["enforcement"]["command_level"] == "declared_only"
    assert any(
        "Command-level enforcement is not provided" in item
        for item in metadata["authority"]["limitations"]
    )
    status = prepared.status_file.read_text(encoding="utf-8")
    assert "Attempt: 1" in status
    assert "State: running" in status


def test_prepare_task_workspace_canonicalizes_enforcement_claims(tmp_path: Path) -> None:
    job = task_job(tmp_path)
    job["payload"]["task_workspace"]["authority"]["enforcement"] = {  # type: ignore[index]
        "runtime_controls": "unrestricted",
        "command_level": "enforced",
    }

    prepared = prepare_task_workspace(job)

    assert prepared is not None
    metadata = json.loads(prepared.metadata_file.read_text(encoding="utf-8"))
    assert metadata["authority"]["enforcement"] == {
        "runtime_controls": "mapped",
        "command_level": "declared_only",
    }


def test_prepare_task_workspace_uses_actual_controls_and_preset_boundaries(tmp_path: Path) -> None:
    job = task_job(tmp_path)
    workspace = job["payload"]["task_workspace"]  # type: ignore[index]
    workspace["authority_preset"] = "read_only"
    workspace["authority"]["write_paths"] = ["."]
    workspace["authority"]["runtime_controls"] = {"yolo": True, "sandbox_mode": "danger-full-access"}

    prepared = prepare_task_workspace(job)

    assert prepared is not None
    metadata = json.loads(prepared.metadata_file.read_text(encoding="utf-8"))
    assert metadata["authority"]["write_paths"] == []
    assert metadata["authority"]["runtime_controls"] == job["payload"]["controls"]  # type: ignore[index]


@pytest.mark.parametrize(
    ("field", "value"),
    [("template_key", "shell_task"), ("authority_preset", "full_access")],
)
def test_prepare_task_workspace_rejects_unknown_contract_values(
    tmp_path: Path,
    field: str,
    value: str,
) -> None:
    job = task_job(tmp_path)
    job["payload"]["task_workspace"][field] = value  # type: ignore[index]

    with pytest.raises(ValueError, match=field):
        prepare_task_workspace(job)


def test_prepare_task_workspace_rejects_redirected_artifacts_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_id = "tsk_0123456789abcdef0123456789abcdef"
    artifacts = tmp_path / ".agenthub" / "tasks" / task_id / "artifacts"
    outside = tmp_path / "outside"
    outside.mkdir()
    original_resolve = Path.resolve

    def fake_resolve(path: Path, *args: object, **kwargs: object) -> Path:
        if path == artifacts:
            return outside
        return original_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", fake_resolve)

    with pytest.raises(ValueError, match="artifacts"):
        prepare_task_workspace(task_job(tmp_path))


def test_prepare_task_workspace_rejects_dangling_report_symlink(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    report = tmp_path / ".agenthub" / "tasks" / "tsk_0123456789abcdef0123456789abcdef" / "report.md"
    original_is_symlink = Path.is_symlink
    monkeypatch.setattr(
        Path,
        "is_symlink",
        lambda path: path == report or original_is_symlink(path),
    )

    with pytest.raises(ValueError, match="report"):
        prepare_task_workspace(task_job(tmp_path))


def test_prepare_task_workspace_rejects_non_positive_attempt(tmp_path: Path) -> None:
    job = task_job(tmp_path)
    job["payload"]["task_workspace"]["attempt_number"] = -1  # type: ignore[index]

    with pytest.raises(ValueError, match="attempt_number"):
        prepare_task_workspace(job)


def test_request_changes_reuses_task_directory_and_refreshes_metadata(tmp_path: Path) -> None:
    first = prepare_task_workspace(task_job(tmp_path))
    assert first is not None
    first.report_file.write_text("old report", encoding="utf-8")

    second = prepare_task_workspace(
        task_job(tmp_path, attempt_number=2, review_note="补充 Windows 和 Linux 路径测试。")
    )

    assert second is not None
    assert second.directory == first.directory
    metadata = json.loads(second.metadata_file.read_text(encoding="utf-8"))
    assert metadata["attempt_number"] == 2
    assert metadata["review_note"] == "补充 Windows 和 Linux 路径测试。"
    assert "Attempt: 2" in second.status_file.read_text(encoding="utf-8")
    assert "补充 Windows 和 Linux 路径测试。" in second.status_file.read_text(encoding="utf-8")
    assert not second.report_file.exists()
    assert (second.directory / "artifacts" / "report-attempt-1.md").read_text(encoding="utf-8") == "old report"


def test_finalize_task_result_prefers_report_without_moving_session_marker(tmp_path: Path) -> None:
    prepared = prepare_task_workspace(task_job(tmp_path))
    assert prepared is not None
    prepared.report_file.write_text("# Delivery\n\nAll focused tests pass.\n", encoding="utf-8")

    result = finalize_task_result(
        "created_session_id=new-session\nassistant final fallback",
        prepared,
    )

    assert result == "created_session_id=new-session\n# Delivery\n\nAll focused tests pass."
    prepared.report_file.unlink()
    assert finalize_task_result("created_session_id=new-session\nassistant final fallback", prepared) == (
        "created_session_id=new-session\nassistant final fallback"
    )


def test_finalize_task_result_does_not_follow_report_symlinks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prepared = prepare_task_workspace(task_job(tmp_path))
    assert prepared is not None
    prepared.report_file.write_text("outside secret", encoding="utf-8")
    original_is_symlink = Path.is_symlink
    monkeypatch.setattr(
        Path,
        "is_symlink",
        lambda path: path == prepared.report_file or original_is_symlink(path),
    )

    result = finalize_task_result("created_session_id=new-session\nassistant final fallback", prepared)

    assert result == "created_session_id=new-session\nassistant final fallback"


def test_finalize_task_result_rejects_retargeted_task_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prepared = prepare_task_workspace(task_job(tmp_path))
    assert prepared is not None
    initial_status = prepared.status_file.read_text(encoding="utf-8")
    prepared.report_file.write_text("external report", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    original_resolve = Path.resolve

    def fake_resolve(path: Path, *args: object, **kwargs: object) -> Path:
        if path == prepared.directory:
            return outside
        return original_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", fake_resolve)

    result = finalize_task_result("created_session_id=new-session\nassistant final fallback", prepared)

    assert result == "created_session_id=new-session\nassistant final fallback"
    assert prepared.status_file.read_text(encoding="utf-8") == initial_status
