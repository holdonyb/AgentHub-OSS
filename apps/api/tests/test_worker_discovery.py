from __future__ import annotations

import hashlib
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from agenthub_worker import discovery
from agenthub_worker.discovery import parse_claude_jsonl, parse_codex_jsonl, parse_kimi_session, recent_session_files
from agenthub_worker.paths import normalize_workspace_root
from agenthub_linux_worker.discovery import discover_capabilities as discover_linux_capabilities
from agenthub_windows_worker.discovery import discover_capabilities, discover_sessions as discover_windows_sessions
from agenthub_windows_worker.main import _session_roots, _workspace_roots


def test_windows_path_normalization_handles_backslashes_chinese_and_spaces() -> None:
    assert normalize_workspace_root(r"E:\work\中文 项目") == "E:/work/中文 项目"
    assert normalize_workspace_root("E:/work/AgentHub") == "E:/work/AgentHub"


def test_windows_capabilities_find_commands_from_custom_npm_prefix_when_service_path_is_stale(
    tmp_path: Path, monkeypatch
) -> None:
    home = tmp_path / "home"
    npm_prefix = tmp_path / "npm-global"
    home.mkdir()
    npm_prefix.mkdir()
    (home / ".npmrc").write_text(f"prefix={npm_prefix}\n", encoding="utf-8")
    (npm_prefix / "codex.cmd").write_text("@echo off\n", encoding="utf-8")
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", str(tmp_path / "stale-path"))

    assert discover_capabilities()["codex"] is True


def test_workers_advertise_streamed_file_transfer_capability() -> None:
    assert discover_capabilities()["file_transfer_v2"] is True
    assert discover_linux_capabilities()["file_transfer_v2"] is True


