from __future__ import annotations

import json
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_THREAD_SOURCE = "user"
DEFAULT_ORIGINATOR = "Codex Desktop"


@dataclass
class CodexMaintenanceResult:
    backup_dir: str | None
    selected_count: int
    updated_count: int
    updated_thread_ids: list[str]
    dry_run: bool
    target_cwd: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "backup_dir": self.backup_dir,
            "selected_count": self.selected_count,
            "updated_count": self.updated_count,
            "updated_thread_ids": self.updated_thread_ids,
            "dry_run": self.dry_run,
            "target_cwd": self.target_cwd,
        }


def default_codex_home(home: str | Path | None = None) -> Path:
    if home is not None:
        return Path(home)
    return Path.home() / ".codex"


def promote_exec_sessions_for_desktop(
    *,
    target_cwd: str,
    codex_home: str | Path | None = None,
    source_cwd_prefix: str | None = None,
    thread_ids: list[str] | None = None,
    all_exec: bool = False,
    dry_run: bool = False,
) -> CodexMaintenanceResult:
    normalized_target_cwd = _require_value(target_cwd, "target_cwd")
    normalized_prefix = _normalize_optional(source_cwd_prefix)
    selected_thread_ids = [value.strip() for value in (thread_ids or []) if value and value.strip()]
    if not (all_exec or normalized_prefix or selected_thread_ids):
        raise ValueError("Select exec sessions with --all-exec, --source-cwd-prefix, or --thread-id")

    codex_root = default_codex_home(codex_home)
    db_path = codex_root / "state_5.sqlite"
    if not db_path.exists():
        raise FileNotFoundError(f"Codex state database not found: {db_path}")

    rows = _selected_exec_rows(
        db_path=db_path,
        source_cwd_prefix=normalized_prefix,
        thread_ids=selected_thread_ids,
        all_exec=all_exec,
    )
    if not rows:
        return CodexMaintenanceResult(
            backup_dir=None,
            selected_count=0,
            updated_count=0,
            updated_thread_ids=[],
            dry_run=dry_run,
            target_cwd=normalized_target_cwd,
        )

    backup_dir = None if dry_run else _backup_codex_state(codex_root, rows)
    if dry_run:
        return CodexMaintenanceResult(
            backup_dir=None,
            selected_count=len(rows),
            updated_count=0,
            updated_thread_ids=[str(row["id"]) for row in rows],
            dry_run=True,
            target_cwd=normalized_target_cwd,
        )

    _update_exec_rows(db_path, rows, normalized_target_cwd)
    for row in rows:
        _patch_rollout_file(
            Path(str(row["rollout_path"])),
            thread_id=str(row["id"]),
            target_cwd=normalized_target_cwd,
        )
    return CodexMaintenanceResult(
        backup_dir=str(backup_dir),
        selected_count=len(rows),
        updated_count=len(rows),
        updated_thread_ids=[str(row["id"]) for row in rows],
        dry_run=False,
        target_cwd=normalized_target_cwd,
    )


def _require_value(value: str, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field_name} cannot be empty")
    return normalized


def _normalize_optional(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def _selected_exec_rows(
    *,
    db_path: Path,
    source_cwd_prefix: str | None,
    thread_ids: list[str],
    all_exec: bool,
) -> list[sqlite3.Row]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = list(
            conn.execute(
                """
                select id, rollout_path, cwd, source, coalesce(thread_source, '') as thread_source
                from threads
                where source = 'exec'
                order by updated_at desc, id desc
                """
            )
        )
    finally:
        conn.close()
    if all_exec:
        return rows
    thread_id_set = {value.casefold() for value in thread_ids}
    prefix_key = source_cwd_prefix.casefold() if source_cwd_prefix else None
    selected: list[sqlite3.Row] = []
    for row in rows:
        row_id = str(row["id"])
        row_cwd = str(row["cwd"] or "")
        if row_id.casefold() in thread_id_set:
            selected.append(row)
            continue
        if prefix_key and row_cwd.casefold().startswith(prefix_key):
            selected.append(row)
    return selected


def _backup_codex_state(codex_root: Path, rows: list[sqlite3.Row]) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup_dir = codex_root / "maintenance-backups" / f"promote-exec-{stamp}"
    backup_dir.mkdir(parents=True, exist_ok=True)
    db_path = codex_root / "state_5.sqlite"
    for path in (db_path, db_path.with_name("state_5.sqlite-wal"), db_path.with_name("state_5.sqlite-shm")):
        if path.exists():
            shutil.copy2(path, backup_dir / path.name)
    rollout_dir = backup_dir / "rollouts"
    rollout_dir.mkdir(parents=True, exist_ok=True)
    for row in rows:
        rollout_path = Path(str(row["rollout_path"]))
        if rollout_path.exists():
            shutil.copy2(rollout_path, rollout_dir / rollout_path.name)
    return backup_dir


def _update_exec_rows(db_path: Path, rows: list[sqlite3.Row], target_cwd: str) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("begin immediate")
        for row in rows:
            conn.execute(
                """
                update threads
                set cwd = ?, source = 'cli', thread_source = ?, archived = 0
                where id = ?
                """,
                (target_cwd, DEFAULT_THREAD_SOURCE, str(row["id"])),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _patch_rollout_file(rollout_path: Path, *, thread_id: str, target_cwd: str) -> None:
    if not rollout_path.exists():
        return
    updated = False
    output_lines: list[str] = []
    with rollout_path.open("r", encoding="utf-8", errors="replace") as handle:
        for raw_line in handle:
            line = raw_line.rstrip("\n")
            if not updated:
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    output_lines.append(raw_line)
                    continue
                if _patch_rollout_meta(payload, thread_id=thread_id, target_cwd=target_cwd):
                    output_lines.append(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
                    updated = True
                    continue
            output_lines.append(raw_line)
    if updated:
        rollout_path.write_text("".join(output_lines), encoding="utf-8")


def _patch_rollout_meta(payload: dict[str, Any], *, thread_id: str, target_cwd: str) -> bool:
    if payload.get("type") != "session_meta":
        return False
    body = payload.get("payload")
    if not isinstance(body, dict):
        return False
    if str(body.get("id") or "").strip() != thread_id:
        return False
    body["cwd"] = target_cwd
    body["source"] = "cli"
    body["thread_source"] = DEFAULT_THREAD_SOURCE
    body["originator"] = str(body.get("originator") or DEFAULT_ORIGINATOR)
    return True
