from __future__ import annotations

import os
import shutil
from pathlib import Path

from agenthub_worker.discovery import discover_opencode_sessions, parse_claude_jsonl, parse_codex_jsonl, parse_kimi_session, recent_session_files


def _npm_prefixes() -> list[Path]:
    prefixes: list[Path] = []
    configured_prefix = os.getenv("NPM_CONFIG_PREFIX", "").strip()
    if configured_prefix:
        prefixes.append(Path(configured_prefix).expanduser())

    home_value = os.getenv("USERPROFILE", "").strip() or os.getenv("HOME", "").strip()
    if home_value:
        npmrc = Path(home_value) / ".npmrc"
        try:
            lines = npmrc.read_text(encoding="utf-8").splitlines()
        except OSError:
            lines = []
        for raw_line in lines:
            key, separator, value = raw_line.partition("=")
            if separator and key.strip().lower() == "prefix" and value.strip():
                prefixes.append(Path(value.strip()).expanduser())

    appdata = os.getenv("APPDATA", "").strip()
    if appdata:
        prefixes.append(Path(appdata) / "npm")

    unique: list[Path] = []
    seen: set[str] = set()
    for prefix in prefixes:
        key = str(prefix).replace("\\", "/").rstrip("/").lower()
        if key and key not in seen:
            seen.add(key)
            unique.append(prefix)
    return unique


def _command_available(command: str) -> bool:
    if shutil.which(command) is not None:
        return True
    suffixes = (".cmd", ".exe", ".bat", ".ps1", "")
    return any((prefix / f"{command}{suffix}").is_file() for prefix in _npm_prefixes() for suffix in suffixes)


def discover_capabilities() -> dict[str, bool]:
    return {
        "codex": _command_available("codex"),
        "claude": _command_available("claude"),
        "kimi": _command_available("kimi"),
        "opencode": _command_available("opencode"),
        "psmux": _command_available("psmux"),
    }


def discover_sessions(search_roots: list[Path], *, opencode_roots: list[Path] | None = None) -> list[dict]:
    sessions = []
    for backend, path in recent_session_files(search_roots):
        try:
            if backend == "codex":
                sessions.append(parse_codex_jsonl(path).model_dump(mode="json"))
            elif backend == "claude":
                sessions.append(parse_claude_jsonl(path).model_dump(mode="json"))
            elif backend == "kimi":
                sessions.append(parse_kimi_session(path.parent).model_dump(mode="json"))
            elif backend == "opencode":
                continue
        except OSError:
            continue
    sessions.extend(snapshot.model_dump(mode="json") for snapshot in discover_opencode_sessions(opencode_roots or search_roots))
    return sessions
