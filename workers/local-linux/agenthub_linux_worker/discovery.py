from __future__ import annotations

import shutil
from pathlib import Path

from agenthub_worker.discovery import (
    attach_session_publication_marker,
    discover_opencode_sessions,
    parse_claude_jsonl,
    parse_codex_jsonl,
    parse_kimi_session,
    recent_session_files,
    session_publication_candidates,
)


def discover_capabilities() -> dict[str, bool]:
    return {
        "codex": shutil.which("codex") is not None,
        "claude": shutil.which("claude") is not None,
        "kimi": shutil.which("kimi") is not None,
        "opencode": shutil.which("opencode") is not None,
        "tmux": shutil.which("tmux") is not None,
        "file_transfer_v2": True,
    }


def discover_sessions(search_roots: list[Path], *, opencode_roots: list[Path] | None = None) -> list[dict]:
    sessions = []
    session_files = recent_session_files(search_roots)
    for backend, path, marker in session_publication_candidates(session_files):
        try:
            if backend == "codex":
                session = parse_codex_jsonl(path).model_dump(mode="json")
            elif backend == "claude":
                session = parse_claude_jsonl(path).model_dump(mode="json")
            elif backend == "kimi":
                session = parse_kimi_session(path.parent).model_dump(mode="json")
            elif backend == "opencode":
                continue
            else:
                continue
            attach_session_publication_marker(session, backend, path, marker=marker)
            sessions.append(session)
        except OSError:
            continue
    sessions.extend(snapshot.model_dump(mode="json") for snapshot in discover_opencode_sessions(opencode_roots or search_roots))
    return sessions
