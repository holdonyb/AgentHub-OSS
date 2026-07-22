from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

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


def test_recent_session_files_reuses_index_between_polls(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / ".codex" / "sessions"
    root.mkdir(parents=True)
    fixture = root / "keep.jsonl"
    fixture.write_text('{"type":"session","id":"keep","cwd":"E:/work"}\n', encoding="utf-8")

    walk_calls: list[str] = []
    original_walk = discovery.os.walk

    def tracked_walk(path: Path):
        walk_calls.append(str(path))
        yield from original_walk(path)

    monkeypatch.setattr(discovery.os, "walk", tracked_walk)
    monkeypatch.setenv("AGENTHUB_DISCOVERY_RECONCILE_SECONDS", "3600")
    discovery.reset_recent_session_index()

    assert [path.name for _, path in recent_session_files([root])] == ["keep.jsonl"]
    assert [path.name for _, path in recent_session_files([root])] == ["keep.jsonl"]

    assert walk_calls == []


def test_recent_session_files_cold_start_uses_probe_instead_of_full_walk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / ".codex" / "sessions"
    today = datetime.now()
    fixture = root / today.strftime("%Y") / today.strftime("%m") / today.strftime("%d") / "keep.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text('{"type":"session","id":"keep","cwd":"E:/work"}\n', encoding="utf-8")

    def fail_if_walked(*args, **kwargs):
        raise AssertionError("cold start should not do a full recursive walk")

    monkeypatch.setattr(discovery.os, "walk", fail_if_walked)
    monkeypatch.setenv("AGENTHUB_DISCOVERY_RECONCILE_SECONDS", "3600")
    discovery.reset_recent_session_index()

    paths = [path.name for _, path in recent_session_files([root])]

    assert paths == ["keep.jsonl"]


def test_codex_cold_start_uses_runtime_index_for_old_active_session(tmp_path: Path) -> None:
    codex_root = tmp_path / ".codex"
    root = codex_root / "sessions"
    fixture = root / "2020" / "01" / "01" / "old-active.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text('{"type":"session","id":"old-active","cwd":"E:/work"}\n', encoding="utf-8")
    database = sqlite3.connect(codex_root / "state_5.sqlite")
    database.execute("CREATE TABLE threads (rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL)")
    database.execute("INSERT INTO threads(rollout_path, updated_at) VALUES(?, ?)", (str(fixture), 999))
    database.commit()
    database.close()

    discovery.reset_recent_session_index()

    assert [path for _, path in recent_session_files([root])] == [fixture]


def test_claude_cold_start_uses_history_index_without_scanning_project_files(tmp_path: Path) -> None:
    claude_root = tmp_path / ".claude"
    root = claude_root / "projects"
    fixture = root / "E--work" / "claude-active.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text(
        '{"sessionId":"claude-active","cwd":"E:/work","type":"summary","summary":"Active"}\n',
        encoding="utf-8",
    )
    (claude_root / "history.jsonl").write_text(
        '{"timestamp":999,"project":"E:\\\\work","sessionId":"claude-active","display":"continue"}\n',
        encoding="utf-8",
    )

    discovery.reset_recent_session_index()

    assert [path for _, path in recent_session_files([root])] == [fixture]


def test_kimi_cold_start_uses_registry_without_scanning_session_history(tmp_path: Path) -> None:
    kimi_root = tmp_path / ".kimi"
    root = kimi_root / "sessions"
    workspace = "E:\\Work\\Kimi Project"
    workdir_hash = hashlib.md5(workspace.encode()).hexdigest()
    fixture = root / workdir_hash / "kimi-active" / "wire.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text(
        '{"timestamp":"2026-07-21T12:01:00Z","message":{"type":"ContentPart","payload":{"type":"text","text":"Active"}}}\n',
        encoding="utf-8",
    )
    (kimi_root / "kimi.json").write_text(
        json.dumps({"work_dirs": [{"path": workspace, "last_session_id": "kimi-active"}]}),
        encoding="utf-8",
    )

    discovery.reset_recent_session_index()

    assert [path for _, path in recent_session_files([root])] == [fixture]


