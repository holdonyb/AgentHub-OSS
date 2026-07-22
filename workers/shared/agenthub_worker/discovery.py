from __future__ import annotations

import json
import os
import hashlib
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from agenthub_protocol.models import AgentTimelineItem, SessionSnapshot
from agenthub_worker.paths import infer_claude_workspace_root_from_runtime_ref, normalize_workspace_root, project_name_from_root


GENERIC_TITLES = {"codex session", "claude session", "kimi session", "opencode session", "session"}
DEFAULT_DISCOVERY_MAX_FILES = 80
DEFAULT_RUNNING_STALE_SECONDS = 1800
DEFAULT_DISCOVERY_HEAD_BYTES = 131_072
DEFAULT_DISCOVERY_TAIL_BYTES = 786_432
DEFAULT_DISCOVERY_CURSOR_TTL_SECONDS = 300
DISCOVERY_CACHE_VERSION = 2
WINDOWS_ACL_REQUIRED = os.name == "nt"
DISCOVERY_PRUNED_DIRS = {
    ".git",
    ".hg",
    ".mypy_cache",
    ".next",
    ".pnpm",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
}
ACK_TITLES = {
    "ok",
    "okay",
    "好",
    "好的",
    "可以",
    "行",
    "继续",
    "继续吧",
    "收到",
    "回复了",
}
CLAUDE_LOCAL_COMMAND_TAGS = (
    "<local-command-caveat>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<command-name>",
    "<command-message>",
    "<command-args>",
)
CODEX_ROLLOUT_SESSION_RE = re.compile(r"^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$")


@dataclass
class _SessionFileRecord:
    backend: str
    path: Path
    mtime: float
    size: int


@dataclass
class _RootScanState:
    root: Path
    records: dict[str, _SessionFileRecord] = field(default_factory=dict)
    last_full_scan_at: float = 0.0


@dataclass
class _CacheStat:
    st_size: int
    st_mtime: float
    st_mtime_ns: int


def _env_int(name: str, fallback: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(fallback))))
    except ValueError:
        return fallback


def _runtime_dir() -> Path:
    configured = os.getenv("AGENTHUB_DISCOVERY_RUNTIME_DIR", "").strip()
    if configured:
        return Path(configured)
    return Path.home() / ".agenthub"


def _snapshot_cache_path() -> Path:
    configured = os.getenv("AGENTHUB_DISCOVERY_SNAPSHOT_DB", "").strip()
    if configured:
        return Path(configured)
    return _runtime_dir() / "discovery-cache.sqlite3"


