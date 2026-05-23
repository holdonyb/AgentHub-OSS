from __future__ import annotations

import os
from pathlib import Path, PurePosixPath, PureWindowsPath


def normalize_workspace_root(path: str) -> str:
    value = path.strip().replace("\\", "/")
    if len(value) >= 2 and value[1] == ":":
        drive = value[0].upper()
        rest = value[2:].lstrip("/")
        return f"{drive}:/{rest}" if rest else f"{drive}:/"
    if value.startswith("/"):
        return str(PurePosixPath(value))
    return value.rstrip("/")


def project_name_from_root(path: str) -> str:
    normalized = normalize_workspace_root(path)
    if len(normalized) >= 2 and normalized[1] == ":":
        return PureWindowsPath(normalized).name or normalized
    return Path(normalized).name or normalized


def default_agent_session_roots(home: str | None = None) -> list[Path]:
    home_value = home or os.getenv("USERPROFILE") or os.getenv("HOME") or str(Path.home())
    home_path = Path(home_value)
    candidates = [
        home_path / ".codex" / "sessions",
        home_path / ".claude" / "projects",
        home_path / ".kimi" / "sessions",
        home_path / ".local" / "share" / "opencode",
    ]
    return [path for path in candidates if path.exists()]