def test_recent_session_files_restores_known_paths_after_worker_restart(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / ".codex" / "sessions"
    fixture = root / "2020" / "01" / "01" / "historical-active.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text('{"type":"session","id":"historical-active","cwd":"E:/work"}\n', encoding="utf-8")
    cache_path = tmp_path / "runtime" / "discovery-cache.sqlite3"
    probe_enabled = True

    def controlled_probe(probe_root: Path, _limit: int):
        assert probe_root == root
        if probe_enabled:
            yield fixture

    monkeypatch.setenv("AGENTHUB_DISCOVERY_SNAPSHOT_DB", str(cache_path))
    monkeypatch.setattr(discovery, "_probe_recent_jsonl_paths", controlled_probe)
    discovery.reset_discovery_snapshot_cache()
    discovery.reset_recent_session_index()

    assert [path for _, path in recent_session_files([root])] == [fixture]

    probe_enabled = False
    discovery.reset_recent_session_index()

    assert [path for _, path in recent_session_files([root])] == [fixture]


def test_discovery_cache_recovers_when_disposable_database_is_corrupt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / ".codex" / "sessions"
    fixture = root / "keep.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text('{"type":"session","id":"keep","cwd":"E:/work"}\n', encoding="utf-8")
    cache_path = tmp_path / "runtime" / "discovery-cache.sqlite3"
    cache_path.parent.mkdir(parents=True)
    cache_path.write_bytes(b"not a sqlite database")

    monkeypatch.setenv("AGENTHUB_DISCOVERY_SNAPSHOT_DB", str(cache_path))
    monkeypatch.setattr(discovery, "_snapshot_cache", None)
    discovery.reset_recent_session_index()

    assert [path for _, path in recent_session_files([root])] == [fixture]
    with sqlite3.connect(cache_path) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_discovery_continues_when_disposable_cache_is_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / ".codex" / "sessions"
    fixture = root / "keep.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text(
        '{"type":"session","id":"keep","cwd":"E:/work"}\n',
        encoding="utf-8",
    )
    cache = discovery._SnapshotCache(tmp_path / "runtime" / "discovery-cache.sqlite3")

    def unavailable_connection() -> sqlite3.Connection:
        raise sqlite3.OperationalError("attempt to write a readonly database")

    monkeypatch.setattr(cache, "_connect", unavailable_connection)
    monkeypatch.setattr(discovery, "_snapshot_cache", cache)
    discovery.reset_recent_session_index()

    assert [path for _, path in recent_session_files([root])] == [fixture]
    assert parse_codex_jsonl(fixture).session_id == "keep"


def test_discovery_cache_requests_private_filesystem_permissions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / ".codex" / "sessions"
    fixture = root / "keep.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text('{"type":"session","id":"keep","cwd":"E:/work"}\n', encoding="utf-8")
    cache_path = tmp_path / "runtime" / "discovery-cache.sqlite3"
    chmod_calls: list[tuple[Path, int]] = []
    original_chmod = os.chmod

    def tracked_chmod(path: str | os.PathLike[str], mode: int) -> None:
        chmod_calls.append((Path(path), mode))
        original_chmod(path, mode)

    monkeypatch.setenv("AGENTHUB_DISCOVERY_SNAPSHOT_DB", str(cache_path))
    monkeypatch.setattr(discovery.os, "chmod", tracked_chmod)
    discovery.reset_discovery_snapshot_cache()
    discovery.reset_recent_session_index()

    recent_session_files([root])

    assert (cache_path.parent, 0o700) in chmod_calls
    assert (cache_path, 0o600) in chmod_calls