def test_windows_default_workspace_roots_do_not_include_agent_session_stores(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    codex_sessions = home / ".codex" / "sessions"
    claude_projects = home / ".claude" / "projects"
    kimi_sessions = home / ".kimi" / "sessions"
    for root in (codex_sessions, claude_projects, kimi_sessions):
        root.mkdir(parents=True)

    monkeypatch.delenv("AGENTHUB_WORKSPACE_ROOTS", raising=False)
    monkeypatch.setenv("USERPROFILE", str(home))

    roots = _workspace_roots(None)

    assert Path("E:/work") in roots
    assert codex_sessions not in roots
    assert claude_projects not in roots
    assert kimi_sessions not in roots


def test_windows_default_session_roots_include_agent_session_stores(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    codex_sessions = home / ".codex" / "sessions"
    claude_projects = home / ".claude" / "projects"
    kimi_sessions = home / ".kimi" / "sessions"
    for root in (codex_sessions, claude_projects, kimi_sessions):
        root.mkdir(parents=True)

    monkeypatch.delenv("AGENTHUB_SESSION_ROOTS", raising=False)
    monkeypatch.setenv("USERPROFILE", str(home))

    roots = _session_roots()

    assert codex_sessions in roots
    assert claude_projects in roots
    assert kimi_sessions in roots


def test_windows_env_workspace_roots_are_merged_with_default_workspace(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    codex_sessions = home / ".codex" / "sessions"
    claude_projects = home / ".claude" / "projects"
    kimi_sessions = home / ".kimi" / "sessions"
    custom_root = tmp_path / "custom-workspace"
    for root in (codex_sessions, claude_projects, kimi_sessions, custom_root):
        root.mkdir(parents=True)

    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("AGENTHUB_WORKSPACE_ROOTS", str(custom_root))

    roots = _workspace_roots(None)

    assert Path("E:/work") in roots
    assert custom_root in roots
    assert codex_sessions not in roots
    assert claude_projects not in roots
    assert kimi_sessions not in roots


def test_windows_env_session_roots_are_merged_with_agent_session_stores(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    codex_sessions = home / ".codex" / "sessions"
    claude_projects = home / ".claude" / "projects"
    kimi_sessions = home / ".kimi" / "sessions"
    custom_session_root = tmp_path / "extra-sessions"
    for root in (codex_sessions, claude_projects, kimi_sessions, custom_session_root):
        root.mkdir(parents=True)

    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("AGENTHUB_SESSION_ROOTS", str(custom_session_root))

    roots = _session_roots()

    assert custom_session_root in roots
    assert codex_sessions in roots
    assert claude_projects in roots
    assert kimi_sessions in roots


def test_recent_session_files_skips_roots_that_disappear_during_scan(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    def broken_walk(root_path: Path):
        raise OSError("directory disappeared")
        yield from ()

    monkeypatch.setattr(discovery.os, "walk", broken_walk)

    assert recent_session_files([root]) == []


def test_recent_session_files_skips_noisy_project_dependency_dirs(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    valid = root / ".codex" / "sessions" / "keep.jsonl"
    noisy = root / "node_modules" / ".codex" / "sessions" / "skip.jsonl"
    valid.parent.mkdir(parents=True)
    noisy.parent.mkdir(parents=True)
    valid.write_text('{"type":"session","id":"keep","cwd":"E:/work"}\n', encoding="utf-8")
    noisy.write_text('{"type":"session","id":"skip","cwd":"E:/work"}\n', encoding="utf-8")

    paths = [path.name for _, path in recent_session_files([root])]

    assert paths == ["keep.jsonl"]


def test_codex_jsonl_fixture_parses_session_metadata(tmp_path: Path) -> None:
    fixture = tmp_path / "codex.jsonl"
    fixture.write_text(
        '{"type":"session","id":"codex-1","cwd":"E:\\\\work\\\\AgentHub","title":"Build AgentHub"}\n'
        '{"type":"message","role":"assistant","content":"Ready for next step"}\n',
        encoding="utf-8",
    )

    session = parse_codex_jsonl(fixture)
    assert session.session_id == "codex-1"
    assert session.backend == "codex"
    assert session.workspace_root == "E:/work/AgentHub"
    assert session.title == "Build AgentHub"
    assert session.last_message == "Ready for next step"


def test_codex_parser_keeps_first_session_meta_when_fork_context_contains_parent(tmp_path: Path) -> None:
    fixture = tmp_path / "rollout-2026-04-07T08-19-43-child-session.jsonl"
    fixture.write_text(
        '{"timestamp":"2026-04-07T00:19:43.108Z","type":"session_meta","payload":{"id":"child-session","cwd":"E:\\\\work","source":{"subagent":{}}}}\n'
        '{"timestamp":"2026-04-07T00:19:43.112Z","type":"session_meta","payload":{"id":"parent-session","cwd":"E:\\\\work"}}\n'
        '{"timestamp":"2026-04-07T00:20:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"子任务分析"}}\n',
        encoding="utf-8",
    )

    session = parse_codex_jsonl(fixture)

    assert session.session_id == "child-session"
    assert session.display_title == "子任务分析"


def test_codex_parser_prefers_rollout_filename_session_id_when_meta_uses_human_slug(tmp_path: Path) -> None:
    fixture = tmp_path / "rollout-2026-06-13T09-05-42-019ebe83-63a4-7a81-9b49-327c732a94ae.jsonl"
    fixture.write_text(
        '{"timestamp":"2026-06-13T09:05:42.000Z","type":"session_meta","payload":{"id":"autopilot-cockpit-2026-06-13","cwd":"E:\\\\Work","source":"exec"}}\n'
        '{"timestamp":"2026-06-13T09:05:50.000Z","type":"event_msg","payload":{"type":"user_message","message":"继续 autopilot 收口"}}\n',
        encoding="utf-8",
    )

    session = parse_codex_jsonl(fixture)

    assert session.session_id == "019ebe83-63a4-7a81-9b49-327c732a94ae"
    assert session.display_title == "继续 autopilot 收口"


def test_short_acknowledgement_is_not_used_as_session_title(tmp_path: Path) -> None:
    fixture = tmp_path / "rollout-2026-04-26T18-26-34-ack-session.jsonl"
    fixture.write_text(
        '{"timestamp":"2026-04-26T10:00:00.000Z","type":"session_meta","payload":{"id":"ack-session","cwd":"E:\\\\work"}}\n'
        '{"timestamp":"2026-04-26T10:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"回复了"}}\n'
        '{"timestamp":"2026-04-26T10:02:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"收到，我继续处理。"}]}}\n',
        encoding="utf-8",
    )

    session = parse_codex_jsonl(fixture)

    assert session.display_title.startswith("work · codex ·")
    assert session.display_title != "回复了"


def test_real_codex_rollout_fixture_extracts_transcript_identity_and_activity(tmp_path: Path) -> None:
    fixture = tmp_path / "rollout-2026-04-26T18-26-34-019dc953-a141.jsonl"
    fixture.write_text(
        '{"timestamp":"2026-04-26T10:26:35.371Z","type":"session_meta","payload":{"id":"019dc953-a141","cwd":"E:\\\\work\\\\AgentHub"}}\n'
        '{"timestamp":"2026-04-26T10:27:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"修复 AgentHub session 列表标题"}}\n'
        '{"timestamp":"2026-04-26T10:28:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"我会先修 Codex parser，再更新 UI。"}]}}\n'
        '{"timestamp":"2026-04-26T10:29:00.000Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"pytest\\"}"}}\n',
        encoding="utf-8",
    )

    session = parse_codex_jsonl(fixture)

    assert session.session_id == "019dc953-a141"
    assert session.workspace_root == "E:/work/AgentHub"
    assert session.display_title == "修复 AgentHub session 列表标题"
    assert session.status == "needs_reply"
    assert "等你回复" in session.activity_summary
    assert session.last_message == "我会先修 Codex parser，再更新 UI。"
    assert session.last_activity_at is not None
    assert session.last_role == "system"
    timeline = session.runtime_metadata["timeline"]
    assert [item["item_type"] for item in timeline] == ["user_message", "assistant_message", "tool_call"]
    assert timeline[0]["text"] == "修复 AgentHub session 列表标题"


def test_codex_parser_deduplicates_mirrored_assistant_events(tmp_path: Path) -> None:
    fixture = tmp_path / "rollout-2026-04-30T01-00-00-session.jsonl"
    fixture.write_text(
        '{"timestamp":"2026-04-30T01:00:00.000Z","type":"session_meta","payload":{"id":"session","cwd":"E:\\\\work\\\\AgentHub"}}\n'
        '{"timestamp":"2026-04-30T01:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"继续"}}\n'
        '{"timestamp":"2026-04-30T01:02:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"我继续处理","phase":"assistant"}}\n'
        '{"timestamp":"2026-04-30T01:02:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"assistant","content":[{"type":"output_text","text":"我继续处理"}]}}\n',
        encoding="utf-8",
    )

    session = parse_codex_jsonl(fixture)

    timeline = session.runtime_metadata["timeline"]
    assistant_items = [item for item in timeline if item["item_type"] == "assistant_message"]
    assert len(assistant_items) == 1
    assert assistant_items[0]["text"] == "我继续处理"


def test_codex_parser_does_not_keep_stale_tool_action_running(tmp_path: Path) -> None:
    old_timestamp = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat().replace("+00:00", "Z")
    fixture = tmp_path / "rollout-2026-05-05T00-00-00-stale-action.jsonl"
    fixture.write_text(
        '{"timestamp":"2026-05-05T00:00:00.000Z","type":"session_meta","payload":{"id":"stale-action","cwd":"E:\\\\work\\\\AgentHub"}}\n'
        '{"timestamp":"2026-05-05T00:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"跑测试"}}\n'
        f'{{"timestamp":"{old_timestamp}","type":"response_item","payload":{{"type":"function_call","name":"shell_command","arguments":"{{\\"command\\":\\"pytest\\"}}"}}}}\n',
        encoding="utf-8",
    )

    session = parse_codex_jsonl(fixture)

    assert session.status == "ready"
    assert session.activity_summary.startswith("最近上下文")


def test_codex_parser_keeps_recent_tool_action_running(tmp_path: Path) -> None:
    recent_timestamp = (datetime.now(timezone.utc) - timedelta(minutes=3)).isoformat().replace("+00:00", "Z")
    fixture = tmp_path / "rollout-2026-05-05T00-00-00-recent-action.jsonl"
    fixture.write_text(
        '{"timestamp":"2026-05-05T00:00:00.000Z","type":"session_meta","payload":{"id":"recent-action","cwd":"E:\\\\work\\\\AgentHub"}}\n'
        '{"timestamp":"2026-05-05T00:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"跑测试"}}\n'
        f'{{"timestamp":"{recent_timestamp}","type":"response_item","payload":{{"type":"function_call","name":"shell_command","arguments":"{{\\"command\\":\\"pytest\\"}}"}}}}\n',
        encoding="utf-8",
    )

    session = parse_codex_jsonl(fixture)

    assert session.status == "running"
    assert session.activity_summary.startswith("正在执行")


def test_claude_jsonl_fixture_parses_session_metadata(tmp_path: Path) -> None:
    fixture = tmp_path / "claude.jsonl"
    fixture.write_text(
        '{"sessionId":"claude-1","cwd":"/home/dev/AgentHub","type":"summary","summary":"Fix worker"}\n'
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Needs reply"}]}}\n',
        encoding="utf-8",
    )

    session = parse_claude_jsonl(fixture)
    assert session.session_id == "claude-1"
    assert session.backend == "claude"
    assert session.workspace_root == "/home/dev/AgentHub"
    assert session.title == "Fix worker"
    assert session.last_message == "Needs reply"


def test_claude_jsonl_keeps_first_workspace_root_when_later_rows_enter_nested_dir(tmp_path: Path) -> None:
    fixture = tmp_path / "claude-nested-cwd.jsonl"
    fixture.write_text(
        '{"sessionId":"claude-root","cwd":"E:\\\\work","type":"summary","summary":"Root workspace"}\n'
        '{"type":"assistant","cwd":"E:\\\\work\\\\开创力\\\\课程创建Agent\\\\backend","message":{"role":"assistant","content":[{"type":"text","text":"继续处理"}]}}\n',
        encoding="utf-8",
    )

    session = parse_claude_jsonl(fixture)

    assert session.workspace_root == "E:/work"


def test_claude_jsonl_infers_workspace_root_from_project_bucket_when_rows_omit_cwd(tmp_path: Path) -> None:
    fixture = tmp_path / ".claude" / "projects" / "E--work" / "claude-root.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text(
        '{"sessionId":"claude-root","type":"summary","summary":"Root workspace"}\n'
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"继续处理"}]}}\n',
        encoding="utf-8",
    )

    session = parse_claude_jsonl(fixture)

    assert session.workspace_root == "E:/work"


def test_claude_jsonl_ignores_local_command_echo_entries(tmp_path: Path) -> None:
    fixture = tmp_path / "claude-local-command.jsonl"
    fixture.write_text(
        '{"sessionId":"claude-2","cwd":"E:/Work/AgentHub","type":"summary","summary":"Forked from codex"}\n'
        '{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\\n<command-message>model</command-message>\\n<command-args>fable</command-args>"}}\n'
        '{"type":"assistant","message":{"role":"assistant","content":"<local-command-stdout>Set model to Fable 5 and saved as your default for new sessions</local-command-stdout>"}}\n'
        '{"type":"assistant","message":{"role":"assistant","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>"}}\n'
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Agent"},{"type":"text","text":"真正的回复内容"}]}}\n',
        encoding="utf-8",
    )

    session = parse_claude_jsonl(fixture)

    timeline = session.runtime_metadata["timeline"]
    assert len(timeline) == 1
    assert timeline[0]["text"] == "真正的回复内容"
    assert session.last_message == "真正的回复内容"


def test_claude_jsonl_preserves_tool_calls_and_structured_tool_results(tmp_path: Path) -> None:
    fixture = tmp_path / "claude-tooling.jsonl"
    fixture.write_text(
        '{"sessionId":"claude-3","cwd":"E:/Work","type":"summary","summary":"Autopilot run"}\n'
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_task_create","name":"TaskCreate","input":{"subject":"A/V:旁白长则冻帧延长视频","description":"补齐媒体链路","activeForm":"创建任务"}}]}}\n'
        '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_task_create","type":"tool_result","content":"Task #7 created successfully: A/V:旁白长则冻帧延长视频"}]},"toolUseResult":{"task":{"id":"7","subject":"A/V:旁白长则冻帧延长视频"}}}\n'
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_bash","name":"Bash","input":{"command":"pytest -q","description":"run tests"}}]}}\n'
        '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_bash","type":"tool_result","content":"12 passed in 6.79s","is_error":false}]},"toolUseResult":{"stdout":"test updated\\n12 passed in 6.79s","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}\n'
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_task_update","name":"TaskUpdate","input":{"taskId":"7","status":"in_progress"}}]}}\n'
        '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_task_update","type":"tool_result","content":"Updated task #7 status"}]},"toolUseResult":{"success":true,"taskId":"7","updatedFields":["status"],"statusChange":{"from":"pending","to":"in_progress"}}}\n'
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_reject","name":"Bash","input":{"command":"git status"}}]}}\n'
        '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_reject","type":"tool_result","content":"The user doesn\'t want to proceed with this tool use.","is_error":true}]},"toolUseResult":"User rejected tool use"}\n'
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"我先继续修剩下的缺口。"}]}}\n',
        encoding="utf-8",
    )

    session = parse_claude_jsonl(fixture)

    timeline = session.runtime_metadata["timeline"]
    assert [item["item_type"] for item in timeline] == [
        "tool_call",
        "tool_call",
        "tool_call",
        "tool_call",
        "tool_call",
        "tool_call",
        "tool_call",
        "tool_call",
        "assistant_message",
    ]
    assert timeline[0]["tool_name"] == "TaskCreate"
    assert "A/V:旁白长则冻帧延长视频" in timeline[0]["text"]
    assert timeline[1]["tool_call_id"] == "toolu_task_create"
    assert "#7" in timeline[1]["text"]
    assert timeline[2]["tool_name"] == "Bash"
    assert "pytest -q" in timeline[2]["text"]
    assert timeline[3]["tool_call_id"] == "toolu_bash"
    assert "12 passed in 6.79s" in timeline[3]["text"]
    assert "test updated" in timeline[3]["text"]
    assert timeline[4]["tool_name"] == "TaskUpdate"
    assert "taskId: 7" in timeline[5]["text"]
    assert "status: pending -> in_progress" in timeline[5]["text"]
    assert timeline[6]["tool_name"] == "Bash"
    assert "git status" in timeline[6]["text"]
    assert "User rejected tool use" in timeline[7]["text"]
    assert timeline[-1]["text"] == "我先继续修剩下的缺口。"
    assert session.last_message == "我先继续修剩下的缺口。"


