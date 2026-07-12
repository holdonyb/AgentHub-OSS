from __future__ import annotations

from agenthub_protocol import TaskAuthorityBoundary, TaskWorkspaceConfig


def test_protocol_exposes_task_workspace_contract() -> None:
    config = TaskWorkspaceConfig(
        task_id="tsk_0123456789abcdef0123456789abcdef",
        relative_path=".agenthub/tasks/tsk_0123456789abcdef0123456789abcdef",
        title="Protocol task",
        brief_markdown="Exercise the shared contract.",
        template_key="code_review",
        authority_preset="review_only",
        relevant_paths=["packages/protocol"],
        authority=TaskAuthorityBoundary(
            read_paths=["packages/protocol"],
            write_paths=[],
            runtime_controls={"sandbox_mode": "read-only"},
            enforcement={"runtime_controls": "mapped", "command_level": "declared_only"},
        ),
    )

    assert config.template_key == "code_review"
    assert config.authority_preset == "review_only"
    assert config.authority.enforcement["command_level"] == "declared_only"