def test_discovery_cache_applies_windows_acl_instead_of_relying_on_chmod(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache_path = tmp_path / "runtime" / "discovery-cache.sqlite3"
    cache_path.parent.mkdir(parents=True)
    cache_path.write_bytes(b"")
    commands: list[list[str]] = []
    environments: list[dict[str, str]] = []

    def completed(command: list[str], **kwargs):
        commands.append(command)
        if command[0] == "whoami":
            return subprocess.CompletedProcess(command, 0, stdout="DESKTOP\\agenthub-user\n", stderr="")
        environments.append(kwargs["env"])
        return subprocess.CompletedProcess(command, 0, stdout="processed", stderr="")

    monkeypatch.setattr(discovery, "WINDOWS_ACL_REQUIRED", True)
    monkeypatch.setattr(discovery.subprocess, "run", completed)

    cache = discovery._SnapshotCache(cache_path)
    cache._secure_cache_files()

    acl_commands = [command for command in commands if command[0].lower().startswith("powershell")]
    assert any(environment["AGENTHUB_DISCOVERY_ACL_PATH"] == str(cache_path.parent) for environment in environments)
    assert any(environment["AGENTHUB_DISCOVERY_ACL_PATH"] == str(cache_path) for environment in environments)
    assert all("SetAccessRuleProtection" in " ".join(command) for command in acl_commands)
    assert all("SetAccessControl" in " ".join(command) for command in acl_commands)
    assert all("unexpected ACL entry" in " ".join(command) for command in acl_commands)


def test_discovery_cache_treats_acl_timeout_as_cache_miss(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache_path = tmp_path / "runtime" / "discovery-cache.sqlite3"
    fixture = tmp_path / "session.jsonl"
    fixture.write_text('{"type":"session","id":"keep"}\n', encoding="utf-8")
    stat = fixture.stat()
    cache = discovery._SnapshotCache(cache_path)

    def timed_out() -> None:
        raise subprocess.TimeoutExpired("powershell", 10)

    monkeypatch.setattr(cache, "_secure_cache_files", timed_out)

    assert cache.load(fixture, "codex", stat) is None


def test_discovery_cache_closes_connection_when_post_open_acl_check_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = discovery._SnapshotCache(tmp_path / "runtime" / "discovery-cache.sqlite3")
    closed = False
    secure_calls = 0

    class FakeConnection:
        def execute(self, *_args, **_kwargs):
            return self

        def fetchone(self):
            return None

        def close(self) -> None:
            nonlocal closed
            closed = True

    def secure() -> None:
        nonlocal secure_calls
        secure_calls += 1
        if secure_calls == 2:
            raise subprocess.TimeoutExpired("powershell", 10)

    monkeypatch.setattr(cache, "_open_connection", lambda _path: FakeConnection())
    monkeypatch.setattr(cache, "_ensure_schema", lambda _connection: None)
    monkeypatch.setattr(cache, "_secure_cache_files", secure)

    with pytest.raises(subprocess.TimeoutExpired):
        cache._connect()

    assert closed is True


def test_discovery_cache_closes_recovery_connection_when_schema_rebuild_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = discovery._SnapshotCache(tmp_path / "runtime" / "discovery-cache.sqlite3")

    class FakeConnection:
        def __init__(self, *, corrupt: bool) -> None:
            self.corrupt = corrupt
            self.closed = False

        def execute(self, *_args, **_kwargs):
            if self.corrupt:
                raise sqlite3.DatabaseError("file is not a database")
            return self

        def fetchone(self):
            return None

        def close(self) -> None:
            self.closed = True

    corrupt_connection = FakeConnection(corrupt=True)
    recovery_connection = FakeConnection(corrupt=False)
    connections = iter((corrupt_connection, recovery_connection))

    def fail_recovery_schema(connection: FakeConnection) -> None:
        if connection is recovery_connection:
            raise RuntimeError("schema rebuild failed")

    monkeypatch.setattr(cache, "_open_connection", lambda _path: next(connections))
    monkeypatch.setattr(cache, "_ensure_schema", fail_recovery_schema)
    monkeypatch.setattr(cache, "_secure_cache_files", lambda: None)

    with pytest.raises(RuntimeError, match="schema rebuild failed"):
        cache._connect()

    assert corrupt_connection.closed is True
    assert recovery_connection.closed is True


def test_recent_session_files_never_runs_periodic_full_walk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / ".codex" / "sessions"
    fixture = root / "2026" / "07" / "21" / "keep.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text('{"type":"session","id":"keep","cwd":"E:/work"}\n', encoding="utf-8")
    times = iter((100.0, 200.0))

    def controlled_probe(probe_root: Path, _limit: int):
        assert probe_root == root
        yield fixture

    def fail_if_walked(*args, **kwargs):
        raise AssertionError("normal discovery polling must not recurse through the complete history tree")

    monkeypatch.setattr(discovery, "_probe_recent_jsonl_paths", controlled_probe)
    monkeypatch.setattr(discovery.os, "walk", fail_if_walked)
    monkeypatch.setattr(discovery.time, "time", lambda: next(times))
    monkeypatch.setenv("AGENTHUB_DISCOVERY_RECONCILE_SECONDS", "1")
    discovery.reset_recent_session_index()

    assert [path for _, path in recent_session_files([root])] == [fixture]
    assert [path for _, path in recent_session_files([root])] == [fixture]


def test_bounded_fallback_probe_eventually_advances_through_large_flat_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "sessions"
    root.mkdir()
    fixtures = [root / f"session-{index}.jsonl" for index in range(3)]
    for index, fixture in enumerate(fixtures):
        fixture.write_text(f'{{"id":"session-{index}"}}\n', encoding="utf-8")
        os.utime(fixture, (100 + index, 100 + index))

    monkeypatch.setattr(discovery, "_probe_entry_budget", lambda _limit: 2)
    discovery.reset_recent_session_index()

    discovered: set[Path] = set()
    for _ in range(3):
        discovered.update(discovery._bounded_direct_jsonl_paths(root, 2))

    assert discovered == set(fixtures)


def test_bounded_fallback_probe_evicts_idle_directory_handles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_root.mkdir()
    second_root.mkdir()
    for index in range(3):
        (first_root / f"first-{index}.jsonl").write_text("{}\n", encoding="utf-8")
        (second_root / f"second-{index}.jsonl").write_text("{}\n", encoding="utf-8")

    now = 100.0
    monkeypatch.setattr(discovery, "_probe_entry_budget", lambda _limit: 1)
    monkeypatch.setattr(discovery.time, "time", lambda: now)
    discovery.reset_recent_session_index()

    discovery._bounded_direct_jsonl_paths(first_root, 1)
    assert str(first_root) in discovery._direct_probe_iterators

    now += discovery.DEFAULT_DISCOVERY_CURSOR_TTL_SECONDS + 1
    discovery._bounded_direct_jsonl_paths(second_root, 1)

    assert str(first_root) not in discovery._direct_probe_iterators


def test_bounded_fallback_probe_reopens_expired_handle_for_same_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "sessions"
    root.mkdir()
    for index in range(3):
        (root / f"session-{index}.jsonl").write_text("{}\n", encoding="utf-8")

    now = 100.0
    monkeypatch.setattr(discovery, "_probe_entry_budget", lambda _limit: 1)
    monkeypatch.setattr(discovery.time, "time", lambda: now)
    discovery.reset_recent_session_index()

    discovery._bounded_direct_jsonl_paths(root, 1)
    first_iterator = discovery._direct_probe_iterators[str(root)].iterator

    now += discovery.DEFAULT_DISCOVERY_CURSOR_TTL_SECONDS + 1
    discovery._bounded_direct_jsonl_paths(root, 1)

    assert discovery._direct_probe_iterators[str(root)].iterator is not first_iterator


def test_bounded_fallback_probe_does_not_discard_matches_beyond_return_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "sessions"
    root.mkdir()
    fixtures = [root / f"session-{index}.jsonl" for index in range(4)]
    for fixture in fixtures:
        fixture.write_text("{}\n", encoding="utf-8")

    monkeypatch.setattr(discovery, "_probe_entry_budget", lambda _limit: 4)
    discovery.reset_recent_session_index()

    discovered: set[Path] = set()
    for _ in range(5):
        discovered.update(discovery._bounded_direct_jsonl_paths(root, 1))

    assert discovered == set(fixtures)


def test_bounded_fallback_probe_returns_newest_from_batch_and_keeps_overflow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "sessions"
    root.mkdir()
    fixtures = [root / f"session-{index}.jsonl" for index in range(3)]
    for index, fixture in enumerate(fixtures):
        fixture.write_text("{}\n", encoding="utf-8")
        os.utime(fixture, (100 + index, 100 + index))

    monkeypatch.setattr(discovery, "_probe_entry_budget", lambda _limit: 3)
    discovery.reset_recent_session_index()

    assert discovery._bounded_direct_jsonl_paths(root, 2) == [fixtures[2], fixtures[1]]
    assert discovery._bounded_direct_jsonl_paths(root, 2) == [fixtures[0]]


def test_kimi_fallback_eventually_advances_across_registry_and_nested_sessions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    kimi_home = tmp_path / ".kimi"
    sessions_root = kimi_home / "sessions"
    registry_items: list[dict[str, str]] = []
    expected: set[Path] = set()
    for index in range(4):
        workspace = f"E:/Work/Kimi-{index}"
        session_id = f"session-{index}"
        registry_items.append({"path": workspace, "last_session_id": session_id})
        session_file = sessions_root / hashlib.md5(workspace.encode()).hexdigest() / session_id / "wire.jsonl"
        session_file.parent.mkdir(parents=True)
        session_file.write_text("{}\n", encoding="utf-8")
        expected.add(session_file)
    (kimi_home / "kimi.json").write_text(json.dumps({"work_dirs": registry_items}), encoding="utf-8")

    monkeypatch.setattr(discovery, "_probe_entry_budget", lambda _limit: 2)
    discovery.reset_recent_session_index()

    discovered: set[Path] = set()
    for _ in range(6):
        discovered.update(discovery._probe_kimi_recent_paths(sessions_root, 1))

    assert discovered == expected


def test_rebuild_recent_session_index_imports_historical_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / ".codex" / "sessions"
    fixture = root / "2020" / "01" / "01" / "historical.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text('{"type":"session","id":"historical","cwd":"E:/work"}\n', encoding="utf-8")
    cache_path = tmp_path / "runtime" / "discovery-cache.sqlite3"

    monkeypatch.setenv("AGENTHUB_DISCOVERY_SNAPSHOT_DB", str(cache_path))
    discovery.reset_discovery_snapshot_cache()
    discovery.reset_recent_session_index()

    result = discovery.rebuild_recent_session_index([root])

    assert result["files"] == 1
    assert result["backends"] == {"codex": 1}
    discovery.reset_recent_session_index()
    assert [path for _, path in recent_session_files([root])] == [fixture]


def test_rebuild_recent_session_index_caps_persisted_paths_per_backend(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / ".codex" / "sessions"
    fixtures: list[Path] = []
    for index in range(3):
        fixture = root / "2020" / "01" / f"0{index + 1}" / f"session-{index}.jsonl"
        fixture.parent.mkdir(parents=True)
        fixture.write_text(f'{{"type":"session","id":"session-{index}","cwd":"E:/work"}}\n', encoding="utf-8")
        os.utime(fixture, (100 + index, 100 + index))
        fixtures.append(fixture)
    cache_path = tmp_path / "runtime" / "discovery-cache.sqlite3"

    monkeypatch.setenv("AGENTHUB_DISCOVERY_SNAPSHOT_DB", str(cache_path))
    monkeypatch.setenv("AGENTHUB_DISCOVERY_MAX_FILES", "2")
    discovery.reset_discovery_snapshot_cache()
    discovery.reset_recent_session_index()

    result = discovery.rebuild_recent_session_index([root])

    assert result["files"] == 2
    discovery.reset_recent_session_index()
    assert [path for _, path in recent_session_files([root])] == [fixtures[2], fixtures[1]]


def test_rebuild_migrates_legacy_index_and_allows_overlapping_roots(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    aggregate_root = tmp_path / "home"
    root = aggregate_root / ".codex" / "sessions"
    fixture = root / "2020" / "01" / "01" / "historical.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text('{"type":"session","id":"historical","cwd":"E:/work"}\n', encoding="utf-8")
    cache_path = tmp_path / "runtime" / "discovery-cache.sqlite3"
    cache_path.parent.mkdir(parents=True)
    with sqlite3.connect(cache_path) as connection:
        connection.execute(
            """
            CREATE TABLE session_file_index (
                root TEXT NOT NULL,
                path TEXT PRIMARY KEY,
                backend TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime REAL NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )

    monkeypatch.setenv("AGENTHUB_DISCOVERY_SNAPSHOT_DB", str(cache_path))
    monkeypatch.setattr(discovery, "_snapshot_cache", None)
    discovery.reset_recent_session_index()

    discovery.rebuild_recent_session_index([aggregate_root, root])

    with sqlite3.connect(cache_path) as connection:
        primary_key = [
            row[1]
            for row in connection.execute("PRAGMA table_info(session_file_index)")
            if row[5]
        ]
        rows = connection.execute("SELECT root, path FROM session_file_index").fetchall()
    assert primary_key == ["root", "path"]
    assert len(rows) == 2


def test_snapshot_cache_prunes_sessions_evicted_from_file_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / ".codex" / "sessions"
    fixtures: list[Path] = []
    for index in range(3):
        fixture = root / "2020" / "01" / f"0{index + 1}" / f"session-{index}.jsonl"
        fixture.parent.mkdir(parents=True)
        fixture.write_text(
            f'{{"type":"session","id":"session-{index}","cwd":"E:/work"}}\n',
            encoding="utf-8",
        )
        os.utime(fixture, (100 + index, 100 + index))
        fixtures.append(fixture)
    cache_path = tmp_path / "runtime" / "discovery-cache.sqlite3"

    monkeypatch.setenv("AGENTHUB_DISCOVERY_SNAPSHOT_DB", str(cache_path))
    monkeypatch.setenv("AGENTHUB_DISCOVERY_MAX_FILES", "2")
    discovery.reset_discovery_snapshot_cache()
    for fixture in fixtures:
        parse_codex_jsonl(fixture)
    discovery.reset_recent_session_index()

    discovery.rebuild_recent_session_index([root])

    with sqlite3.connect(cache_path) as connection:
        cached_paths = {
            row[0]
            for row in connection.execute("SELECT path FROM session_snapshot_cache").fetchall()
        }
    assert cached_paths == {str(fixtures[1]), str(fixtures[2])}


def test_aggregate_root_preserves_recent_quota_for_each_provider(tmp_path: Path) -> None:
    root = tmp_path / "home"
    codex = root / ".codex" / "sessions" / "codex.jsonl"
    claude = root / ".claude" / "projects" / "claude.jsonl"
    kimi_home = root / ".kimi"
    kimi_root = kimi_home / "sessions"
    workspace = "E:/Work/Kimi"
    workdir_hash = hashlib.md5(workspace.encode()).hexdigest()
    kimi = kimi_root / workdir_hash / "kimi-active" / "wire.jsonl"
    for fixture in (codex, claude, kimi):
        fixture.parent.mkdir(parents=True, exist_ok=True)
    codex.write_text('{"type":"session","id":"codex","cwd":"E:/work"}\n', encoding="utf-8")
    claude.write_text(
        '{"sessionId":"claude","cwd":"E:/work","type":"summary","summary":"Claude"}\n',
        encoding="utf-8",
    )
    kimi.write_text(
        '{"timestamp":"2026-07-21T12:01:00Z","message":{"type":"ContentPart","payload":{"type":"text","text":"Kimi"}}}\n',
        encoding="utf-8",
    )
    (kimi_home / "kimi.json").write_text(
        json.dumps({"work_dirs": [{"path": workspace, "last_session_id": "kimi-active"}]}),
        encoding="utf-8",
    )

    discovery.reset_recent_session_index()

    assert {backend for backend, _ in recent_session_files([root], max_files=1)} == {
        "codex",
        "claude",
        "kimi",
    }


def test_kimi_probe_replaces_context_with_wire_for_same_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / ".kimi" / "sessions"
    session_dir = root / "workdir" / "kimi-session"
    session_dir.mkdir(parents=True)
    context_path = session_dir / "context.jsonl"
    wire_path = session_dir / "wire.jsonl"
    context_path.write_text('{"role":"user","content":"context"}\n', encoding="utf-8")
    probed = [context_path]

    monkeypatch.setattr(discovery, "_probe_recent_jsonl_paths", lambda _root, _limit: iter(probed))
    discovery.reset_recent_session_index()
    assert [path for _, path in recent_session_files([root])] == [context_path]

    wire_path.write_text(
        '{"timestamp":"2026-07-21T12:01:00Z","message":{"type":"ContentPart","payload":{"type":"text","text":"wire"}}}\n',
        encoding="utf-8",
    )
    probed[:] = [wire_path]

    assert [path for _, path in recent_session_files([root])] == [wire_path]


def test_codex_parser_uses_cached_snapshot_when_file_is_unchanged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = tmp_path / ".codex" / "sessions" / "2026" / "07" / "21" / "rollout-2026-07-21T10-00-00-cache-test.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text(
        '{"timestamp":"2026-07-21T10:00:00.000Z","type":"session_meta","payload":{"id":"cache-test","cwd":"E:\\\\work"}}\n'
        '{"timestamp":"2026-07-21T10:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"第一次"}}\n'
        '{"timestamp":"2026-07-21T10:02:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"第一次回复"}]}}\n',
        encoding="utf-8",
    )

    discovery.reset_discovery_snapshot_cache()
    first = parse_codex_jsonl(fixture)
    assert first.last_message == "第一次回复"

    def fail_if_reparsed(*args, **kwargs):
        raise AssertionError("unchanged file should have been served from cache")

    monkeypatch.setattr(discovery, "_bounded_jsonl_rows", fail_if_reparsed)

    second = parse_codex_jsonl(fixture)
    assert second.last_message == "第一次回复"
    assert second.session_id == "cache-test"


def test_snapshot_cache_is_invalidated_when_parser_version_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture = tmp_path / ".codex" / "sessions" / "rollout-2026-07-21T10-00-00-version-test.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text(
        '{"timestamp":"2026-07-21T10:00:00.000Z","type":"session_meta","payload":{"id":"version-test","cwd":"E:\\\\work"}}\n',
        encoding="utf-8",
    )
    discovery.reset_discovery_snapshot_cache()
    parse_codex_jsonl(fixture)
    monkeypatch.setattr(discovery, "DISCOVERY_CACHE_VERSION", discovery.DISCOVERY_CACHE_VERSION + 1)

    reparsed = False
    original = discovery._bounded_jsonl_rows

    def track_reparse(path: Path):
        nonlocal reparsed
        reparsed = True
        return original(path)

    monkeypatch.setattr(discovery, "_bounded_jsonl_rows", track_reparse)

    parse_codex_jsonl(fixture)

    assert reparsed is True


def test_codex_parser_refreshes_cached_snapshot_after_append(tmp_path: Path) -> None:
    fixture = tmp_path / ".codex" / "sessions" / "2026" / "07" / "21" / "rollout-2026-07-21T11-00-00-append-test.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text(
        '{"timestamp":"2026-07-21T11:00:00.000Z","type":"session_meta","payload":{"id":"append-test","cwd":"E:\\\\work"}}\n'
        '{"timestamp":"2026-07-21T11:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"先看这里"}}\n',
        encoding="utf-8",
    )

    discovery.reset_discovery_snapshot_cache()
    initial = parse_codex_jsonl(fixture)
    assert initial.last_message == "先看这里"

    with fixture.open("a", encoding="utf-8") as handle:
        handle.write(
            '{"timestamp":"2026-07-21T11:02:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"后续已经追加"}]}}\n'
        )
    os.utime(fixture, None)

    updated = parse_codex_jsonl(fixture)
    assert updated.last_message == "后续已经追加"
    assert updated.runtime_metadata["timeline"][-1]["text"] == "后续已经追加"


def test_codex_parser_rebuilds_snapshot_after_truncate(tmp_path: Path) -> None:
    fixture = tmp_path / ".codex" / "sessions" / "2026" / "07" / "21" / "rollout-2026-07-21T12-00-00-truncate-test.jsonl"
    fixture.parent.mkdir(parents=True)
    fixture.write_text(
        '{"timestamp":"2026-07-21T12:00:00.000Z","type":"session_meta","payload":{"id":"truncate-test","cwd":"E:\\\\work"}}\n'
        '{"timestamp":"2026-07-21T12:01:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"旧回复"}]}}\n',
        encoding="utf-8",
    )

    discovery.reset_discovery_snapshot_cache()
    initial = parse_codex_jsonl(fixture)
    assert initial.last_message == "旧回复"

    fixture.write_text(
        '{"timestamp":"2026-07-21T12:05:00.000Z","type":"session_meta","payload":{"id":"truncate-test","cwd":"E:\\\\work"}}\n'
        '{"timestamp":"2026-07-21T12:06:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"新会话"}}\n'
        '{"timestamp":"2026-07-21T12:07:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"新回复"}]}}\n',
        encoding="utf-8",
    )
    os.utime(fixture, None)

    rebuilt = parse_codex_jsonl(fixture)
    assert rebuilt.last_message == "新回复"
    timeline_texts = [item["text"] for item in rebuilt.runtime_metadata["timeline"]]
    assert "旧回复" not in timeline_texts
    assert timeline_texts[-1] == "新回复"


def test_kimi_parser_uses_bounded_reads_for_large_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session_dir = tmp_path / ".kimi" / "sessions" / "workdir" / "kimi-large"
    session_dir.mkdir(parents=True)
    wire_path = session_dir / "wire.jsonl"
    wire_path.write_text(
        '{"timestamp":"2026-07-21T12:00:00Z","message":{"type":"TurnBegin","payload":{"user_input":"开始"}}}\n'
        + ('{"padding":"' + ("x" * 1_000_000) + '"}\n')
        + '{"timestamp":"2026-07-21T12:01:00Z","message":{"type":"ContentPart","payload":{"type":"text","text":"完成"}}}\n',
        encoding="utf-8",
    )

    def fail_if_read_whole(*args, **kwargs):
        raise AssertionError("large Kimi history must not be read in full")

    monkeypatch.setattr(discovery, "_read_jsonl", fail_if_read_whole)

    session = parse_kimi_session(session_dir)

    assert session.last_message == "完成"


def test_kimi_parser_uses_cached_snapshot_when_files_are_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session_dir = tmp_path / ".kimi" / "sessions" / "workdir" / "kimi-cache"
    session_dir.mkdir(parents=True)
    wire_path = session_dir / "wire.jsonl"
    wire_path.write_text(
        '{"timestamp":"2026-07-21T12:01:00Z","message":{"type":"ContentPart","payload":{"type":"text","text":"cached"}}}\n',
        encoding="utf-8",
    )
    discovery.reset_discovery_snapshot_cache()
    first = parse_kimi_session(session_dir)

    def fail_if_reparsed(*args, **kwargs):
        raise AssertionError("unchanged Kimi session should have been served from cache")

    monkeypatch.setattr(discovery, "_bounded_jsonl_rows", fail_if_reparsed)

    second = parse_kimi_session(session_dir)

    assert first.last_message == second.last_message == "cached"


def test_kimi_snapshot_survives_file_index_rebuild(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / ".kimi" / "sessions"
    session_dir = root / "workdir" / "kimi-cache"
    session_dir.mkdir(parents=True)
    wire_path = session_dir / "wire.jsonl"
    wire_path.write_text(
        '{"timestamp":"2026-07-21T12:01:00Z","message":{"type":"ContentPart","payload":{"type":"text","text":"cached"}}}\n',
        encoding="utf-8",
    )
    cache_path = tmp_path / "runtime" / "discovery-cache.sqlite3"
    monkeypatch.setenv("AGENTHUB_DISCOVERY_SNAPSHOT_DB", str(cache_path))
    discovery.reset_discovery_snapshot_cache()
    discovery.reset_recent_session_index()

    first = parse_kimi_session(session_dir)
    discovery.rebuild_recent_session_index([root])

    def fail_if_reparsed(*args, **kwargs):
        raise AssertionError("indexed Kimi session should retain its cached snapshot")

    monkeypatch.setattr(discovery, "_bounded_jsonl_rows", fail_if_reparsed)

    second = parse_kimi_session(session_dir)

    assert first.last_message == second.last_message == "cached"


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


def test_codex_cached_running_status_expires_without_file_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = datetime(2026, 7, 22, 8, 0, tzinfo=timezone.utc)

    class ControlledDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            value = current
            return value.astimezone(tz) if tz is not None else value.replace(tzinfo=None)

    fixture = tmp_path / "rollout-2026-07-22T08-00-00-running-cache.jsonl"
    fixture.write_text(
        '{"timestamp":"2026-07-22T07:59:00.000Z","type":"session_meta","payload":{"id":"running-cache","cwd":"E:\\\\work\\\\AgentHub"}}\n'
        '{"timestamp":"2026-07-22T07:59:30.000Z","type":"event_msg","payload":{"type":"user_message","message":"跑测试"}}\n'
        '{"timestamp":"2026-07-22T07:59:45.000Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"pytest\\"}"}}\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(discovery, "datetime", ControlledDatetime)
    monkeypatch.setenv("AGENTHUB_DISCOVERY_RUNNING_STALE_SECONDS", "60")
    discovery.reset_discovery_snapshot_cache()

    first = parse_codex_jsonl(fixture)
    assert first.status == "running"

    current = current + timedelta(minutes=2)
    second = parse_codex_jsonl(fixture)

    assert second.status == "ready"


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


def test_recent_session_limit_does_not_allow_one_backend_to_starve_another(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AGENTHUB_DISCOVERY_MAX_FILES", "2")
    codex_root = tmp_path / ".codex" / "sessions"
    claude_root = tmp_path / ".claude" / "projects"
    codex_root.mkdir(parents=True)
    claude_root.mkdir(parents=True)

    for index, session_id in enumerate(["codex-old", "codex-new", "codex-newest"], start=1):
        fixture = codex_root / f"{session_id}.jsonl"
        fixture.write_text(
            f'{{"type":"session","id":"{session_id}","cwd":"E:\\\\work","title":"{session_id}"}}\n',
            encoding="utf-8",
        )
        os.utime(fixture, (1_700_000_100 + index, 1_700_000_100 + index))

    claude_fixture = claude_root / "claude-latest.jsonl"
    claude_fixture.write_text(
        '{"sessionId":"claude-latest","cwd":"E:\\\\work","type":"summary","summary":"Claude latest"}\n',
        encoding="utf-8",
    )
    os.utime(claude_fixture, (1_700_000_000, 1_700_000_000))

    sessions = discover_windows_sessions([codex_root, claude_root])

    assert [session["session_id"] for session in sessions] == ["codex-newest", "codex-new", "claude-latest"]


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