def test_kimi_wire_session_parses_user_assistant_and_state(tmp_path: Path) -> None:
    session_dir = tmp_path / ".kimi" / "sessions" / "workspace-hash" / "session-uuid"
    session_dir.mkdir(parents=True)
    (session_dir / "wire.jsonl").write_text(
        '{"type":"metadata","protocol_version":"1.5"}\n'
        '{"timestamp":1775529995.0255253,"message":{"type":"TurnBegin","payload":{"user_input":"你好，回复一个 OK"}}}\n'
        '{"timestamp":1775529999.2562363,"message":{"type":"ContentPart","payload":{"type":"text","text":"OK"}}}\n',
        encoding="utf-8",
    )
    (session_dir / "context.jsonl").write_text(
        '{"role":"user","content":"你好，回复一个 OK"}\n'
        '{"role":"assistant","content":"OK"}\n',
        encoding="utf-8",
    )
    (session_dir / "state.json").write_text('{"approval":{"yolo":true},"plan_mode":false}', encoding="utf-8")

    session = parse_kimi_session(session_dir)

    assert session.session_id == "session-uuid"
    assert session.backend == "kimi"
    assert session.display_title == "你好，回复一个 OK"
    assert session.last_message == "OK"
    assert session.controls["yolo"] is True
    assert session.last_activity_at is not None
    assert [item["item_type"] for item in session.runtime_metadata["timeline"]] == ["user_message", "assistant_message"]


