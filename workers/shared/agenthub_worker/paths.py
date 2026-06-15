from __future__ import annotations

import os
import re
from pathlib import Path, PurePosixPath, PureWindowsPath


CLAUDE_WINDOWS_PROJECT_BUCKET_RE = re.compile(r"^(?P<drive>[A-Za-z])--(?P<path>.+)$")


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


def infer_claude_workspace_root_from_runtime_ref(path: str) -> str:
    value = str(path or "").strip()
    if not value:
        return ""
    parts = [part for part in value.replace("\\", "/").split("/") if part]
    try:
        projects_index = next(
            index for index, part in enumerate(parts[:-2]) if part == ".claude" and parts[index + 1] == "projects"
        )
    except StopIteration:
        return ""
    bucket = parts[projects_index + 2]
    if not bucket:
        return ""
    match = CLAUDE_WINDOWS_PROJECT_BUCKET_RE.fullmatch(bucket)
    if match:
        segments = [segment for segment in match.group("path").split("-") if segment]
        if not segments:
            return ""
        return normalize_workspace_root(f"{match.group('drive')}:/{'/'.join(segments)}")
    if "--" in bucket:
        segments = [segment for segment in bucket.split("--") if segment]
        if not segments:
            return ""
        return normalize_workspace_root(f"/{'/'.join(segments)}")
    if bucket.startswith("-"):
        segments = [segment for segment in bucket.split("-") if segment]
        if not segments:
            return ""
        return normalize_workspace_root(f"/{'/'.join(segments)}")
    return ""


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
