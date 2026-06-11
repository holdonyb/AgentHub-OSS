from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from agenthub_worker.codex_maintenance import promote_exec_sessions_for_desktop


def _init_codex_state(tmp_path: Path) -> tuple[Path, Path]:
    codex_root = tmp_path / ".codex"
    sessions_dir = codex_root / "sessions" / "2026" / "06" / "06"
    sessions_dir.mkdir(parents=True)
    db_path = codex_root / "state_5.sqlite"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        create table threads (
            id text primary key,
            rollout_path text not null,
            updated_at integer not null,
            source text not null,
            cwd text not null,
            thread_source text,
            archived integer not null default 0
        )
        """
    )
    conn.commit()
    conn.close()
    return codex_root, db_path


def _write_rollout(path: Path, thread_id: str, cwd: str, source: str = "exec") -> None:
    path.write_text(
        json.dumps(
            {
                "timestamp": "2026-06-06T00:00:06.706Z",
                "type": "session_meta",
                "payload": {
                    "id": thread_id,
                    "cwd": cwd,
                    "originator": "codex_exec",
                    "source": source,
                    "thread_source": "user",
                },
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )


def test_promote_exec_sessions_updates_db_and_rollout_and_creates_backup(tmp_path: Path) -> None:
    codex_root, db_path = _init_codex_state(tmp_path)
    rollout_path = codex_root / "sessions" / "2026" / "06" / "06" / "rollout-1.jsonl"
    _write_rollout(rollout_path, thread_id="thread-1", cwd="E:\\Work")
    conn = sqlite3.connect(db_path)
    conn.execute(
        "insert into threads(id, rollout_path, updated_at, source, cwd, thread_source, archived) values (?, ?, ?, ?, ?, ?, ?)",
        ("thread-1", str(rollout_path), 1, "exec", "E:\\Work", "", 1),
    )
    conn.commit()
    conn.close()

    result = promote_exec_sessions_for_desktop(
        target_cwd=r"\\?\E:\Work\AgentHub",
        codex_home=codex_root,
        source_cwd_prefix="E:\\Work",
    )

    assert result.updated_count == 1
    assert result.backup_dir is not None
    backup_dir = Path(result.backup_dir)
    assert (backup_dir / "state_5.sqlite").exists()
    assert (backup_dir / "rollouts" / rollout_path.name).exists()

    conn = sqlite3.connect(db_path)
    row = conn.execute("select cwd, source, thread_source, archived from threads where id = 'thread-1'").fetchone()
    conn.close()
    assert row == (r"\\?\E:\Work\AgentHub", "cli", "user", 0)

    payload = json.loads(rollout_path.read_text(encoding="utf-8").splitlines()[0])
    assert payload["payload"]["cwd"] == r"\\?\E:\Work\AgentHub"
    assert payload["payload"]["source"] == "cli"
    assert payload["payload"]["originator"] == "codex_exec"


def test_promote_exec_sessions_dry_run_only_reports_matches(tmp_path: Path) -> None:
    codex_root, db_path = _init_codex_state(tmp_path)
    rollout_path = codex_root / "sessions" / "2026" / "06" / "06" / "rollout-2.jsonl"
    _write_rollout(rollout_path, thread_id="thread-2", cwd="E:\\Work")
    conn = sqlite3.connect(db_path)
    conn.execute(
        "insert into threads(id, rollout_path, updated_at, source, cwd, thread_source, archived) values (?, ?, ?, ?, ?, ?, ?)",
        ("thread-2", str(rollout_path), 2, "exec", "E:\\Work", "", 0),
    )
    conn.commit()
    conn.close()

    result = promote_exec_sessions_for_desktop(
        target_cwd="E:\\Work\\AgentHub",
        codex_home=codex_root,
        thread_ids=["thread-2"],
        dry_run=True,
    )

    assert result.selected_count == 1
    assert result.updated_count == 0
    assert result.backup_dir is None

    conn = sqlite3.connect(db_path)
    row = conn.execute("select cwd, source from threads where id = 'thread-2'").fetchone()
    conn.close()
    assert row == ("E:\\Work", "exec")
    payload = json.loads(rollout_path.read_text(encoding="utf-8").splitlines()[0])
    assert payload["payload"]["source"] == "exec"


def test_promote_exec_sessions_requires_selector(tmp_path: Path) -> None:
    codex_root, _ = _init_codex_state(tmp_path)

    with pytest.raises(ValueError, match="Select exec sessions"):
        promote_exec_sessions_for_desktop(target_cwd="E:\\Work", codex_home=codex_root)