def test_kimi_wire_session_preserves_tool_call_and_result_details(tmp_path: Path) -> None:
    session_dir = tmp_path / ".kimi" / "sessions" / "workspace-hash" / "session-uuid"
    session_dir.mkdir(parents=True)
    (session_dir / "wire.jsonl").write_text(
        '{"timestamp":1775529995.0255253,"message":{"type":"TurnBegin","payload":{"user_input":"继续"}}}\n'
        '{"timestamp":1775529996.0255253,"message":{"type":"ToolCall","payload":{"type":"function","id":"tool_1","function":{"name":"ReadFile","arguments":"{\\"path\\":\\"README.md\\"}"}}}}\n'
        '{"timestamp":1775529997.0255253,"message":{"type":"ToolResult","payload":{"tool_call_id":"tool_1","return_value":{"is_error":false,"output":"hello from file","message":"1 line read","display":[{"type":"text","text":"preview text"}]}}}}\n'
        '{"timestamp":1775529998.0255253,"message":{"type":"ApprovalRequest","payload":{"id":"approval_1","tool_call_id":"tool_2","sender":"Shell","action":"run command","description":"Run command `dir`"}}}\n',
        encoding="utf-8",
    )

    session = parse_kimi_session(session_dir)

    timeline = session.runtime_metadata["timeline"]
    tool_call = next(item for item in timeline if item["tool_call_id"] == "tool_1")
    tool_result = next(item for item in timeline if item["text"].startswith("工具结果:"))
    approval = next(item for item in timeline if item["tool_call_id"] == "tool_2")

    assert tool_call["item_type"] == "tool_call"
    assert tool_call["tool_name"] == "ReadFile"
    assert "README.md" in tool_call["text"]
    assert tool_result["tool_call_id"] == "tool_1"
    assert "hello from file" in tool_result["text"]
    assert "preview text" in tool_result["text"]
    assert approval["tool_name"] == "Shell"
    assert "Run command `dir`" in approval["text"]