class _SnapshotCache:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._lock = threading.Lock()
        self._initialized = False
        self._acl_identity: str | None = None
        self._acl_secured_paths: set[str] = set()

    @staticmethod
    def _is_corruption_error(error: sqlite3.DatabaseError) -> bool:
        message = str(error).lower()
        return any(
            marker in message
            for marker in (
                "file is not a database",
                "database disk image is malformed",
                "malformed database schema",
                "unsupported file format",
            )
        )

    @staticmethod
    def _chmod_private(path: Path, mode: int) -> None:
        try:
            os.chmod(path, mode)
        except OSError:
            pass

    def _secure_cache_files(self) -> None:
        self._chmod_private(self._db_path.parent, 0o700)
        if WINDOWS_ACL_REQUIRED and self._db_path.parent.exists():
            self._apply_windows_private_acl(self._db_path.parent, directory=True)
        for path in (
            self._db_path,
            Path(f"{self._db_path}-wal"),
            Path(f"{self._db_path}-shm"),
        ):
            if path.exists():
                self._chmod_private(path, 0o600)
                if WINDOWS_ACL_REQUIRED:
                    self._apply_windows_private_acl(path, directory=False)

    def _windows_identity_name(self) -> str:
        if self._acl_identity is not None:
            return self._acl_identity
        completed = subprocess.run(
            ["whoami"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        identity = completed.stdout.strip()
        if completed.returncode != 0 or not identity:
            raise PermissionError("unable to resolve the Windows account for discovery cache ACLs")
        self._acl_identity = identity
        return identity

    def _apply_windows_private_acl(self, path: Path, *, directory: bool) -> None:
        key = str(path)
        if key in self._acl_secured_paths:
            return
        identity = self._windows_identity_name()
        script = r"""
$targetPath = $env:AGENTHUB_DISCOVERY_ACL_PATH
$identity = $env:AGENTHUB_DISCOVERY_ACL_IDENTITY
$isDirectory = $env:AGENTHUB_DISCOVERY_ACL_DIRECTORY -eq '1'
$acl = if ($isDirectory) {
    New-Object System.Security.AccessControl.DirectorySecurity
} else {
    New-Object System.Security.AccessControl.FileSecurity
}
$acl.SetAccessRuleProtection($true, $false)
$inheritance = if ($isDirectory) {
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
    [System.Security.AccessControl.InheritanceFlags]::None
}
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$principals = @($identity)
foreach ($principal in $principals) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $principal,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        $propagation,
        $allow
    )
    [void]$acl.AddAccessRule($rule)
}
$accessSections = [System.Security.AccessControl.AccessControlSections]::Access
if ($isDirectory) {
    [System.IO.Directory]::SetAccessControl($targetPath, $acl)
    $verifiedAcl = [System.IO.Directory]::GetAccessControl($targetPath, $accessSections)
} else {
    [System.IO.File]::SetAccessControl($targetPath, $acl)
    $verifiedAcl = [System.IO.File]::GetAccessControl($targetPath, $accessSections)
}
$allowedSids = @(
    (New-Object System.Security.Principal.NTAccount -ArgumentList $identity).Translate(
        [System.Security.Principal.SecurityIdentifier]
    ).Value
)
$actualSids = @()
foreach ($rule in $verifiedAcl.Access) {
    $sid = $rule.IdentityReference.Translate(
        [System.Security.Principal.SecurityIdentifier]
    ).Value
    $actualSids += $sid
    if ($rule.AccessControlType -ne $allow -or $sid -notin $allowedSids) {
        throw "unexpected ACL entry on discovery cache: $sid"
    }
}
foreach ($requiredSid in $allowedSids) {
    if ($requiredSid -notin $actualSids) {
        throw "missing ACL entry on discovery cache: $requiredSid"
    }
}
"""
        acl_environment = os.environ.copy()
        acl_environment.update(
            {
                "AGENTHUB_DISCOVERY_ACL_PATH": str(path),
                "AGENTHUB_DISCOVERY_ACL_IDENTITY": identity,
                "AGENTHUB_DISCOVERY_ACL_DIRECTORY": "1" if directory else "0",
            }
        )
        completed = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            env=acl_environment,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if completed.returncode != 0:
            raise PermissionError(f"unable to secure discovery cache ACL for {path}")
        self._acl_secured_paths.add(key)

    def _discard_cache_files(self) -> None:
        for path in (
            self._db_path,
            Path(f"{self._db_path}-wal"),
            Path(f"{self._db_path}-shm"),
        ):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _open_connection(db_path: Path) -> sqlite3.Connection:
        connection = sqlite3.connect(db_path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def _connect(self) -> sqlite3.Connection:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._secure_cache_files()
        connection: sqlite3.Connection | None = None
        try:
            connection = self._open_connection(self._db_path)
            connection.execute("PRAGMA schema_version").fetchone()
            self._ensure_schema(connection)
        except sqlite3.DatabaseError as error:
            if connection is not None:
                connection.close()
            if not self._is_corruption_error(error):
                raise
            self._discard_cache_files()
            self._initialized = False
            connection = self._open_connection(self._db_path)
            try:
                self._ensure_schema(connection)
            except Exception:
                connection.close()
                raise
        try:
            self._secure_cache_files()
        except Exception:
            if connection is not None:
                connection.close()
            raise
        return connection

    def _ensure_schema(self, connection: sqlite3.Connection) -> None:
        if self._initialized:
            return
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS session_snapshot_cache (
                path TEXT PRIMARY KEY,
                backend TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL,
                cache_version INTEGER NOT NULL DEFAULT 1,
                snapshot_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS session_file_index (
                root TEXT NOT NULL,
                path TEXT NOT NULL,
                backend TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime REAL NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(root, path)
            )
            """
        )
        index_primary_key = [
            str(row[1])
            for row in connection.execute("PRAGMA table_info(session_file_index)").fetchall()
            if int(row[5]) > 0
        ]
        if index_primary_key != ["root", "path"]:
            connection.execute("ALTER TABLE session_file_index RENAME TO session_file_index_legacy")
            connection.execute(
                """
                CREATE TABLE session_file_index (
                    root TEXT NOT NULL,
                    path TEXT NOT NULL,
                    backend TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    mtime REAL NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(root, path)
                )
                """
            )
            connection.execute(
                """
                INSERT OR REPLACE INTO session_file_index(root, path, backend, size, mtime, updated_at)
                SELECT root, path, backend, size, mtime, updated_at
                FROM session_file_index_legacy
                """
            )
            connection.execute("DROP TABLE session_file_index_legacy")
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS ix_session_file_index_root
            ON session_file_index(root)
            """
        )
        snapshot_columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(session_snapshot_cache)").fetchall()
        }
        if "cache_version" not in snapshot_columns:
            connection.execute(
                "ALTER TABLE session_snapshot_cache ADD COLUMN cache_version INTEGER NOT NULL DEFAULT 1"
            )
        connection.commit()
        self._initialized = True

    def load(self, path: Path, backend: str, stat: os.stat_result) -> SessionSnapshot | None:
        try:
            with self._lock:
                connection = self._connect()
                try:
                    self._ensure_schema(connection)
                    row = connection.execute(
                        """
                        SELECT snapshot_json
                        FROM session_snapshot_cache
                        WHERE path = ? AND backend = ? AND size = ? AND mtime_ns = ? AND cache_version = ?
                        """,
                        (
                            str(path),
                            backend,
                            int(stat.st_size),
                            int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000))),
                            DISCOVERY_CACHE_VERSION,
                        ),
                    ).fetchone()
                finally:
                    connection.close()
                    self._secure_cache_files()
        except (OSError, sqlite3.Error, subprocess.SubprocessError):
            return None
        if row is None:
            return None
        try:
            return SessionSnapshot.model_validate(json.loads(str(row["snapshot_json"])))
        except (json.JSONDecodeError, ValueError, TypeError):
            return None

    def store(self, path: Path, backend: str, stat: os.stat_result, snapshot: SessionSnapshot) -> None:
        payload = json.dumps(snapshot.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":"))
        mtime_ns = int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000)))
        try:
            with self._lock:
                connection = self._connect()
                try:
                    self._ensure_schema(connection)
                    connection.execute(
                        """
                        INSERT INTO session_snapshot_cache(
                            path, backend, size, mtime_ns, cache_version, snapshot_json, updated_at
                        )
                        VALUES(?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(path) DO UPDATE SET
                            backend = excluded.backend,
                            size = excluded.size,
                            mtime_ns = excluded.mtime_ns,
                            cache_version = excluded.cache_version,
                            snapshot_json = excluded.snapshot_json,
                            updated_at = excluded.updated_at
                        """,
                        (
                            str(path),
                            backend,
                            int(stat.st_size),
                            mtime_ns,
                            DISCOVERY_CACHE_VERSION,
                            payload,
                            datetime.now(timezone.utc).isoformat(),
                        ),
                    )
                    connection.commit()
                finally:
                    connection.close()
                    self._secure_cache_files()
        except (OSError, sqlite3.Error, subprocess.SubprocessError):
            return

    def load_file_records(self, root: Path) -> list[_SessionFileRecord]:
        try:
            with self._lock:
                connection = self._connect()
                try:
                    self._ensure_schema(connection)
                    rows = connection.execute(
                        """
                        SELECT path, backend, size, mtime
                        FROM session_file_index
                        WHERE root = ?
                        """,
                        (str(root),),
                    ).fetchall()
                finally:
                    connection.close()
                    self._secure_cache_files()
        except (OSError, sqlite3.Error, subprocess.SubprocessError):
            return []
        return [
            _SessionFileRecord(
                backend=str(row["backend"]),
                path=Path(str(row["path"])),
                mtime=float(row["mtime"]),
                size=int(row["size"]),
            )
            for row in rows
        ]

    def upsert_file_records(self, root: Path, records: list[_SessionFileRecord]) -> None:
        if not records:
            return
        updated_at = datetime.now(timezone.utc).isoformat()
        values = [
            (str(root), str(record.path), record.backend, record.size, record.mtime, updated_at)
            for record in records
        ]
        try:
            with self._lock:
                connection = self._connect()
                try:
                    self._ensure_schema(connection)
                    connection.executemany(
                        """
                        INSERT INTO session_file_index(root, path, backend, size, mtime, updated_at)
                        VALUES(?, ?, ?, ?, ?, ?)
                        ON CONFLICT(root, path) DO UPDATE SET
                            backend = excluded.backend,
                            size = excluded.size,
                            mtime = excluded.mtime,
                            updated_at = excluded.updated_at
                        """,
                        values,
                    )
                    connection.commit()
                finally:
                    connection.close()
                    self._secure_cache_files()
        except (OSError, sqlite3.Error, subprocess.SubprocessError):
            return

    def replace_file_records(self, root: Path, records: list[_SessionFileRecord]) -> None:
        updated_at = datetime.now(timezone.utc).isoformat()
        values = [
            (str(root), str(record.path), record.backend, record.size, record.mtime, updated_at)
            for record in records
        ]
        try:
            with self._lock:
                connection = self._connect()
                try:
                    self._ensure_schema(connection)
                    connection.execute("DELETE FROM session_file_index WHERE root = ?", (str(root),))
                    if values:
                        connection.executemany(
                            """
                            INSERT INTO session_file_index(root, path, backend, size, mtime, updated_at)
                            VALUES(?, ?, ?, ?, ?, ?)
                            """,
                            values,
                        )
                    self._prune_unindexed_snapshots(connection)
                    connection.commit()
                finally:
                    connection.close()
                    self._secure_cache_files()
        except (OSError, sqlite3.Error, subprocess.SubprocessError):
            return

    @staticmethod
    def _prune_unindexed_snapshots(connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            DELETE FROM session_snapshot_cache
            WHERE NOT EXISTS (
                SELECT 1 FROM session_file_index
                WHERE session_file_index.path = session_snapshot_cache.path
            )
            """
        )

    def delete_file_records(self, root: Path, paths: list[Path]) -> None:
        if not paths:
            return
        try:
            with self._lock:
                connection = self._connect()
                try:
                    self._ensure_schema(connection)
                    connection.executemany(
                        "DELETE FROM session_file_index WHERE root = ? AND path = ?",
                        [(str(root), str(path)) for path in paths],
                    )
                    self._prune_unindexed_snapshots(connection)
                    connection.commit()
                finally:
                    connection.close()
                    self._secure_cache_files()
        except (OSError, sqlite3.Error, subprocess.SubprocessError):
            return

    def reset(self) -> None:
        with self._lock:
            self._initialized = False
            self._acl_secured_paths.clear()
            self._discard_cache_files()


_snapshot_cache: _SnapshotCache | None = None


def _get_snapshot_cache() -> _SnapshotCache:
    global _snapshot_cache
    if _snapshot_cache is None:
        _snapshot_cache = _SnapshotCache(_snapshot_cache_path())
    return _snapshot_cache


def reset_discovery_snapshot_cache() -> None:
    global _snapshot_cache
    cache = _snapshot_cache
    if cache is not None:
        cache.reset()
    else:
        db_path = _snapshot_cache_path()
        if db_path.exists():
            db_path.unlink()
    _snapshot_cache = None


class _RecentSessionIndex:
    def __init__(self) -> None:
        self._states: dict[str, _RootScanState] = {}
        self._lock = threading.Lock()

    def reset(self) -> None:
        with self._lock:
            self._states.clear()
            _reset_direct_probe_cursors()

    def recent_files(self, search_roots: list[Path], per_backend_limit: int) -> list[tuple[str, Path]]:
        now = time.time()
        with self._lock:
            candidates: list[_SessionFileRecord] = []
            for root in search_roots:
                if not root.exists():
                    continue
                state = self._states.setdefault(str(root), _RootScanState(root=root))
                if not state.records:
                    self._seed_scan(state, now, per_backend_limit)
                else:
                    self._refresh_known_files(state)
                    self._probe_new_files(state, per_backend_limit)
                candidates.extend(state.records.values())
        candidates.sort(key=lambda item: (item.mtime, str(item.path).lower()), reverse=True)
        selected: list[tuple[str, Path]] = []
        backend_counts: dict[str, int] = {}
        for record in candidates:
            count = backend_counts.get(record.backend, 0)
            if count >= per_backend_limit:
                continue
            selected.append((record.backend, record.path))
            backend_counts[record.backend] = count + 1
        return selected

    def rebuild(self, search_roots: list[Path]) -> dict[str, Any]:
        now = time.time()
        per_backend_limit = _env_int("AGENTHUB_DISCOVERY_MAX_FILES", DEFAULT_DISCOVERY_MAX_FILES)
        backend_counts: dict[str, int] = {}
        total = 0
        with self._lock:
            for root in search_roots:
                if not root.exists():
                    continue
                state = self._states.setdefault(str(root), _RootScanState(root=root))
                self._full_scan(state, now, per_backend_limit)
                for record in state.records.values():
                    backend_counts[record.backend] = backend_counts.get(record.backend, 0) + 1
                    total += 1
        return {
            "roots": len([root for root in search_roots if root.exists()]),
            "files": total,
            "backends": dict(sorted(backend_counts.items())),
        }

    def _full_scan(self, state: _RootScanState, now: float, per_backend_limit: int) -> None:
        records: dict[str, _SessionFileRecord] = {}
        for record in self._iter_root_candidates(state.root, full_scan=True, probe_limit=per_backend_limit):
            records[str(record.path)] = record
        state.records = self._select_recent_records(records.values(), per_backend_limit)
        state.last_full_scan_at = now
        _get_snapshot_cache().replace_file_records(state.root, list(state.records.values()))

    def _seed_scan(self, state: _RootScanState, now: float, per_backend_limit: int) -> None:
        state.records = {
            str(record.path): record
            for record in _get_snapshot_cache().load_file_records(state.root)
        }
        self._refresh_known_files(state)
        self._probe_new_files(state, per_backend_limit)
        state.last_full_scan_at = now

    def _refresh_known_files(self, state: _RootScanState) -> None:
        refreshed: dict[str, _SessionFileRecord] = {}
        changed: list[_SessionFileRecord] = []
        deleted: list[Path] = []
        for key, record in state.records.items():
            try:
                stat = record.path.stat()
            except OSError:
                deleted.append(record.path)
                continue
            next_record = _SessionFileRecord(
                backend=record.backend,
                path=record.path,
                mtime=stat.st_mtime,
                size=int(stat.st_size),
            )
            refreshed[key] = next_record
            if next_record.mtime != record.mtime or next_record.size != record.size:
                changed.append(next_record)
        state.records = refreshed
        cache = _get_snapshot_cache()
        cache.upsert_file_records(state.root, changed)
        cache.delete_file_records(state.root, deleted)

    def _probe_new_files(self, state: _RootScanState, per_backend_limit: int) -> None:
        changed: list[_SessionFileRecord] = []
        superseded: list[Path] = []
        for record in self._iter_root_candidates(
            state.root, full_scan=False, probe_limit=per_backend_limit
        ):
            key = str(record.path)
            if record.backend == "kimi" and record.path.name.lower() == "wire.jsonl":
                context_path = record.path.parent / "context.jsonl"
                if state.records.pop(str(context_path), None) is not None:
                    superseded.append(context_path)
            if state.records.get(key) == record:
                continue
            state.records[key] = record
            changed.append(record)
        cache = _get_snapshot_cache()
        cache.upsert_file_records(state.root, changed)
        cache.delete_file_records(state.root, superseded)
        trimmed = self._select_recent_records(state.records.values(), per_backend_limit)
        if trimmed.keys() != state.records.keys():
            state.records = trimmed
            cache.replace_file_records(state.root, list(trimmed.values()))

    @staticmethod
    def _select_recent_records(
        records: Any, per_backend_limit: int
    ) -> dict[str, _SessionFileRecord]:
        selected: dict[str, _SessionFileRecord] = {}
        backend_counts: dict[str, int] = {}
        ordered = sorted(records, key=lambda item: (item.mtime, str(item.path).lower()), reverse=True)
        for record in ordered:
            count = backend_counts.get(record.backend, 0)
            if count >= per_backend_limit:
                continue
            selected[str(record.path)] = record
            backend_counts[record.backend] = count + 1
        return selected

    def _iter_root_candidates(
        self, root: Path, *, full_scan: bool, probe_limit: int
    ) -> list[_SessionFileRecord]:
        records: list[_SessionFileRecord] = []
        iterator = _iter_jsonl_paths(root) if full_scan else _probe_recent_jsonl_paths(root, probe_limit)
        for path in iterator:
            lower_parts = [part.lower() for part in path.parts]
            if "subagents" in lower_parts:
                continue
            backend = backend_for_session_path(path)
            if path.name.lower() == "wire.jsonl" and ".kimi" not in lower_parts:
                continue
            if backend == "kimi" and path.name.lower() == "context.jsonl" and (path.parent / "wire.jsonl").exists():
                continue
            if backend not in {"codex", "claude", "kimi", "opencode"}:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            records.append(
                _SessionFileRecord(
                    backend=backend,
                    path=path,
                    mtime=stat.st_mtime,
                    size=int(stat.st_size),
                )
            )
        return records


_recent_session_index = _RecentSessionIndex()


def reset_recent_session_index() -> None:
    _recent_session_index.reset()


def rebuild_recent_session_index(search_roots: list[Path]) -> dict[str, Any]:
    return _recent_session_index.rebuild(search_roots)


def _iter_jsonl_paths(root: Path):
    try:
        walker = os.walk(root)
        for dirpath, dirnames, filenames in walker:
            dirnames[:] = [name for name in dirnames if name.lower() not in DISCOVERY_PRUNED_DIRS]
            for filename in filenames:
                if filename.lower().endswith(".jsonl"):
                    yield Path(dirpath) / filename
    except OSError:
        return


def _codex_runtime_index_paths(root: Path, limit: int) -> list[Path]:
    database_path = root.parent / "state_5.sqlite"
    if not database_path.exists():
        return []
    connection: sqlite3.Connection | None = None
    try:
        uri = database_path.resolve().as_uri() + "?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=1.0)
        columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(threads)").fetchall()
        }
        if "rollout_path" not in columns:
            return []
        order_column = next(
            (name for name in ("updated_at_ms", "recency_at_ms", "updated_at", "created_at") if name in columns),
            "rollout_path",
        )
        rows = connection.execute(
            f'SELECT rollout_path FROM threads ORDER BY "{order_column}" DESC LIMIT ?',
            (limit,),
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        if connection is not None:
            connection.close()
    results: list[Path] = []
    for row in rows:
        path = Path(str(row[0] or ""))
        if path.is_file() and path.suffix.lower() == ".jsonl":
            results.append(path)
    return results


def _probe_entry_budget(limit: int) -> int:
    return max(64, limit * 4)


@dataclass
class _DirectProbeCursor:
    iterator: Any
    last_used: float


@dataclass
class _KimiProbeCursor:
    registry_signature: tuple[int, int] | None = None
    registry_offset: int = 0
    workdir_iterator: Any | None = None
    session_iterator: Any | None = None
    last_used: float = 0.0


_direct_probe_iterators: dict[str, _DirectProbeCursor] = {}
_kimi_probe_cursors: dict[str, _KimiProbeCursor] = {}
_direct_probe_lock = threading.Lock()


def _close_probe_iterator(iterator: Any | None) -> None:
    if iterator is None:
        return
    try:
        iterator.close()
    except OSError:
        pass


def _evict_idle_probe_cursors(now: float) -> None:
    cutoff = now - DEFAULT_DISCOVERY_CURSOR_TTL_SECONDS
    for key, cursor in list(_direct_probe_iterators.items()):
        if cursor.last_used >= cutoff:
            continue
        _close_probe_iterator(cursor.iterator)
        _direct_probe_iterators.pop(key, None)
    for key, cursor in list(_kimi_probe_cursors.items()):
        if cursor.last_used >= cutoff:
            continue
        _close_probe_iterator(cursor.session_iterator)
        _close_probe_iterator(cursor.workdir_iterator)
        _kimi_probe_cursors.pop(key, None)


def _reset_direct_probe_cursors() -> None:
    with _direct_probe_lock:
        for cursor in _direct_probe_iterators.values():
            _close_probe_iterator(cursor.iterator)
        _direct_probe_iterators.clear()
        for cursor in _kimi_probe_cursors.values():
            _close_probe_iterator(cursor.session_iterator)
            _close_probe_iterator(cursor.workdir_iterator)
        _kimi_probe_cursors.clear()


def _bounded_direct_jsonl_paths(root: Path, limit: int) -> list[Path]:
    candidates: list[tuple[float, str, Path]] = []
    key = str(root)
    now = time.time()
    with _direct_probe_lock:
        _evict_idle_probe_cursors(now)
        cursor = _direct_probe_iterators.get(key)
        if cursor is None:
            try:
                entries = os.scandir(root)
            except OSError:
                return []
            cursor = _DirectProbeCursor(iterator=entries, last_used=now)
            _direct_probe_iterators[key] = cursor
        else:
            entries = cursor.iterator
            cursor.last_used = now
        for _ in range(_probe_entry_budget(limit)):
            try:
                entry = next(entries)
            except StopIteration:
                _close_probe_iterator(entries)
                _direct_probe_iterators.pop(key, None)
                break
            except OSError:
                _close_probe_iterator(entries)
                _direct_probe_iterators.pop(key, None)
                break
            try:
                if not entry.is_file() or not entry.name.lower().endswith(".jsonl"):
                    continue
                stat = entry.stat()
            except OSError:
                continue
            path = Path(entry.path)
            candidates.append((stat.st_mtime, str(path).lower(), path))
            if len(candidates) >= limit:
                break
    candidates.sort(reverse=True)
    return [path for _, _, path in candidates[:limit]]


def _provider_home(root: Path, marker: str) -> Path | None:
    for candidate in (root, *root.parents):
        if candidate.name.lower() == marker:
            return candidate
    return None


def _probe_codex_recent_paths(root: Path, limit: int) -> list[Path]:
    results: list[Path] = []
    seen: set[str] = set()

    def append(path: Path) -> None:
        key = str(path)
        if key in seen or not path.is_file():
            return
        seen.add(key)
        results.append(path)

    for path in _codex_runtime_index_paths(root, limit):
        append(path)
    if len(results) >= limit:
        return results[:limit]
    for path in _bounded_direct_jsonl_paths(root, limit - len(results)):
        append(path)
    if len(results) >= limit:
        return results[:limit]
    today = datetime.now()
    for days_back in range(0, 14):
        if len(results) >= limit:
            break
        stamp = today - timedelta(days=days_back)
        day_dir = root / stamp.strftime("%Y") / stamp.strftime("%m") / stamp.strftime("%d")
        if not day_dir.exists():
            continue
        for entry in _bounded_direct_jsonl_paths(day_dir, limit - len(results)):
            append(entry)
    return results[:limit]


def _claude_project_bucket(project: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "-", project)


def _probe_claude_recent_paths(root: Path, limit: int) -> list[Path]:
    results: list[Path] = []
    seen_paths: set[str] = set()

    def append(path: Path) -> None:
        key = str(path)
        if key in seen_paths or not path.is_file():
            return
        seen_paths.add(key)
        results.append(path)

    claude_home = _provider_home(root, ".claude")
    projects_root = claude_home / "projects" if claude_home is not None else root
    history_path = claude_home / "history.jsonl" if claude_home is not None else root.parent / "history.jsonl"
    if history_path.exists():
        seen_sessions: set[str] = set()
        for row in reversed(_bounded_jsonl_rows(history_path)):
            session_id = str(row.get("sessionId") or row.get("session_id") or "").strip()
            project = str(row.get("project") or row.get("cwd") or "").strip()
            if not session_id or not project or session_id in seen_sessions:
                continue
            seen_sessions.add(session_id)
            append(projects_root / _claude_project_bucket(project) / f"{session_id}.jsonl")
            if len(results) >= limit:
                break
    if len(results) < limit:
        for candidate in _bounded_direct_jsonl_paths(root, limit):
            append(candidate)
            if len(results) >= limit:
                break
    return results[:limit]


def _probe_kimi_recent_paths(root: Path, limit: int) -> list[Path]:
    kimi_home = _provider_home(root, ".kimi")
    sessions_root = kimi_home / "sessions" if kimi_home is not None else root
    registry_path = kimi_home / "kimi.json" if kimi_home is not None else root.parent / "kimi.json"
    try:
        registry_stat = registry_path.stat()
        registry_signature = (
            int(getattr(registry_stat, "st_mtime_ns", int(registry_stat.st_mtime * 1_000_000_000))),
            int(registry_stat.st_size),
        )
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        registry_signature = None
        registry = {}
    work_dirs = registry.get("work_dirs") if isinstance(registry, dict) else []
    if not isinstance(work_dirs, list):
        work_dirs = []
    results: list[Path] = []
    seen: set[str] = set()

    def append_session(session_dir: Path) -> None:
        wire_path = session_dir / "wire.jsonl"
        context_path = session_dir / "context.jsonl"
        candidate = wire_path if wire_path.is_file() else context_path
        if not candidate.is_file() or str(candidate) in seen:
            return
        seen.add(str(candidate))
        results.append(candidate)

    key = str(sessions_root)
    now = time.time()
    with _direct_probe_lock:
        _evict_idle_probe_cursors(now)
        cursor = _kimi_probe_cursors.setdefault(key, _KimiProbeCursor())
        cursor.last_used = now
        if cursor.registry_signature != registry_signature:
            cursor.registry_signature = registry_signature
            cursor.registry_offset = 0

        registry_budget = min(_probe_entry_budget(limit), len(work_dirs))
        if work_dirs:
            start = cursor.registry_offset % len(work_dirs)
            for offset in range(registry_budget):
                item = work_dirs[(start + offset) % len(work_dirs)]
                if not isinstance(item, dict):
                    continue
                raw_path = str(item.get("path") or "").strip()
                session_id = str(item.get("last_session_id") or "").strip()
                if not raw_path or not session_id:
                    continue
                workdir_hash = hashlib.md5(raw_path.encode()).hexdigest()
                append_session(sessions_root / workdir_hash / session_id)
            cursor.registry_offset = (start + registry_budget) % len(work_dirs)

        remaining_budget = _probe_entry_budget(limit)
        while remaining_budget > 0:
            if cursor.session_iterator is not None:
                try:
                    session_entry = next(cursor.session_iterator)
                except StopIteration:
                    _close_probe_iterator(cursor.session_iterator)
                    cursor.session_iterator = None
                    continue
                except OSError:
                    _close_probe_iterator(cursor.session_iterator)
                    cursor.session_iterator = None
                    continue
                remaining_budget -= 1
                try:
                    if session_entry.is_dir():
                        append_session(Path(session_entry.path))
                except OSError:
                    continue
                continue

            if cursor.workdir_iterator is None:
                try:
                    cursor.workdir_iterator = os.scandir(sessions_root)
                except OSError:
                    break
            try:
                workdir_entry = next(cursor.workdir_iterator)
            except StopIteration:
                _close_probe_iterator(cursor.workdir_iterator)
                cursor.workdir_iterator = None
                break
            except OSError:
                _close_probe_iterator(cursor.workdir_iterator)
                cursor.workdir_iterator = None
                break
            remaining_budget -= 1
            try:
                if workdir_entry.is_dir():
                    cursor.session_iterator = os.scandir(workdir_entry.path)
            except OSError:
                cursor.session_iterator = None
    return results


def _probe_recent_jsonl_paths(root: Path, limit: int):
    backend = backend_for_session_path(root)
    if backend == "codex":
        yield from _probe_codex_recent_paths(root, limit)
        return
    if backend == "claude":
        yield from _probe_claude_recent_paths(root, limit)
        return
    if backend == "kimi":
        yield from _probe_kimi_recent_paths(root, limit)
        return
    seen: set[str] = set()

    def emit(paths: list[Path]):
        for path in paths:
            key = str(path)
            if key in seen:
                continue
            seen.add(key)
            yield path

    direct_counts: dict[str, int] = {}
    direct_limit = limit * 4
    for path in _bounded_direct_jsonl_paths(root, direct_limit):
        backend = backend_for_session_path(path)
        count = direct_counts.get(backend, 0)
        if count >= limit:
            continue
        direct_counts[backend] = count + 1
        yield from emit([path])
    known_roots = (
        (root / ".codex" / "sessions", _probe_codex_recent_paths),
        (root / ".claude" / "projects", _probe_claude_recent_paths),
        (root / ".kimi" / "sessions", _probe_kimi_recent_paths),
    )
    for provider_root, probe in known_roots:
        if not provider_root.exists():
            continue
        yield from emit(probe(provider_root, limit))


def backend_for_session_path(path: Path) -> str:
    lower_parts = [part.lower() for part in path.parts]
    lower_name = path.name.lower()
    if "codex" in lower_name or ".codex" in lower_parts:
        return "codex"
    if "claude" in lower_name or ".claude" in lower_parts:
        return "claude"
    if "kimi" in lower_name or ".kimi" in lower_parts:
        return "kimi"
    if "opencode" in lower_name or ".opencode" in lower_parts:
        return "opencode"
    return ""


def recent_session_files(search_roots: list[Path], max_files: int | None = None) -> list[tuple[str, Path]]:
    per_backend_limit = max_files or _env_int("AGENTHUB_DISCOVERY_MAX_FILES", DEFAULT_DISCOVERY_MAX_FILES)
    return _recent_session_index.recent_files(search_roots, per_backend_limit)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                rows.append(value)
    return rows


def _parse_jsonl_lines(text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        candidate = line.strip()
        if not candidate:
            continue
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def _complete_head_text(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace")
    if not text:
        return ""
    if text.endswith("\n"):
        return text
    return text.rsplit("\n", 1)[0] if "\n" in text else ""


def _complete_tail_text(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace")
    if not text:
        return ""
    if text.startswith("\n"):
        return text.lstrip("\n")
    if "\n" in text:
        return text.split("\n", 1)[1]
    return ""


def _bounded_jsonl_rows(path: Path) -> list[dict[str, Any]]:
    head_bytes = _env_int("AGENTHUB_DISCOVERY_HEAD_BYTES", DEFAULT_DISCOVERY_HEAD_BYTES)
    tail_bytes = _env_int("AGENTHUB_DISCOVERY_TAIL_BYTES", DEFAULT_DISCOVERY_TAIL_BYTES)
    stat = path.stat()
    if stat.st_size <= head_bytes + tail_bytes:
        return _read_jsonl(path)

    with path.open("rb") as handle:
        head = handle.read(head_bytes)
        handle.seek(max(0, stat.st_size - tail_bytes))
        tail = handle.read(tail_bytes)
    return _parse_jsonl_lines(_complete_head_text(head) + "\n" + _complete_tail_text(tail))


def _cached_session_snapshot(
    path: Path,
    backend: str,
    parser: Any,
    stat: Any | None = None,
) -> SessionSnapshot:
    stat = stat or path.stat()
    cached = _get_snapshot_cache().load(path, backend, stat)
    if cached is not None and not _cached_running_status_is_stale(cached):
        return cached
    snapshot = parser(path, stat)
    _get_snapshot_cache().store(path, backend, stat, snapshot)
    return snapshot


def _cached_running_status_is_stale(snapshot: SessionSnapshot) -> bool:
    if snapshot.status != "running" or snapshot.last_activity_at is None:
        return False
    last_activity_at = snapshot.last_activity_at
    if last_activity_at.tzinfo is not None:
        now = datetime.now(timezone.utc)
    else:
        now = datetime.now().replace(tzinfo=None)
    stale_seconds = _env_int(
        "AGENTHUB_DISCOVERY_RUNNING_STALE_SECONDS",
        DEFAULT_RUNNING_STALE_SECONDS,
    )
    return last_activity_at < now - timedelta(seconds=stale_seconds)


def _combined_cache_stat(paths: list[Path]) -> _CacheStat:
    digest = hashlib.sha256()
    total_size = 0
    latest_mtime = 0.0
    for path in sorted((path for path in paths if path.exists()), key=lambda item: str(item).lower()):
        stat = path.stat()
        total_size += int(stat.st_size)
        latest_mtime = max(latest_mtime, stat.st_mtime)
        digest.update(str(path).encode("utf-8", errors="surrogatepass"))
        digest.update(str(int(stat.st_size)).encode())
        digest.update(str(int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000)))).encode())
    signature = int.from_bytes(digest.digest()[:8], "big") & ((1 << 63) - 1)
    return _CacheStat(st_size=total_size, st_mtime=latest_mtime, st_mtime_ns=signature)


def _text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if item.get("type") in {"text", "output_text", "input_text"} and isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif item.get("type") == "tool_use":
                    parts.append(f"[tool_use] {item.get('name') or item.get('content') or ''}".strip())
                elif item.get("type") == "tool_result":
                    parts.append(f"[tool_result] {_text_from_content(item.get('content'))}".strip())
                elif isinstance(item.get("content"), (str, list, dict)):
                    parts.append(_text_from_content(item["content"]))
        return "\n".join(part for part in parts if part)
    if isinstance(content, dict):
        if isinstance(content.get("text"), str):
            return content["text"]
        parts: list[str] = []
        for key in ("message", "output", "stdout", "stderr", "description", "error"):
            if isinstance(content.get(key), (str, list, dict)):
                parts.append(_text_from_content(content[key]))
        if isinstance(content.get("display"), list):
            parts.append(_text_from_content(content["display"]))
        if parts:
            return "\n".join(part for part in parts if part)
        if isinstance(content.get("content"), (str, list, dict)):
            return _text_from_content(content["content"])
    return ""


def _timestamp(value: Any, fallback: datetime) -> datetime:
    if isinstance(value, (int, float)):
        # Kimi wire timestamps are seconds; JS-style timestamps are milliseconds.
        seconds = value / 1000 if value > 10_000_000_000 else value
        return datetime.fromtimestamp(seconds, tz=timezone.utc).replace(tzinfo=None)
    if isinstance(value, str):
        normalized = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
            return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed
        except ValueError:
            return fallback
    return fallback


def _compact(value: str, limit: int = 140) -> str:
    compacted = " ".join(value.split())
    return f"{compacted[: limit - 3]}..." if len(compacted) > limit else compacted


def _clean_claude_display_text(value: str) -> str:
    lines: list[str] = []
    for raw_line in value.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        lower = line.lower()
        if any(tag in lower for tag in CLAUDE_LOCAL_COMMAND_TAGS):
            continue
        if lower.startswith("[tool_use]"):
            continue
        lines.append(raw_line)
    return "\n".join(lines).strip()


def _claude_tool_input_text(value: Any) -> str:
    if isinstance(value, dict):
        ordered_parts: list[str] = []
        for key in ("subject", "description", "activeForm", "command", "file_path", "path", "taskId", "status"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                ordered_parts.append(f"{key}: {candidate.strip()}")
        for key, candidate in value.items():
            if key in {"subject", "description", "activeForm", "command", "file_path", "path", "taskId", "status"}:
                continue
            if isinstance(candidate, (str, int, float, bool)) and str(candidate).strip():
                ordered_parts.append(f"{key}: {candidate}")
        return "\n".join(ordered_parts)
    return _text_from_content(value)


def _claude_tool_call_text(item: dict[str, Any]) -> str:
    tool_name = str(item.get("name") or "tool").strip() or "tool"
    detail = _claude_tool_input_text(item.get("input"))
    return f"调用工具: {tool_name}" if not detail else f"调用工具: {tool_name}\n{detail[:2000]}"


def _should_hide_claude_tool_call(item: dict[str, Any]) -> bool:
    return str(item.get("name") or "").strip().lower() == "agent"


def _claude_tool_result_text(item: dict[str, Any], row: dict[str, Any]) -> str:
    detail = _clean_claude_display_text(_text_from_content(item.get("content")))
    result = row.get("toolUseResult")
    if isinstance(result, dict):
        if isinstance(result.get("task"), dict):
            task = result["task"]
            task_id = str(task.get("id") or "").strip()
            subject = str(task.get("subject") or "").strip()
            task_line = " ".join(part for part in (f"#{task_id}" if task_id else "", subject) if part).strip()
            if task_line:
                detail = task_line if not detail else f"{detail}\n{task_line}"
        elif isinstance(result.get("file"), dict):
            file_info = result["file"]
            file_path = str(file_info.get("filePath") or "").strip()
            file_content = _text_from_content(file_info.get("content"))
            file_parts = [part for part in (f"file: {file_path}" if file_path else "", file_content) if part]
            if file_parts:
                joined = "\n".join(file_parts)
                detail = joined if not detail else f"{detail}\n{joined}"
        elif any(isinstance(result.get(key), str) and str(result.get(key)).strip() for key in ("stdout", "stderr")):
            stdout = str(result.get("stdout") or "").strip()
            stderr = str(result.get("stderr") or "").strip()
            output_parts = []
            if stdout:
                output_parts.append(stdout)
            if stderr:
                output_parts.append(f"stderr:\n{stderr}")
            if output_parts:
                joined = "\n".join(output_parts)
                detail = joined if not detail else f"{detail}\n{joined}"
        elif result.get("success") is not None:
            success = "success" if result.get("success") else "failed"
            task_id = str(result.get("taskId") or "").strip()
            updated_fields = result.get("updatedFields")
            status_change = result.get("statusChange")
            parts = [f"success: {success}"]
            if task_id:
                parts.append(f"taskId: {task_id}")
            if isinstance(updated_fields, list) and updated_fields:
                parts.append(f"updatedFields: {', '.join(str(field) for field in updated_fields)}")
            if isinstance(status_change, dict):
                before = str(status_change.get("from") or "").strip()
                after = str(status_change.get("to") or "").strip()
                if before or after:
                    parts.append(f"status: {before or '?'} -> {after or '?'}")
            joined = "\n".join(parts)
            detail = joined if not detail else f"{detail}\n{joined}"
    elif isinstance(result, str) and result.strip():
        detail = result.strip() if not detail else f"{detail}\n{result.strip()}"
    return "工具结果:" if not detail else f"工具结果:\n{detail[:4000]}"


def _is_uuidish(value: str) -> bool:
    stripped = value.lower().replace("rollout-", "")
    return sum(ch.isdigit() or ch in "abcdef-" for ch in stripped) >= max(12, int(len(stripped) * 0.65))


def _title_from_text(value: str, fallback: str) -> str:
    compacted = _compact(value, 42)
    normalized = compacted.strip().lower()
    if not compacted or _is_uuidish(compacted) or normalized in GENERIC_TITLES or normalized in ACK_TITLES:
        return fallback
    return compacted


def _title_source(messages: list[dict[str, Any]]) -> str:
    for item in messages:
        if item["role"] == "user" and item["text"]:
            return str(item["text"])
    for item in messages:
        if item["role"] in {"assistant", "user"} and item["text"]:
            return str(item["text"])
    return ""


def _fallback_title(workspace_root: str, backend: str, mtime: datetime) -> str:
    project = project_name_from_root(workspace_root)
    stamp = mtime.strftime("%m-%d %H:%M")
    return f"{project} · {backend} · {stamp}"


def _activity_summary(status: str, preview: str, action: str | None = None) -> str:
    clean = _compact(preview, 120)
    if status == "running":
        return f"正在执行：{_compact(action or clean or '继续处理中', 110)}"
    if status == "needs_reply":
        return f"等你回复：{clean or '需要你接一下'}"
    if status == "failed":
        return f"出现异常：{clean or '需要排查'}"
    return f"最近上下文：{clean}" if clean else "当前空闲"


def _codex_session_id_from_path(path: Path) -> str:
    match = CODEX_ROLLOUT_SESSION_RE.match(path.stem)
    if match:
        return match.group(1)
    return path.stem


def _infer_claude_workspace_root_from_path(path: Path) -> str:
    return infer_claude_workspace_root_from_runtime_ref(str(path))


def _is_fresh_action(last_message: dict[str, Any] | None, last_activity_at: datetime) -> bool:
    if not last_message or last_message.get("kind") != "action":
        return False
    stale_seconds = _env_int("AGENTHUB_DISCOVERY_RUNNING_STALE_SECONDS", DEFAULT_RUNNING_STALE_SECONDS)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    return last_activity_at >= now - timedelta(seconds=stale_seconds)


def _session_status_from_messages(
    last_message: dict[str, Any] | None,
    last_conversation: dict[str, Any] | None,
    last_activity_at: datetime,
) -> str:
    if _is_fresh_action(last_message, last_activity_at):
        return "running"
    if (last_conversation and last_conversation.get("role") == "assistant") or (
        last_message and last_message.get("role") == "assistant"
    ):
        return "needs_reply"
    return "ready"


def _dedupe_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for item in messages:
        created_at = item.get("created_at")
        timestamp = created_at.isoformat() if isinstance(created_at, datetime) else str(created_at or "")
        key = (
            str(item.get("role") or ""),
            str(item.get("kind") or ""),
            str(item.get("text") or "").strip(),
            timestamp,
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique


def _timeline_item_type(message: dict[str, Any]) -> str:
    kind = str(message.get("kind") or "")
    role = str(message.get("role") or "")
    if kind in {"user_message", "user"} or role == "user":
        return "user_message"
    if kind in {"assistant_message", "assistant"} or role == "assistant":
        return "assistant_message"
    if "error" in kind:
        return "error"
    if kind in {"reasoning", "todo", "compaction"}:
        return kind
    return "tool_call"


def _timeline_from_messages(messages: list[dict[str, Any]]) -> list[AgentTimelineItem]:
    items: list[AgentTimelineItem] = []
    for index, message in enumerate(messages, start=1):
        text = str(message.get("text") or "").strip()
        if not text:
            continue
        created_at = message.get("created_at")
        items.append(
            AgentTimelineItem(
                seq=index,
                item_type=_timeline_item_type(message),  # type: ignore[arg-type]
                role=str(message.get("role") or "system"),
                text=text,
                tool_call_id=str(message.get("tool_call_id") or "") or None,
                tool_name=str(message.get("tool_name") or "") or None,
                status="completed",
                payload=dict(message.get("payload") or {}, kind=message.get("kind")),
                created_at=created_at if isinstance(created_at, datetime) else None,
            )
        )
    return items


def _snapshot(
    *,
    session_id: str,
    backend: str,
    workspace_root: str,
    runtime_session_ref: str,
    messages: list[dict[str, Any]],
    fallback_mtime: datetime,
    metadata: dict[str, Any],
    controls: dict[str, Any] | None = None,
) -> SessionSnapshot:
    workspace_root = normalize_workspace_root(workspace_root)
    sorted_messages = sorted(_dedupe_messages(messages), key=lambda item: item["created_at"])
    last_message = sorted_messages[-1] if sorted_messages else None
    last_conversation = next(
        (item for item in reversed(sorted_messages) if item["role"] in {"assistant", "user"} and item["text"]),
        None,
    )
    latest_action = next((item for item in reversed(sorted_messages) if item["kind"] == "action" and item["text"]), None)
    last_activity_at = last_message["created_at"] if last_message else fallback_mtime
    last_role = str(last_message["role"]) if last_message else "system"
    status = _session_status_from_messages(last_message, last_conversation, last_activity_at)
    preview_source = (last_conversation or last_message or {}).get("text", "")
    fallback = _fallback_title(workspace_root, backend, fallback_mtime)
    heuristic_title = _title_from_text(_title_source(sorted_messages), fallback)
    activity = _activity_summary(status, str(preview_source), str(latest_action["text"]) if latest_action else None)
    display_title = heuristic_title
    last_text = str(last_conversation["text"]) if last_conversation else str(preview_source)
    timeline = _timeline_from_messages(sorted_messages)

    return SessionSnapshot(
        session_id=session_id,
        backend=backend,  # type: ignore[arg-type]
        workspace_root=workspace_root,
        project_name=project_name_from_root(workspace_root),
        runtime_session_ref=runtime_session_ref,
        status=status,
        title=display_title,
        display_title=display_title,
        heuristic_title=heuristic_title,
        activity_summary=activity,
        last_message=last_text,
        last_activity_at=last_activity_at,
        last_role=last_role,
        controls=controls or {},
        runtime_metadata={"messages": sorted_messages[-20:]},
        metadata=metadata,
        timeline=timeline,
    )


def _opencode_workspace_filters(search_roots: list[Path] | None) -> set[str]:
    if not search_roots:
        return set()
    filters: set[str] = set()
    for root in search_roots:
        normalized = normalize_workspace_root(str(root))
        lowered = normalized.lower()
        if any(marker in lowered for marker in ("/.codex", "/.claude", "/.kimi", "/.local/share/opencode")):
            continue
        filters.add(normalized.casefold())
    return filters


def _opencode_query_roots(search_roots: list[Path] | None) -> list[Path | None]:
    if not search_roots:
        return [None]
    roots: list[Path | None] = []
    seen: set[str] = set()
    for root in search_roots:
        normalized = normalize_workspace_root(str(root))
        lowered = normalized.lower()
        if any(marker in lowered for marker in ("/.codex", "/.claude", "/.kimi", "/.local/share/opencode")):
            continue
        if not root.exists() or not root.is_dir():
            continue
        key = normalized.casefold()
        if key in seen:
            continue
        seen.add(key)
        roots.append(root)
    return roots


def _opencode_row_value(row: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _opencode_snapshot_from_row(row: dict[str, Any]) -> SessionSnapshot | None:
    session_id = _opencode_row_value(row, "id", "session_id", "sessionId")
    workspace_root = normalize_workspace_root(
        _opencode_row_value(row, "path", "cwd", "directory", "dir", "workspace_root", "workspaceRoot", "project")
    )
    if not session_id or not workspace_root:
        return None
    last_activity_at = _timestamp(
        row.get("updated_at")
        or row.get("updatedAt")
        or row.get("updated")
        or row.get("created_at")
        or row.get("createdAt")
        or row.get("created"),
        datetime.now(timezone.utc).replace(tzinfo=None),
    )
    title = _opencode_row_value(row, "title", "name") or _fallback_title(workspace_root, "opencode", last_activity_at)
    activity_summary = _opencode_row_value(row, "summary", "description") or "当前空闲"
    return SessionSnapshot(
        session_id=session_id,
        backend="opencode",
        workspace_root=workspace_root,
        project_name=project_name_from_root(workspace_root),
        runtime_session_ref=f"opencode/{session_id}",
        status="ready",
        title=title,
        display_title=title,
        heuristic_title=title,
        activity_summary=activity_summary,
        last_message=activity_summary if activity_summary != "当前空闲" else "",
        last_activity_at=last_activity_at,
        last_role="assistant" if activity_summary != "当前空闲" else "system",
        controls={},
        runtime_metadata={"discovery_source": "opencode_cli"},
        metadata={},
        timeline=[],
    )


def discover_opencode_sessions(search_roots: list[Path] | None = None) -> list[SessionSnapshot]:
    executable = shutil.which("opencode")
    if executable is None:
        return []
    workspace_filters = _opencode_workspace_filters(search_roots)
    sessions: list[SessionSnapshot] = []
    seen: set[str] = set()
    for root in _opencode_query_roots(search_roots):
        try:
            completed = subprocess.run(
                ["opencode", "session", "list", "--format", "json"],
                executable=executable,
                cwd=str(root) if root is not None else None,
                text=True,
                capture_output=True,
                timeout=10,
                check=False,
            )
        except OSError:
            continue
        if completed.returncode != 0 or not (completed.stdout or "").strip():
            continue
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError:
            continue
        rows = payload.get("sessions") if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            snapshot = _opencode_snapshot_from_row(row)
            if snapshot is None:
                continue
            if workspace_filters and normalize_workspace_root(snapshot.workspace_root).casefold() not in workspace_filters:
                continue
            if snapshot.session_id in seen:
                continue
            seen.add(snapshot.session_id)
            sessions.append(snapshot)
    sessions.sort(key=lambda item: item.last_activity_at or datetime.min, reverse=True)
    return sessions


def _message(session_id: str, role: str, text: str, created_at: datetime, kind: str) -> dict[str, Any] | None:
    clean = text.strip()
    if not clean:
        return None
    return {"session_id": session_id, "role": role, "text": clean, "created_at": created_at, "kind": kind}


def _kimi_tool_name(payload: dict[str, Any]) -> str:
    function = payload.get("function") if isinstance(payload.get("function"), dict) else {}
    return str(
        function.get("name")
        or payload.get("name")
        or payload.get("tool")
        or payload.get("sender")
        or payload.get("action")
        or "function"
    ).strip()


def _kimi_tool_call_text(payload: dict[str, Any]) -> str:
    tool_name = _kimi_tool_name(payload)
    function = payload.get("function") if isinstance(payload.get("function"), dict) else {}
    arguments = _text_from_content(function.get("arguments") or payload.get("arguments") or "")
    summary = _text_from_content(payload.get("description") or "")
    detail = arguments or summary
    return f"调用工具: {tool_name}" if not detail else f"调用工具: {tool_name}\n{detail[:1000]}"


def _kimi_tool_result_text(payload: dict[str, Any]) -> str:
    content = payload.get("return_value")
    if content is None:
        content = payload.get("content")
    if content is None:
        content = payload.get("result")
    if content is None:
        content = payload.get("return")
    detail = _text_from_content(content)
    return "工具结果:" if not detail else f"工具结果:\n{detail[:4000]}"


def _parse_codex_jsonl_uncached(path: Path, stat: os.stat_result) -> SessionSnapshot:
    rows = _bounded_jsonl_rows(path)
    fallback_mtime = datetime.fromtimestamp(stat.st_mtime)
    session_id = _codex_session_id_from_path(path)
    session_id_from_path = session_id
    workspace_root = ""
    messages: list[dict[str, Any]] = []
    explicit_title = ""
    session_meta_seen = False
    for row in rows:
        row_type = row.get("type")
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        timestamp = _timestamp(row.get("timestamp"), fallback_mtime)
        if row_type in {"session", "session_meta"}:
            if not session_meta_seen:
                source = payload if row_type == "session_meta" else row
                candidate_session_id = str(source.get("id") or source.get("session_id") or "").strip()
                if candidate_session_id and (
                    _is_uuidish(candidate_session_id)
                    or session_id_from_path == path.stem
                    or candidate_session_id == session_id_from_path
                    or candidate_session_id == path.stem
                ):
                    session_id = candidate_session_id
                workspace_root = str(source.get("cwd") or source.get("workspace_root") or workspace_root)
                explicit_title = str(source.get("title") or explicit_title)
                session_meta_seen = True
            continue
        if row_type == "message":
            role = str(row.get("role") or "assistant")
            text = _text_from_content(row.get("content") or row.get("message"))
            if item := _message(session_id, role, text, timestamp, role):
                messages.append(item)
            continue
        if row_type == "event_msg":
            payload_type = payload.get("type")
            if payload_type == "user_message":
                if item := _message(session_id, "user", str(payload.get("message") or ""), timestamp, "user_message"):
                    messages.append(item)
            elif payload_type == "agent_message":
                if item := _message(session_id, "assistant", str(payload.get("message") or ""), timestamp, str(payload.get("phase") or "assistant")):
                    messages.append(item)
            elif payload_type == "exec_command_end":
                command = payload.get("command") or payload.get("parsed_cmd") or []
                command_text = " ".join(command) if isinstance(command, list) else str(command)
                exit_code = payload.get("exit_code")
                exit_text = f"\n退出码: {exit_code}" if exit_code is not None else ""
                text = f"执行命令: {command_text}{exit_text}"
                if item := _message(session_id, "system", text, timestamp, "action"):
                    messages.append(item)
            continue
        if row_type == "response_item":
            payload_type = payload.get("type")
            if payload_type == "message" and payload.get("role") == "assistant":
                text = _text_from_content(payload.get("content"))
                if item := _message(session_id, "assistant", text, timestamp, str(payload.get("phase") or "assistant")):
                    messages.append(item)
            elif payload_type == "function_call":
                text = f"调用工具: {payload.get('name') or 'unknown'}\n{payload.get('arguments') or ''}"
                if item := _message(session_id, "system", text, timestamp, "action"):
                    messages.append(item)
            elif payload_type == "function_call_output":
                text = f"工具结果:\n{str(payload.get('output') or '')[:1000]}"
                if item := _message(session_id, "system", text, timestamp, "action"):
                    messages.append(item)

    workspace_root = workspace_root or str(path.parent)
    snapshot = _snapshot(
        session_id=session_id,
        backend="codex",
        workspace_root=workspace_root,
        runtime_session_ref=str(path),
        messages=messages,
        fallback_mtime=fallback_mtime,
        metadata={"source": "codex_jsonl", "path": str(path), "explicit_title": explicit_title},
    )
    if explicit_title and not _is_uuidish(explicit_title):
        snapshot.heuristic_title = explicit_title
        snapshot.display_title = explicit_title
        snapshot.title = explicit_title
    return snapshot


def parse_codex_jsonl(path: Path) -> SessionSnapshot:
    return _cached_session_snapshot(path, "codex", _parse_codex_jsonl_uncached)


def _parse_claude_jsonl_uncached(path: Path, stat: os.stat_result) -> SessionSnapshot:
    rows = _bounded_jsonl_rows(path)
    fallback_mtime = datetime.fromtimestamp(stat.st_mtime)
    session_id = path.stem
    workspace_root = ""
    inferred_workspace_root = _infer_claude_workspace_root_from_path(path)
    messages: list[dict[str, Any]] = []
    explicit_title = ""
    hidden_tool_call_ids: set[str] = set()
    for row in rows:
        timestamp = _timestamp(row.get("timestamp"), fallback_mtime)
        candidate_session_id = str(row.get("sessionId") or row.get("session_id") or "").strip()
        if candidate_session_id:
            session_id = candidate_session_id
        candidate_workspace_root = str(row.get("cwd") or row.get("workspace_root") or "").strip()
        if candidate_workspace_root and not workspace_root:
            workspace_root = candidate_workspace_root
        if row.get("summary"):
            explicit_title = str(row["summary"])
        row_type = row.get("type")
        if row_type in {"assistant", "user"}:
            message_payload = row.get("message") if isinstance(row.get("message"), dict) else {}
            role = str(message_payload.get("role") or row_type)
            content = message_payload.get("content") or row.get("content")
            if isinstance(content, list):
                text_parts: list[str] = []
                for content_item in content:
                    if not isinstance(content_item, dict):
                        text_parts.append(str(content_item))
                        continue
                    item_type = str(content_item.get("type") or "").strip().lower()
                    if item_type == "tool_use":
                        tool_call_id = str(content_item.get("id") or "").strip()
                        if _should_hide_claude_tool_call(content_item):
                            if tool_call_id:
                                hidden_tool_call_ids.add(tool_call_id)
                            continue
                        if item := _message(session_id, "system", _claude_tool_call_text(content_item), timestamp, "action"):
                            item["tool_name"] = str(content_item.get("name") or "").strip()
                            item["tool_call_id"] = tool_call_id
                            messages.append(item)
                        continue
                    if item_type == "tool_result":
                        tool_call_id = str(content_item.get("tool_use_id") or content_item.get("id") or "").strip()
                        if tool_call_id and tool_call_id in hidden_tool_call_ids:
                            continue
                        if item := _message(session_id, "system", _claude_tool_result_text(content_item, row), timestamp, "action"):
                            item["tool_call_id"] = tool_call_id
                            if isinstance(row.get("sourceToolAssistantUUID"), str):
                                item["payload"] = {"source_tool_assistant_uuid": row["sourceToolAssistantUUID"]}
                            messages.append(item)
                        continue
                    if item_type == "thinking":
                        continue
                    text_parts.append(_text_from_content(content_item))
                text = _clean_claude_display_text("\n".join(part for part in text_parts if part))
            else:
                text = _clean_claude_display_text(_text_from_content(content))
            if text and (item := _message(session_id, role, text, timestamp, role)):
                messages.append(item)
        elif row_type == "system" and row.get("subtype") in {"api_error", "stop_hook_summary"}:
            text = _text_from_content(row.get("summary") or row.get("message") or row.get("error") or row.get("cause") or "")
            if item := _message(session_id, "system", text, timestamp, str(row.get("subtype"))):
                messages.append(item)
    normalized_workspace_root = normalize_workspace_root(workspace_root) if workspace_root else ""
    if inferred_workspace_root and normalized_workspace_root:
        inferred_prefix = f"{inferred_workspace_root.casefold()}/"
        if normalized_workspace_root.casefold().startswith(inferred_prefix):
            workspace_root = inferred_workspace_root
    workspace_root = workspace_root or inferred_workspace_root or str(path.parent)
    snapshot = _snapshot(
        session_id=session_id,
        backend="claude",
        workspace_root=workspace_root,
        runtime_session_ref=str(path),
        messages=messages,
        fallback_mtime=fallback_mtime,
        metadata={"source": "claude_jsonl", "path": str(path), "explicit_title": explicit_title},
    )
    if explicit_title and not _is_uuidish(explicit_title):
        snapshot.heuristic_title = explicit_title
        snapshot.display_title = explicit_title
        snapshot.title = explicit_title
    return snapshot


def parse_claude_jsonl(path: Path) -> SessionSnapshot:
    return _cached_session_snapshot(path, "claude", _parse_claude_jsonl_uncached)


def _kimi_root_for_session(session_dir: Path) -> Path | None:
    for parent in session_dir.parents:
        if parent.name == ".kimi":
            return parent
    return None


def _kimi_workspace_from_registry(session_dir: Path, session_id: str) -> tuple[str, str]:
    fallback_hash = session_dir.parent.name
    fallback_root = str(session_dir.parent)
    kimi_root = _kimi_root_for_session(session_dir)
    registry_path = kimi_root / "kimi.json" if kimi_root else None
    if not registry_path or not registry_path.exists():
        return fallback_root, fallback_hash

    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback_root, fallback_hash

    work_dirs = registry.get("work_dirs") if isinstance(registry, dict) else []
    if not isinstance(work_dirs, list):
        return fallback_root, fallback_hash

    session_match = ""
    for item in work_dirs:
        if not isinstance(item, dict):
            continue
        raw_path = item.get("path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            continue
        workdir_hash = hashlib.md5(raw_path.encode()).hexdigest()
        if workdir_hash == fallback_hash:
            return raw_path, workdir_hash
        if item.get("last_session_id") == session_id:
            session_match = raw_path

    if session_match:
        return session_match, fallback_hash
    return fallback_root, fallback_hash


def _parse_kimi_session_uncached(session_dir: Path, stat: Any) -> SessionSnapshot:
    wire_path = session_dir / "wire.jsonl"
    context_path = session_dir / "context.jsonl"
    state_path = session_dir / "state.json"
    stat_path = wire_path if wire_path.exists() else context_path
    stat = stat_path.stat()
    fallback_mtime = datetime.fromtimestamp(stat.st_mtime)
    session_id = session_dir.name
    workspace_root, workdir_hash = _kimi_workspace_from_registry(session_dir, session_id)
    messages: list[dict[str, Any]] = []

    if wire_path.exists():
        for row in _bounded_jsonl_rows(wire_path):
            message = row.get("message") if isinstance(row.get("message"), dict) else {}
            payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
            timestamp = _timestamp(row.get("timestamp"), fallback_mtime)
            if message.get("type") == "TurnBegin":
                text = _text_from_content(payload.get("user_input"))
                if item := _message(session_id, "user", text, timestamp, "user"):
                    messages.append(item)
            elif message.get("type") == "ContentPart" and payload.get("type") == "text":
                if item := _message(session_id, "assistant", str(payload.get("text") or ""), timestamp, "assistant"):
                    messages.append(item)
            elif message.get("type") == "ToolCall":
                text = _kimi_tool_call_text(payload)
                if item := _message(session_id, "system", text, timestamp, "action"):
                    item["tool_name"] = _kimi_tool_name(payload)
                    item["tool_call_id"] = str(payload.get("id") or "")
                    item["payload"] = {"source_type": message.get("type"), "raw": payload}
                    messages.append(item)
            elif message.get("type") == "ToolResult":
                text = _kimi_tool_result_text(payload)
                if item := _message(session_id, "system", text, timestamp, "action"):
                    item["tool_name"] = str(payload.get("sender") or "")
                    item["tool_call_id"] = str(payload.get("tool_call_id") or "")
                    item["payload"] = {"source_type": message.get("type"), "raw": payload}
                    messages.append(item)
            elif message.get("type") == "ApprovalRequest":
                text = _kimi_tool_call_text(payload)
                if item := _message(session_id, "system", text, timestamp, "action"):
                    item["tool_name"] = _kimi_tool_name(payload)
                    item["tool_call_id"] = str(payload.get("tool_call_id") or payload.get("id") or "")
                    item["payload"] = {"source_type": message.get("type"), "raw": payload}
                    messages.append(item)

    if not messages and context_path.exists():
        for row in _bounded_jsonl_rows(context_path):
            role = str(row.get("role") or "")
            if role.startswith("_"):
                continue
            text = _text_from_content(row.get("content"))
            if item := _message(session_id, role or "assistant", text, fallback_mtime, role or "assistant"):
                messages.append(item)

    controls: dict[str, Any] = {}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            approval = state.get("approval") if isinstance(state, dict) else {}
            if isinstance(approval, dict):
                controls["yolo"] = bool(approval.get("yolo"))
            if isinstance(state, dict) and "plan_mode" in state:
                controls["plan_mode"] = bool(state.get("plan_mode"))
        except (OSError, json.JSONDecodeError):
            controls = {}

    return _snapshot(
        session_id=session_id,
        backend="kimi",
        workspace_root=workspace_root,
        runtime_session_ref=str(session_dir),
        messages=messages,
        fallback_mtime=fallback_mtime,
        metadata={"source": "kimi_session", "path": str(session_dir), "workdir_hash": workdir_hash},
        controls=controls,
    )


def parse_kimi_session(session_dir: Path) -> SessionSnapshot:
    kimi_root = _kimi_root_for_session(session_dir)
    related_paths = [
        session_dir / "wire.jsonl",
        session_dir / "context.jsonl",
        session_dir / "state.json",
    ]
    if kimi_root is not None:
        related_paths.append(kimi_root / "kimi.json")
    stat = _combined_cache_stat(related_paths)
    cache_path = next((path for path in related_paths[:2] if path.exists()), session_dir)
    return _cached_session_snapshot(
        cache_path,
        "kimi",
        lambda _cache_path, cache_stat: _parse_kimi_session_uncached(session_dir, cache_stat),
        stat=stat,
    )
