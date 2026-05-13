from __future__ import annotations

import shutil
from pathlib import Path

from agenthub_worker.discovery import parse_claude_jsonl, parse_codex_jsonl, parse_kimi_session, recent_session_files


def discover_capabilities() -> dict[str, bool]:
    return {
        "codex": shutil.which("codex") is not None,
        "claude": shutil.which("claude") is not None,
        "kimi": shutil.which("kimi") is not None,
        "tmux": shutil.which("tmux") is not None,
    }


def discover_sessions(search_roots: list[Path]) -> list[dict]:
    sessions = []
    for backend, path in recent_session_files(search_roots):
        try:
            if backend == "codex":
                sessions.append(parse_codex_jsonl(path).model_dump(mode="json"))
            elif backend == "claude":
                sessions.append(parse_claude_jsonl(path).model_dump(mode="json"))
            elif backend == "kimi":
                sessions.append(parse_kimi_session(path.parent).model_dump(mode="json"))
        except OSError:
            continue
    return sessions