def test_kimi_session_resolves_hashed_workdir_from_kimi_registry(tmp_path: Path) -> None:
    workdir = r"E:\Work\Kimi Project"
    workdir_hash = hashlib.md5(workdir.encode()).hexdigest()
    session_dir = tmp_path / "home" / ".kimi" / "sessions" / workdir_hash / "session-uuid"
    session_dir.mkdir(parents=True)
    kimi_root = session_dir.parents[2]
    (kimi_root / "kimi.json").write_text(
        '{"work_dirs":[{"path":"E:\\\\Work\\\\Kimi Project","kaos":"local","last_session_id":null}]}',
        encoding="utf-8",
    )
    (session_dir / "wire.jsonl").write_text(
        '{"timestamp":1775529995.0255253,"message":{"type":"TurnBegin","payload":{"user_input":"继续 Kimi 项目"}}}\n'
        '{"timestamp":1775529999.2562363,"message":{"type":"ContentPart","payload":{"type":"text","text":"OK"}}}\n',
        encoding="utf-8",
    )

    session = parse_kimi_session(session_dir)

    assert session.workspace_root == "E:/Work/Kimi Project"
    assert session.project_name == "Kimi Project"
    assert session.metadata["workdir_hash"] == workdir_hash


def test_windows_discovery_deduplicates_kimi_wire_and_context_jsonl(tmp_path: Path) -> None:
    workdir = r"E:\Work\Kimi Project"
    workdir_hash = hashlib.md5(workdir.encode()).hexdigest()
    kimi_root = tmp_path / ".kimi" / "sessions"
    session_dir = kimi_root / workdir_hash / "session-uuid"
    session_dir.mkdir(parents=True)
    (session_dir.parents[2] / "kimi.json").write_text(
        '{"work_dirs":[{"path":"E:\\\\Work\\\\Kimi Project","kaos":"local","last_session_id":null}]}',
        encoding="utf-8",
    )
    (session_dir / "wire.jsonl").write_text(
        '{"timestamp":1775529995.0255253,"message":{"type":"TurnBegin","payload":{"user_input":"Kimi 去重"}}}\n',
        encoding="utf-8",
    )
    (session_dir / "context.jsonl").write_text('{"role":"user","content":"Kimi 去重"}\n', encoding="utf-8")

    sessions = discover_windows_sessions([kimi_root])

    assert [session["session_id"] for session in sessions] == ["session-uuid"]


def test_windows_discovery_detects_codex_jsonl_by_root_path(tmp_path: Path) -> None:
    codex_root = tmp_path / ".codex" / "sessions"
    codex_root.mkdir(parents=True)
    fixture = codex_root / "rollout-2026-04-26T12-00-00.jsonl"
    fixture.write_text(
        '{"type":"session","id":"codex-real","cwd":"E:\\\\work\\\\AgentHub","title":"Real Codex"}\n',
        encoding="utf-8",
    )

    sessions = discover_windows_sessions([codex_root])

    assert [session["backend"] for session in sessions] == ["codex"]
    assert sessions[0]["session_id"] == "codex-real"


def test_windows_discovery_limits_to_recent_session_files(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AGENTHUB_DISCOVERY_MAX_FILES", "2")
    codex_root = tmp_path / ".codex" / "sessions"
    codex_root.mkdir(parents=True)

    for index, session_id in enumerate(["old", "new", "newest"], start=1):
        fixture = codex_root / f"{session_id}.jsonl"
        fixture.write_text(
            f'{{"type":"session","id":"{session_id}","cwd":"E:\\\\work\\\\AgentHub","title":"{session_id}"}}\n',
            encoding="utf-8",
        )
        os.utime(fixture, (1_700_000_000 + index, 1_700_000_000 + index))

    sessions = discover_windows_sessions([codex_root])

    assert [session["session_id"] for session in sessions] == ["newest", "new"]


def test_windows_discovery_detects_claude_jsonl_by_root_path(tmp_path: Path) -> None:
    claude_root = tmp_path / ".claude" / "projects"
    claude_root.mkdir(parents=True)
    fixture = claude_root / "6e7be65e-a61e-427d-8565-2af1c1a524b1.jsonl"
    fixture.write_text(
        '{"sessionId":"claude-real","cwd":"E:\\\\work\\\\AgentHub","type":"summary","summary":"Real Claude"}\n',
        encoding="utf-8",
    )

    sessions = discover_windows_sessions([claude_root])

    assert [session["backend"] for session in sessions] == ["claude"]
    assert sessions[0]["session_id"] == "claude-real"


def test_windows_discovery_skips_claude_subagent_jsonl_duplicates(tmp_path: Path) -> None:
    claude_root = tmp_path / ".claude" / "projects" / "E--work-AgentHub"
    subagent_root = claude_root / "parent-session" / "subagents"
    subagent_root.mkdir(parents=True)
    (claude_root / "parent-session.jsonl").write_text(
        '{"sessionId":"parent-session","cwd":"E:\\\\work\\\\AgentHub","type":"summary","summary":"Parent"}\n',
        encoding="utf-8",
    )
    (subagent_root / "agent-1.jsonl").write_text(
        '{"sessionId":"parent-session","cwd":"E:\\\\work\\\\AgentHub","type":"assistant","message":{"content":"Subagent"}}\n',
        encoding="utf-8",
    )

    sessions = discover_windows_sessions([claude_root])

    assert [session["session_id"] for session in sessions] == ["parent-session"]
