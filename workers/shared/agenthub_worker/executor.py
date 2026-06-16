from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import time
from typing import Any

from agenthub_worker.codex_app_server import (
    read_codex_fast_mode,
    resolve_codex_executable,
    run_codex_plan_turn,
    run_codex_turn,
    toggle_codex_fast_mode,
)
from agenthub_worker.discovery import (
    discover_opencode_sessions,
    parse_claude_jsonl,
    parse_codex_jsonl,
    parse_kimi_session,
    recent_session_files,
)
from agenthub_worker.paths import (
    default_agent_session_roots,
    infer_claude_workspace_root_from_runtime_ref,
    normalize_workspace_root,
    project_name_from_root,
)


ALLOWED_SANDBOX = {"read-only", "workspace-write", "danger-full-access"}
ALLOWED_APPROVAL = {"never", "on-request", "on-failure", "untrusted"}
HANDOFF_TIMELINE_TYPES = {"user_message", "assistant_message", "compaction", "error"}
CODEX_CONTEXT_FULL_MARKERS = (
    "ran out of room in the model's context window",
    "context window",
    "上下文已满",
)
DEFAULT_JOB_TIMEOUT_SECONDS = 3600
IMAGE_SUFFIXES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}
MAX_FILE_LIST_ENTRIES = 300
DEFAULT_FILE_READ_BYTES = 200_000
MAX_FILE_READ_BYTES = 5_000_000
MAX_INLINE_FILE_BYTES = 5_000_000
TEXT_WRITEABLE_MIME_TYPES = {
    "application/json",
    "application/javascript",
    "application/typescript",
    "application/xml",
    "text/csv",
    "text/markdown",
    "text/plain",
    "text/xml",
}
CLAUDE_INTERACTIVE_BRIDGE_ENV = "AGENTHUB_CLAUDE_INTERACTIVE_BRIDGE"
CLAUDE_INTERACTIVE_BRIDGE_READY_TEXT = "已送达 Claude 交互会话，等待 transcript 同步"


@dataclass(frozen=True)
class MaterializedAttachment:
    filename: str
    content_type: str
    path: Path
    is_image: bool


def _prompt(job: dict[str, Any]) -> str:
    prompt = str((job.get("payload") or {}).get("prompt", "")).strip()
    if not prompt:
        raise ValueError("session_input prompt cannot be empty")
    return prompt


def _payload(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("payload") or {}
    return payload if isinstance(payload, dict) else {}


def _effective_workspace_root(job: dict[str, Any], payload: dict[str, Any] | None = None) -> str:
    effective = str(job.get("workspace_root") or ".").strip() or "."
    backend = str(job.get("backend") or "").strip().lower()
    if backend != "claude":
        return effective
    runtime_session_ref = str((payload or _payload(job)).get("runtime_session_ref") or "").strip()
    inferred = infer_claude_workspace_root_from_runtime_ref(runtime_session_ref)
    return inferred or effective


def _json_result(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _workspace_root(job: dict[str, Any]) -> Path:
    root = Path(str(job.get("workspace_root") or ".").strip() or ".").resolve()
    if not root.exists() or not root.is_dir():
        raise ValueError("Workspace root is not available")
    return root


def _relative_workspace_path(root: Path, value: Any) -> tuple[Path, str]:
    raw = str(value or ".").replace("\\", "/").strip() or "."
    if raw.startswith("file://"):
        raise ValueError("File URLs are not accepted")
    requested = Path(raw)
    if requested.is_absolute():
        raise ValueError("Requested path must be relative to workspace")
    target = (root / requested).resolve(strict=False)
    try:
        relative = target.relative_to(root)
    except ValueError:
        raise ValueError("Requested path is outside workspace") from None
    relative_text = "." if str(relative) == "." else relative.as_posix()
    return target, relative_text


def _modified_at(path: Path) -> str | None:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except OSError:
        return None


def _execute_file_list(job: dict[str, Any]) -> str:
    payload = _payload(job)
    root = _workspace_root(job)
    target, relative_text = _relative_workspace_path(root, payload.get("path", "."))
    if not target.exists():
        raise ValueError("Directory does not exist")
    if not target.is_dir():
        raise ValueError("Requested path is not a directory")
    entries: list[dict[str, Any]] = []
    truncated = False
    for child in sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold())):
        if len(entries) >= MAX_FILE_LIST_ENTRIES:
            truncated = True
            break
        try:
            stat = child.stat()
        except OSError:
            continue
        _, child_relative = _relative_workspace_path(root, child.relative_to(root).as_posix())
        entries.append(
            {
                "name": child.name,
                "path": child_relative,
                "kind": "directory" if child.is_dir() else "file",
                "size_bytes": None if child.is_dir() else stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            }
        )
    return _json_result(
        {
            "path": relative_text,
            "workspace_root": str(root),
            "entries": entries,
            "truncated": truncated,
        }
    )


def _execute_file_read(job: dict[str, Any]) -> str:
    payload = _payload(job)
    root = _workspace_root(job)
    target, relative_text = _relative_workspace_path(root, payload.get("path"))
    if not target.exists():
        raise ValueError("File does not exist")
    if not target.is_file():
        raise ValueError("Requested path is not a file")
    try:
        max_bytes = int(payload.get("max_bytes", DEFAULT_FILE_READ_BYTES))
    except (TypeError, ValueError):
        max_bytes = DEFAULT_FILE_READ_BYTES
    max_bytes = max(1, min(max_bytes, MAX_FILE_READ_BYTES))
    size_bytes = target.stat().st_size
    data = target.read_bytes()[: max_bytes + 1]
    truncated = size_bytes > max_bytes
    preview = data[:max_bytes]
    content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    base_payload = {
        "path": relative_text,
        "filename": target.name,
        "content_type": content_type,
        "size_bytes": size_bytes,
        "truncated": truncated,
        "modified_at": _modified_at(target),
    }
    inline_downloadable = size_bytes <= min(max_bytes, MAX_INLINE_FILE_BYTES)
    if content_type.startswith("image/"):
        payload = {
            **base_payload,
            "preview_kind": "image",
            "downloadable": inline_downloadable,
        }
        if inline_downloadable:
            payload["data_base64"] = base64.b64encode(preview).decode("ascii")
        return _json_result(payload)
    if b"\x00" in preview[:4096]:
        payload = {
            **base_payload,
            "preview_kind": "download",
            "downloadable": inline_downloadable,
        }
        if inline_downloadable:
            payload["data_base64"] = base64.b64encode(preview).decode("ascii")
        return _json_result(payload)
    return _json_result(
        {
            **base_payload,
            "preview_kind": "text",
            "downloadable": inline_downloadable,
            "text": preview.decode("utf-8", errors="replace"),
            **({"data_base64": base64.b64encode(preview).decode("ascii")} if inline_downloadable else {}),
        }
    )


def _is_probably_text_file(path: Path, content_type: str, sample: bytes) -> bool:
    if content_type.startswith("text/") or content_type in TEXT_WRITEABLE_MIME_TYPES:
        return True
    if path.suffix.lower() in {".md", ".txt", ".log", ".json", ".yml", ".yaml", ".toml", ".ini", ".py", ".ts", ".tsx", ".js", ".jsx", ".css", ".html"}:
        return True
    return b"\x00" not in sample[:4096]


def _execute_file_write(job: dict[str, Any]) -> str:
    payload = _payload(job)
    root = _workspace_root(job)
    target, relative_text = _relative_workspace_path(root, payload.get("path"))
    if not target.exists():
        raise ValueError("File does not exist")
    if not target.is_file():
        raise ValueError("Requested path is not a file")
    expected_modified_at = str(payload.get("expected_modified_at") or "").strip()
    current_modified_at = _modified_at(target)
    if expected_modified_at and current_modified_at and expected_modified_at != current_modified_at:
        raise ValueError("File changed since preview; reload before saving")
    raw_text = payload.get("text")
    if not isinstance(raw_text, str):
        raise ValueError("File write payload requires text")
    existing = target.read_bytes()
    content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if not _is_probably_text_file(target, content_type, existing):
        raise ValueError("Only plain-text files can be edited from AgentHub")
    encoded = raw_text.encode("utf-8")
    target.write_bytes(encoded)
    return _json_result(
        {
            "path": relative_text,
            "filename": target.name,
            "content_type": content_type,
            "size_bytes": len(encoded),
            "truncated": False,
            "preview_kind": "text",
            "downloadable": True,
            "modified_at": _modified_at(target),
            "text": raw_text,
        }
    )


def _controls(job: dict[str, Any]) -> dict[str, Any]:
    payload = _payload(job)
    controls = payload.get("controls") or {}
    return controls if isinstance(controls, dict) else {}


def _claude_interactive_bridge_mode(payload: dict[str, Any]) -> str:
    controls = payload.get("controls") if isinstance(payload.get("controls"), dict) else {}
    raw = str(
        controls.get("interaction_bridge")
        or payload.get("interaction_bridge")
        or os.getenv(CLAUDE_INTERACTIVE_BRIDGE_ENV, "")
    ).strip().lower()
    if raw in {"", "0", "false", "no", "off", "disabled", "none"}:
        return ""
    if raw in {"1", "true", "yes", "on", "enabled", "interactive", "auto"}:
        return "auto"
    return raw


def _supports_tmux_interactive_bridge() -> bool:
    return os.name != "nt" and shutil.which("tmux") is not None


def _supports_psmux_interactive_bridge() -> bool:
    return os.name == "nt" and shutil.which("psmux") is not None


def _resolve_claude_interactive_bridge(payload: dict[str, Any]) -> str:
    mode = _claude_interactive_bridge_mode(payload)
    if mode in {"", "compatibility", "none"}:
        return ""
    if mode == "auto":
        if _supports_tmux_interactive_bridge():
            return "tmux"
        if _supports_psmux_interactive_bridge():
            return "psmux"
        return ""
    if mode == "tmux" and _supports_tmux_interactive_bridge():
        return "tmux"
    if mode == "psmux" and _supports_psmux_interactive_bridge():
        return "psmux"
    return ""


def _model_for_backend(backend: str, controls: dict[str, Any]) -> str:
    model = str(controls.get("model") or "").strip()
    if model:
        return model
    env_prefix = backend.replace("-", "_").upper()
    for name in (f"AGENTHUB_{env_prefix}_MODEL", f"AGENTHUB_{env_prefix}_DEFAULT_MODEL"):
        configured = os.getenv(name, "").strip()
        if configured:
            return configured
    return ""


def _claude_permission_mode(controls: dict[str, Any]) -> str:
    explicit = str(controls.get("permission_mode") or "").strip()
    if explicit:
        return explicit
    legacy = str(controls.get("approval_mode") or "").strip()
    if legacy == "never":
        return "bypassPermissions"
    return ""


def _append_common_workspace(args: list[str], controls: dict[str, Any]) -> None:
    extra_dirs = controls.get("extra_workspace_dirs")
    if isinstance(extra_dirs, list):
        for value in extra_dirs:
            if isinstance(value, str) and value.strip():
                args.extend(["--add-dir", value.strip()])


def _codex_base_args(workspace_root: str, controls: dict[str, Any]) -> list[str]:
    args = ["codex", "-C", workspace_root]
    model = str(controls.get("model") or "").strip()
    if model:
        args.extend(["--model", model])
    if controls.get("yolo"):
        args.append("--dangerously-bypass-approvals-and-sandbox")
        return args
    sandbox = str(controls.get("sandbox_mode") or "").strip()
    if sandbox:
        if sandbox not in ALLOWED_SANDBOX:
            raise ValueError("Unsupported codex sandbox_mode")
        args.extend(["--sandbox", sandbox])
    approval = str(controls.get("approval_mode") or "").strip()
    if approval:
        if approval not in ALLOWED_APPROVAL:
            raise ValueError("Unsupported codex approval_mode")
        args.extend(["--ask-for-approval", approval])
    return args


def build_backend_command(
    job: dict[str, Any],
    *,
    output_file: str | None = None,
    attachment_paths: list[str] | None = None,
) -> list[str]:
    if job.get("kind") != "session_input":
        raise ValueError("Only session_input jobs have backend commands")
    backend = str(job.get("backend") or "").lower()
    session_id = str(job.get("target_session_id") or "").strip()
    payload = _payload(job)
    workspace_root = _effective_workspace_root(job, payload)
    prompt = _prompt(job)
    controls = _controls(job)
    model = _model_for_backend(backend, controls)

    if not session_id:
        raise ValueError("session_input target_session_id is required")

    if backend == "codex":
        args = _codex_base_args(workspace_root, controls)
        args.extend(["exec", "resume", "--skip-git-repo-check"])
        if output_file:
            args.extend(["--output-last-message", output_file])
        for path in attachment_paths or []:
            args.extend(["-i", path])
        args.extend([session_id, prompt])
        return args

    if backend == "claude":
        args = ["claude", "-p", "--resume", session_id]
        if model:
            args.extend(["--model", model])
        permission = _claude_permission_mode(controls)
        if permission:
            args.extend(["--permission-mode", permission])
        args.append(prompt)
        return args

    if backend == "kimi":
        args = ["kimi", "--quiet", "--work-dir", workspace_root, "-S", session_id]
        if model:
            args.extend(["--model", model])
        if controls.get("thinking") is True:
            args.append("--thinking")
        elif controls.get("thinking") is False:
            args.append("--no-thinking")
        if controls.get("yolo"):
            args.append("--yolo")
        agent = str(controls.get("agent") or "").strip()
        if agent:
            args.extend(["--agent", agent])
        _append_common_workspace(args, controls)
        args.extend(["-p", prompt])
        return args

    if backend == "opencode":
        args = ["opencode", "run", "--dir", workspace_root, "--session", session_id]
        if model:
            args.extend(["--model", model])
        if controls.get("yolo"):
            args.append("--dangerously-skip-permissions")
        agent = str(controls.get("agent") or "").strip()
        if agent:
            args.extend(["--agent", agent])
        if output_file:
            args.extend(["--format", "json"])
        for path in attachment_paths or []:
            args.extend(["--file", path])
        args.append(prompt)
        return args

    raise ValueError(f"Unsupported backend: {backend or 'unknown'}")


def build_session_start_command(
    job: dict[str, Any],
    *,
    output_file: str | None = None,
    prompt_override: str | None = None,
) -> list[str]:
    if job.get("kind") not in {"session_start", "session_fork", "session_btw"}:
        raise ValueError("Only session_start, session_fork and session_btw jobs can start backend sessions")
    backend = str(job.get("backend") or "").lower()
    workspace_root = str(job.get("workspace_root") or ".").strip() or "."
    prompt = (prompt_override or _prompt(job)).strip()
    if not prompt:
        raise ValueError("session_start prompt cannot be empty")
    controls = _controls(job)
    model = _model_for_backend(backend, controls)

    if backend == "codex":
        args = _codex_base_args(workspace_root, controls)
        args.extend(["exec", "--skip-git-repo-check"])
        if output_file:
            args.extend(["--output-last-message", output_file])
        args.append(prompt)
        return args

    if backend == "claude":
        args = ["claude", "-p"]
        if model:
            args.extend(["--model", model])
        permission = _claude_permission_mode(controls)
        if permission:
            args.extend(["--permission-mode", permission])
        _append_common_workspace(args, controls)
        args.append(prompt)
        return args

    if backend == "kimi":
        args = ["kimi", "--quiet", "--work-dir", workspace_root]
        if model:
            args.extend(["--model", model])
        if controls.get("thinking") is True:
            args.append("--thinking")
        elif controls.get("thinking") is False:
            args.append("--no-thinking")
        if controls.get("yolo"):
            args.append("--yolo")
        agent = str(controls.get("agent") or "").strip()
        if agent:
            args.extend(["--agent", agent])
        _append_common_workspace(args, controls)
        args.extend(["-p", prompt])
        return args

    if backend == "opencode":
        args = ["opencode", "run", "--dir", workspace_root]
        if model:
            args.extend(["--model", model])
        if controls.get("yolo"):
            args.append("--dangerously-skip-permissions")
        agent = str(controls.get("agent") or "").strip()
        if agent:
            args.extend(["--agent", agent])
        if output_file:
            args.extend(["--format", "json"])
        args.append(prompt)
        return args

    raise ValueError(f"Unsupported backend: {backend or 'unknown'}")


def _truncate_text(value: Any, limit: int = 1400) -> str:
    text = " ".join(str(value or "").split())
    return f"{text[: limit - 3]}..." if len(text) > limit else text


def _handoff_context(job: dict[str, Any]) -> dict[str, Any]:
    payload = _payload(job)
    context = payload.get("handoff_context") or {}
    return context if isinstance(context, dict) else {}


def _build_codex_compact_handoff_prompt(job: dict[str, Any]) -> str:
    context = _handoff_context(job)
    timeline = context.get("timeline") if isinstance(context.get("timeline"), list) else []
    lines = [
        "AgentHub compact handoff",
        "",
        "The previous Codex session could not be resumed because its model context window is full.",
        "Continue in this new non-interactive session using the summarized context below.",
        "",
        f"Original session: {_truncate_text(context.get('session_id') or job.get('target_session_id'), 240)}",
        f"Title: {_truncate_text(context.get('title'), 240)}",
        f"Workspace: {_truncate_text(context.get('workspace_root') or job.get('workspace_root'), 240)}",
        f"Project: {_truncate_text(context.get('project_name'), 160)}",
        f"Activity summary: {_truncate_text(context.get('activity_summary'), 1600)}",
        "",
        "Recent relevant timeline:",
    ]
    kept = 0
    for raw_item in timeline[-12:]:
        if not isinstance(raw_item, dict):
            continue
        item_type = str(raw_item.get("item_type") or "")
        if item_type not in HANDOFF_TIMELINE_TYPES:
            continue
        text = _truncate_text(raw_item.get("text"), 1200)
        if not text:
            continue
        role = _truncate_text(raw_item.get("role") or "system", 40)
        lines.append(f"- {role}/{item_type}: {text}")
        kept += 1
    if kept == 0:
        lines.append("- No clean timeline excerpt is available.")
    lines.extend(
        [
            "",
            "User request to execute now:",
            _prompt(job),
        ]
    )
    return "\n".join(lines)


def build_codex_compact_handoff_command(
    job: dict[str, Any],
    *,
    output_file: str | None = None,
    attachment_paths: list[str] | None = None,
) -> list[str]:
    if str(job.get("backend") or "").lower() != "codex":
        raise ValueError("Only codex jobs support compact handoff")
    workspace_root = str(job.get("workspace_root") or ".").strip() or "."
    args = _codex_base_args(workspace_root, _controls(job))
    args.extend(["exec", "--skip-git-repo-check"])
    if output_file:
        args.extend(["--output-last-message", output_file])
    for path in attachment_paths or []:
        args.extend(["-i", path])
    args.append(_build_codex_compact_handoff_prompt(job))
    return args


def _build_session_fork_prompt(job: dict[str, Any]) -> str:
    context = _handoff_context(job)
    timeline = context.get("timeline") if isinstance(context.get("timeline"), list) else []
    lines = [
        "AgentHub fork handoff",
        "",
        "You are starting a brand-new backend session forked from an existing AgentHub session.",
        "Do not assume you are still inside the old runtime session. Use the bounded context below as reference.",
        "",
        f"Source session: {_truncate_text(context.get('session_id') or job.get('target_session_id'), 240)}",
        f"Source title: {_truncate_text(context.get('title'), 240)}",
        f"Workspace: {_truncate_text(context.get('workspace_root') or job.get('workspace_root'), 240)}",
        f"Project: {_truncate_text(context.get('project_name'), 160)}",
        f"Activity summary: {_truncate_text(context.get('activity_summary'), 1600)}",
        "",
        "Recent relevant timeline:",
    ]
    kept = 0
    for raw_item in timeline[-12:]:
        if not isinstance(raw_item, dict):
            continue
        item_type = str(raw_item.get("item_type") or "")
        if item_type not in HANDOFF_TIMELINE_TYPES:
            continue
        text = _truncate_text(raw_item.get("text"), 1200)
        if not text:
            continue
        role = _truncate_text(raw_item.get("role") or "system", 40)
        lines.append(f"- {role}/{item_type}: {text}")
        kept += 1
    if kept == 0:
        lines.append("- No clean timeline excerpt is available.")
    lines.extend(["", "User request for this new fork:", _prompt(job)])
    return "\n".join(lines)


def _build_session_btw_prompt(job: dict[str, Any]) -> str:
    context = _handoff_context(job)
    timeline = context.get("timeline") if isinstance(context.get("timeline"), list) else []
    lines = [
        "AgentHub BTW side question",
        "",
        "This is a one-shot side question based on an existing AgentHub session.",
        "Do not resume or mutate the source runtime session. Answer the side question only.",
        "",
        f"Source session: {_truncate_text(context.get('session_id') or job.get('target_session_id'), 240)}",
        f"Source title: {_truncate_text(context.get('title'), 240)}",
        f"Workspace: {_truncate_text(context.get('workspace_root') or job.get('workspace_root'), 240)}",
        f"Project: {_truncate_text(context.get('project_name'), 160)}",
        f"Activity summary: {_truncate_text(context.get('activity_summary'), 1600)}",
        "",
        "Recent relevant timeline:",
    ]
    kept = 0
    for raw_item in timeline[-12:]:
        if not isinstance(raw_item, dict):
            continue
        item_type = str(raw_item.get("item_type") or "")
        if item_type not in HANDOFF_TIMELINE_TYPES:
            continue
        text = _truncate_text(raw_item.get("text"), 1200)
        if not text:
            continue
        role = _truncate_text(raw_item.get("role") or "system", 40)
        lines.append(f"- {role}/{item_type}: {text}")
        kept += 1
    if kept == 0:
        lines.append("- No clean timeline excerpt is available.")
    lines.extend(["", "Side question:", _prompt(job)])
    return "\n".join(lines)


def _discover_local_sessions(search_roots: list[Path]) -> list[dict[str, Any]]:
    sessions: list[dict[str, Any]] = []
    seen: set[str] = set()
    for backend, path in recent_session_files(search_roots):
        try:
            if backend == "codex":
                snapshot = parse_codex_jsonl(path)
            elif backend == "claude":
                snapshot = parse_claude_jsonl(path)
            elif backend == "kimi":
                snapshot = parse_kimi_session(path.parent)
            else:
                continue
        except OSError:
            continue
        item = snapshot.model_dump(mode="json")
        session_id = str(item.get("session_id") or "")
        if not session_id or session_id in seen:
            continue
        seen.add(session_id)
        sessions.append(item)
    for snapshot in discover_opencode_sessions(search_roots):
        item = snapshot.model_dump(mode="json")
        session_id = str(item.get("session_id") or "")
        if not session_id or session_id in seen:
            continue
        seen.add(session_id)
        sessions.append(item)
    return sessions


def _session_discovery_roots(workspace_root: str) -> list[Path]:
    roots = [Path(workspace_root)] if workspace_root else []
    for path in default_agent_session_roots():
        if path not in roots:
            roots.append(path)
    return roots


def _session_sort_key(item: dict[str, Any]) -> str:
    return str(item.get("last_activity_at") or item.get("updated_at") or item.get("created_at") or "")


def _select_created_session(
    before: list[dict[str, Any]],
    after: list[dict[str, Any]],
    *,
    backend: str,
    workspace_root: str,
) -> dict[str, Any] | None:
    before_ids = {str(item.get("session_id") or "") for item in before}
    normalized_workspace = normalize_workspace_root(workspace_root).casefold()
    candidates = [
        item
        for item in after
        if str(item.get("session_id") or "") not in before_ids
        and str(item.get("backend") or "").lower() == backend.lower()
        and normalize_workspace_root(str(item.get("workspace_root") or "")).casefold() == normalized_workspace
    ]
    if not candidates:
        return None
    return sorted(candidates, key=_session_sort_key, reverse=True)[0]


def _finalize_created_session(job: dict[str, Any], session: dict[str, Any], *, client: Any | None, worker_id: str) -> str:
    payload = _payload(job)
    session["worker_id"] = worker_id or str(job.get("worker_id") or "")
    session["project_name"] = str(session.get("project_name") or payload.get("project_name") or project_name_from_root(str(job.get("workspace_root") or "")))
    session["namespace"] = str(session.get("namespace") or payload.get("namespace") or job.get("namespace") or "default")
    runtime_metadata = session.get("runtime_metadata") if isinstance(session.get("runtime_metadata"), dict) else {}
    runtime_metadata = dict(runtime_metadata)
    runtime_metadata["created_by_job_id"] = str(job.get("job_id") or "")
    runtime_metadata["created_by_job_kind"] = str(job.get("kind") or "")
    if job.get("kind") == "session_fork":
        runtime_metadata["forked_from_session_id"] = str(payload.get("source_session_id") or job.get("target_session_id") or "")
        runtime_metadata["forked_from_title"] = str(payload.get("source_title") or "")
        runtime_metadata["forked_by_job_id"] = str(job.get("job_id") or "")
    session["runtime_metadata"] = runtime_metadata
    title = str(payload.get("title") or "").strip()
    if title:
        session["custom_title"] = title
        session["display_title"] = title
        session["title"] = title
    if client is not None and hasattr(client, "publish_sessions"):
        client.publish_sessions([session])
    return str(session.get("session_id") or "")


def _execute_session_start(job: dict[str, Any], *, client: Any | None, worker_id: str) -> str:
    backend = str(job.get("backend") or "").lower()
    workspace_root = str(job.get("workspace_root") or ".").strip() or "."
    payload = _payload(job)
    output_file: str | None = None
    if backend == "codex" and not payload.get("dry_run"):
        fd, output_file = tempfile.mkstemp(prefix="agenthub-codex-start-", suffix=".txt")
        os.close(fd)
    prompt_override = _build_session_fork_prompt(job) if job.get("kind") == "session_fork" else None
    try:
        bridge_mode = _resolve_claude_interactive_bridge(payload)
        if backend == "claude" and bridge_mode:
            if payload.get("dry_run"):
                return f"dry_run: claude interactive bridge ({bridge_mode}) start {_truncate_text(prompt_override or _prompt(job), 240)}"
            roots = _session_discovery_roots(workspace_root)
            before = _discover_local_sessions(roots)
            process_env = _backend_process_env(job, {})
            session_name = _claude_interactive_job_session_name(job)
            _start_interactive_command_session(
                session_name,
                _claude_interactive_start_args(job),
                workspace_root,
                process_env,
                bridge_mode,
            )
            _paste_prompt_into_interactive_bridge(
                session_name=session_name,
                prompt=(prompt_override or _prompt(job)).strip(),
                cwd=workspace_root,
                env=process_env,
                bridge_mode=bridge_mode,
            )
            created = _poll_created_session(
                before,
                roots=roots,
                backend=backend,
                workspace_root=workspace_root,
                timeout_seconds=_job_timeout_seconds(payload),
            )
            if created is None:
                raise RuntimeError("Claude interactive bridge submitted the prompt but no new session was discovered")
            created_session_id = _finalize_created_session(job, created, client=client, worker_id=worker_id)
            return f"created_session_id={created_session_id}\n{CLAUDE_INTERACTIVE_BRIDGE_READY_TEXT}（{bridge_mode}:{session_name}）"
        args = build_session_start_command(job, output_file=output_file, prompt_override=prompt_override)
        timeout_seconds = _job_timeout_seconds(payload)
        if payload.get("dry_run"):
            return f"dry_run: {_format_command(args)}"
        roots = _session_discovery_roots(workspace_root)
        before = _discover_local_sessions(roots)
        cli_output = _run_backend_command(args, workspace_root, timeout_seconds, output_file=output_file)
        created = _poll_created_session(
            before,
            roots=roots,
            backend=backend,
            workspace_root=workspace_root,
            timeout_seconds=timeout_seconds,
        )
        if created is None:
            detail = cli_output.strip()
            suffix = f": {detail[:2000]}" if detail else ""
            raise RuntimeError(f"Backend CLI completed but no new session was discovered{suffix}")
        created_session_id = _finalize_created_session(job, created, client=client, worker_id=worker_id)
        return f"created_session_id={created_session_id}\n{cli_output}".strip()
    finally:
        if output_file:
            Path(output_file).unlink(missing_ok=True)


def _execute_session_btw(job: dict[str, Any], *, client: Any | None) -> str:
    backend = str(job.get("backend") or "").lower()
    workspace_root = str(job.get("workspace_root") or ".").strip() or "."
    payload = _payload(job)
    output_file: str | None = None
    if backend == "codex" and not payload.get("dry_run"):
        fd, output_file = tempfile.mkstemp(prefix="agenthub-codex-btw-", suffix=".txt")
        os.close(fd)
    secret_env = _resolve_job_secrets(client, job, payload)
    try:
        bridge_mode = _resolve_claude_interactive_bridge(payload)
        if backend == "claude" and bridge_mode:
            if payload.get("dry_run"):
                return f"dry_run: claude interactive bridge ({bridge_mode}) btw {_truncate_text(_prompt(job), 240)}"
            roots = _session_discovery_roots(workspace_root)
            before = _discover_local_sessions(roots)
            process_env = _backend_process_env(job, secret_env)
            session_name = _claude_interactive_job_session_name(job)
            created_session: dict[str, Any] | None = None
            try:
                _start_interactive_command_session(
                    session_name,
                    _claude_interactive_start_args(job),
                    workspace_root,
                    process_env,
                    bridge_mode,
                )
                _paste_prompt_into_interactive_bridge(
                    session_name=session_name,
                    prompt=_build_session_btw_prompt(job),
                    cwd=workspace_root,
                    env=process_env,
                    bridge_mode=bridge_mode,
                )
                created_session = _poll_created_session(
                    before,
                    roots=roots,
                    backend=backend,
                    workspace_root=workspace_root,
                    timeout_seconds=_job_timeout_seconds(payload),
                )
                if created_session is None:
                    raise RuntimeError("Claude interactive bridge submitted the BTW prompt but no sidecar session was discovered")
                _, result_text = _poll_session_result_text(
                    str(created_session.get("session_id") or ""),
                    roots=roots,
                    timeout_seconds=_job_timeout_seconds(payload),
                )
                if not result_text.strip():
                    raise RuntimeError("Claude interactive bridge sidecar session did not produce a readable assistant result")
                return result_text
            finally:
                _kill_interactive_session(session_name, workspace_root, process_env, bridge_mode)
                _cleanup_claude_sidecar_runtime(created_session)
        args = build_session_start_command(job, output_file=output_file, prompt_override=_build_session_btw_prompt(job))
        timeout_seconds = _job_timeout_seconds(payload)
        process_env = _backend_process_env(job, secret_env)
        if payload.get("dry_run"):
            return f"dry_run: {_format_command(args)}"
        if process_env:
            return _run_backend_command(args, workspace_root, timeout_seconds, output_file=output_file, env=process_env)
        return _run_backend_command(args, workspace_root, timeout_seconds, output_file=output_file)
    finally:
        if output_file:
            Path(output_file).unlink(missing_ok=True)


def _provider_handoff_command(backend: str, action: str) -> list[str]:
    if backend == "codex":
        return ["codex", "login"] if action == "login" else ["codex", "logout"]
    if backend == "claude":
        return ["claude", "auth", "login"] if action == "login" else ["claude", "auth", "logout"]
    if backend == "kimi":
        return ["kimi", "login"] if action == "login" else ["kimi", "logout"]
    if backend == "opencode":
        return ["opencode", "auth", "login"] if action == "login" else ["opencode", "auth", "logout"]
    raise ValueError(f"Unsupported backend: {backend or 'unknown'}")


def _execute_provider_auth(job: dict[str, Any], action: str) -> str:
    backend = str(job.get("backend") or _payload(job).get("backend") or "").lower()
    args = _provider_handoff_command(backend, action)
    if _payload(job).get("dry_run"):
        return f"dry_run: {_format_command(args)}"
    if action == "login":
        return f"请在 worker 本机运行：{_format_command(args)}。完成后刷新 Provider 状态。"
    timeout_seconds = _job_timeout_seconds(_payload(job))
    return _run_backend_command(args, str(job.get("workspace_root") or "."), timeout_seconds)


def _format_command(args: list[str]) -> str:
    return " ".join(shlex.quote(arg) for arg in args)


def _run_control_command(
    args: list[str],
    cwd: str,
    timeout_seconds: int,
    *,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    executable = shutil.which(args[0])
    if executable is None:
        raise RuntimeError(f"Control command not found: {args[0]}")
    completed = subprocess.run(
        [executable, *args[1:]],
        cwd=cwd if cwd and os.path.isdir(cwd) else None,
        env={**os.environ, **env} if env else None,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout_seconds,
        check=False,
    )
    return completed


def _read_output_file(output_file: str | None) -> str:
    if not output_file:
        return ""
    path = Path(output_file)
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8", errors="replace").strip()


def _combined_process_output(completed: subprocess.CompletedProcess[str]) -> str:
    parts = [
        part.strip()
        for part in (completed.stdout, completed.stderr)
        if isinstance(part, str) and part.strip()
    ]
    return "\n".join(parts).strip()


def _looks_like_backend_auth_error(output: str) -> bool:
    lowered = output.lower()
    return (
        "invalid x-api-key" in lowered
        or "invalid api key" in lowered
        or "authentication failed" in lowered
        or "unauthorized" in lowered and "api" in lowered
    )


def _format_backend_failure(command_name: str, returncode: int, output: str, captured_file_output: str) -> str:
    detail = (output or captured_file_output).strip()
    if "ran out of room in the model's context window" in detail:
        detail = f"Codex session 上下文已满，需要新开会话或压缩历史后再继续 resume。\n{detail}"
    if not detail:
        detail = "CLI exited without diagnostics"
    return f"{command_name} exited {returncode}: {detail[:2000]}"


def _is_codex_context_full_error(message: str) -> bool:
    lowered = message.lower()
    return "codex" in lowered and all(marker not in lowered for marker in ("backend cli not found",)) and any(
        marker in lowered for marker in CODEX_CONTEXT_FULL_MARKERS
    )


def _is_codex_native_plan_fallback_error(message: str) -> bool:
    lowered = message.lower()
    if "timed out waiting for agenthub user input" in lowered:
        return False
    if "user denied codex plan input request" in lowered:
        return False
    return (
        "codex app-server" in lowered
        or "responsestreamdisconnected" in lowered
        or "willretry" in lowered
        or _is_codex_native_resume_fallback_error(lowered)
    )


def _is_codex_native_default_fallback_error(message: str) -> bool:
    lowered = message.lower()
    return (
        _is_codex_native_resume_fallback_error(lowered)
        or (
            "codex app-server thread/resume failed" in lowered
            and "failed to load configuration" in lowered
            and "model provider" in lowered
        )
    )


def _is_codex_native_resume_fallback_error(message: str) -> bool:
    lowered = message.lower()
    if "codex app-server thread/resume failed" not in lowered:
        return False
    return any(
        marker in lowered
        for marker in (
            "invalid thread id",
            "thread not found",
            "invalid character: expected an optional prefix of `urn:uuid:`",
        )
    )


def _build_codex_native_plan_fallback_prompt(job: dict[str, Any]) -> str:
    payload = _payload(job)
    raw_prompt = str(payload.get("raw_prompt") or payload.get("prompt") or "").strip()
    return (
        "AgentHub native plan fallback.\n"
        "The Codex app-server plan channel failed before AgentHub could receive a stable plan. "
        "Stay in planning mode behavior for this turn: do not edit files, do not run write commands, "
        "and provide a concise implementation plan with risks and next-step options.\n\n"
        f"User request:\n{raw_prompt}"
    )


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            process.kill()
        return
    process.kill()


def _run_backend_command(
    args: list[str],
    cwd: str,
    timeout_seconds: int,
    *,
    output_file: str | None = None,
    env: dict[str, str] | None = None,
) -> str:
    executable = resolve_codex_executable() if args[0] == "codex" else shutil.which(args[0])
    if executable is None:
        raise RuntimeError(f"Backend CLI not found: {args[0]}")
    run_args = [executable, *args[1:]]
    process = subprocess.Popen(
        run_args,
        cwd=cwd if cwd and os.path.isdir(cwd) else None,
        env={**os.environ, **env} if env else None,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        _terminate_process_tree(process)
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            stdout, stderr = "", ""
        captured_file_output = _read_output_file(output_file)
        output = _combined_process_output(subprocess.CompletedProcess(run_args, process.returncode or -1, stdout, stderr))
        detail = (output or captured_file_output).strip()
        suffix = f": {detail[:2000]}" if detail else ""
        raise RuntimeError(f"{args[0]} timed out after {timeout_seconds} seconds{suffix}") from exc
    completed = subprocess.CompletedProcess(run_args, process.returncode or 0, stdout, stderr)
    captured_file_output = _read_output_file(output_file)
    output = _combined_process_output(completed)
    if completed.returncode != 0:
        raise RuntimeError(_format_backend_failure(args[0], completed.returncode, output, captured_file_output))
    if _looks_like_backend_auth_error(output or captured_file_output):
        raise RuntimeError(_format_backend_failure(args[0], completed.returncode, output, captured_file_output))
    return captured_file_output or output or "已送达后端 CLI，等待 transcript 同步"


def _job_timeout_seconds(payload: dict[str, Any]) -> int:
    raw_value = payload.get("timeout_seconds") or os.getenv("AGENTHUB_JOB_TIMEOUT_SECONDS")
    try:
        return max(60, int(raw_value)) if raw_value is not None else DEFAULT_JOB_TIMEOUT_SECONDS
    except (TypeError, ValueError):
        return DEFAULT_JOB_TIMEOUT_SECONDS


def _resolve_job_secrets(client: Any | None, job: dict[str, Any], payload: dict[str, Any]) -> dict[str, str]:
    controls = payload.get("controls") if isinstance(payload.get("controls"), dict) else {}
    refs = controls.get("secret_refs") if isinstance(controls, dict) else None
    if not isinstance(refs, list):
        return {}
    names = [str(ref).strip().upper() for ref in refs if str(ref).strip()]
    if not names:
        return {}
    if client is None or not hasattr(client, "resolve_secrets"):
        raise RuntimeError("Secret refs require an AgentHub control-plane connection")
    job_id = str(job.get("job_id") or "").strip()
    if not job_id:
        raise RuntimeError("Secret refs require a job_id")
    environment = str(controls.get("secret_environment") or payload.get("secret_environment") or "default").strip() or "default"
    namespace = str(controls.get("secret_namespace") or payload.get("secret_namespace") or payload.get("namespace") or "default").strip() or "default"
    resolved = client.resolve_secrets(names, environment=environment, namespace=namespace, job_id=job_id)
    env = {str(key).upper(): str(value) for key, value in resolved.items() if str(key).strip() and isinstance(value, str)}
    missing = sorted(set(names) - set(env.keys()))
    if missing:
        raise RuntimeError(f"Missing AgentHub secret(s): {', '.join(missing)}")
    return env


def _backend_process_env(job: dict[str, Any], secret_env: dict[str, str]) -> dict[str, str] | None:
    backend = str(job.get("backend") or "").lower()
    if backend != "claude":
        return secret_env or None
    merged = dict(secret_env)
    if "ANTHROPIC_API_KEY" not in merged and str(os.getenv("ANTHROPIC_API_KEY") or "").strip():
        # Claude CLI should use the machine's interactive claude.ai subscription
        # unless AgentHub explicitly injects an API key for this job.
        merged["ANTHROPIC_API_KEY"] = ""
    return merged or None


def _safe_attachment_filename(value: Any) -> str:
    filename = str(value or "attachment.bin").replace("\\", "/").split("/")[-1].strip().strip(".")
    return filename[:180] or "attachment.bin"


def _attachment_suffix(filename: str, content_type: str) -> str:
    if content_type in IMAGE_SUFFIXES:
        return IMAGE_SUFFIXES[content_type]
    suffix = Path(filename).suffix.lower()
    if suffix and len(suffix) <= 16 and all(char.isalnum() or char in {".", "_", "-"} for char in suffix):
        return suffix
    return ".bin"


def _is_valid_image_data(content_type: str, data: bytes) -> bool:
    if content_type == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if content_type == "image/webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    if content_type == "image/gif":
        return data.startswith((b"GIF87a", b"GIF89a"))
    return False


def _materialize_attachments(payload: dict[str, Any]) -> list[MaterializedAttachment]:
    attachments = payload.get("attachments")
    if not isinstance(attachments, list) or not attachments:
        return []
    materialized: list[MaterializedAttachment] = []
    try:
        for attachment in attachments:
            if not isinstance(attachment, dict):
                continue
            content_type = str(attachment.get("content_type") or "").split(";", 1)[0].strip().lower()
            data_base64 = attachment.get("data_base64")
            if not content_type or not isinstance(data_base64, str):
                continue
            try:
                data = base64.b64decode(data_base64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValueError("Invalid attachment data") from exc
            if not data:
                continue
            filename = _safe_attachment_filename(attachment.get("filename"))
            is_image = content_type in IMAGE_SUFFIXES
            if is_image and not _is_valid_image_data(content_type, data):
                raise ValueError("Invalid image attachment data")
            fd, path = tempfile.mkstemp(
                prefix="agenthub-image-" if is_image else "agenthub-attachment-",
                suffix=_attachment_suffix(filename, content_type),
            )
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            materialized.append(
                MaterializedAttachment(
                    filename=filename,
                    content_type=content_type,
                    path=Path(path),
                    is_image=is_image,
                )
            )
    except Exception:
        for item in materialized:
            item.path.unlink(missing_ok=True)
        raise
    return materialized


def _job_with_attachment_context(job: dict[str, Any], attachments: list[MaterializedAttachment]) -> dict[str, Any]:
    context_attachments = [attachment for attachment in attachments if not attachment.is_image]
    if not context_attachments:
        return job
    payload = dict(_payload(job))
    lines = [
        "",
        "",
        "[AgentHub attachments]",
        "The user uploaded the following file(s). Use these local paths while answering this turn:",
    ]
    for attachment in context_attachments:
        lines.append(f"- {attachment.filename} ({attachment.content_type}): {attachment.path}")
    payload["prompt"] = f"{_prompt(job)}\n" + "\n".join(lines)
    next_job = dict(job)
    next_job["payload"] = payload
    return next_job


def _claude_interactive_session_name(session_id: str) -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", session_id.strip().lower()).strip("-")[:24] or "session"
    digest = hashlib.sha1(session_id.encode("utf-8", errors="replace")).hexdigest()[:10]
    return f"ah-claude-{slug}-{digest}"[:48]


def _claude_interactive_job_session_name(job: dict[str, Any]) -> str:
    token = str(job.get("job_id") or job.get("kind") or "job")
    slug = re.sub(r"[^a-z0-9_-]+", "-", token.strip().lower()).strip("-")[:24] or "job"
    digest = hashlib.sha1(token.encode("utf-8", errors="replace")).hexdigest()[:10]
    return f"ah-claude-{slug}-{digest}"[:48]


def _claude_interactive_start_args(job: dict[str, Any]) -> list[str]:
    controls = _controls(job)
    model = _model_for_backend("claude", controls)
    args = ["claude"]
    if model:
        args.extend(["--model", model])
    permission = _claude_permission_mode(controls)
    if permission:
        args.extend(["--permission-mode", permission])
    return args


def _claude_tmux_session_exists(session_name: str, cwd: str, env: dict[str, str] | None) -> bool:
    completed = _run_control_command(["tmux", "has-session", "-t", session_name], cwd, 15, env=env)
    return completed.returncode == 0


def _claude_psmux_session_exists(session_name: str, cwd: str, env: dict[str, str] | None) -> bool:
    completed = _run_control_command(["psmux", "has-session", "-t", session_name], cwd, 15, env=env)
    return completed.returncode == 0


def _start_tmux_command_session(
    session_name: str,
    command_args: list[str],
    cwd: str,
    env: dict[str, str] | None,
) -> None:
    completed = _run_control_command(
        ["tmux", "new-session", "-d", "-s", session_name, "-c", cwd, *command_args],
        cwd,
        30,
        env=env,
    )
    if completed.returncode != 0:
        detail = _combined_process_output(completed) or "tmux new-session failed without diagnostics"
        raise RuntimeError(f"claude interactive bridge failed to start tmux session: {detail[:2000]}")
    time.sleep(0.35)


def _powershell_literal(value: str) -> str:
    return value.replace("'", "''")


def _build_psmux_shell_command(command_args: list[str], cwd: str) -> list[str]:
    command_text = _format_command(command_args)
    script = f"Set-Location -LiteralPath '{_powershell_literal(cwd)}'; & {command_text}"
    return ["powershell", "-NoLogo", "-NoProfile", "-NoExit", "-Command", script]


def _start_psmux_command_session(
    session_name: str,
    command_args: list[str],
    cwd: str,
    env: dict[str, str] | None,
) -> None:
    completed = _run_control_command(
        ["psmux", "new-session", "-d", "-s", session_name, "--", *_build_psmux_shell_command(command_args, cwd)],
        cwd,
        30,
        env=env,
    )
    if completed.returncode != 0:
        detail = _combined_process_output(completed) or "psmux new-session failed without diagnostics"
        raise RuntimeError(f"claude interactive bridge failed to start psmux session: {detail[:2000]}")
    time.sleep(0.35)


def _psmux_primary_pane_id(session_name: str, cwd: str, env: dict[str, str] | None) -> str:
    completed = _run_control_command(["psmux", "list-panes", "-t", session_name], cwd, 15, env=env)
    if completed.returncode != 0:
        detail = _combined_process_output(completed) or "psmux list-panes failed without diagnostics"
        raise RuntimeError(f"claude interactive bridge failed to inspect psmux panes: {detail[:2000]}")
    match = re.search(r"(%\d+)", completed.stdout or "")
    if not match:
        raise RuntimeError("claude interactive bridge could not locate the active psmux pane")
    return match.group(1)


def _paste_prompt_into_tmux(
    *,
    session_name: str,
    prompt: str,
    cwd: str,
    env: dict[str, str] | None,
) -> None:
    buffer_name = f"agenthub-{hashlib.sha1(f'{session_name}:{prompt}'.encode('utf-8', errors='replace')).hexdigest()[:12]}"
    fd, prompt_file = tempfile.mkstemp(prefix="agenthub-claude-bridge-", suffix=".txt")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(prompt)
        load = _run_control_command(["tmux", "load-buffer", "-b", buffer_name, prompt_file], cwd, 15, env=env)
        if load.returncode != 0:
            detail = _combined_process_output(load) or "tmux load-buffer failed without diagnostics"
            raise RuntimeError(f"claude interactive bridge failed to stage prompt: {detail[:2000]}")
        paste = _run_control_command(["tmux", "paste-buffer", "-d", "-b", buffer_name, "-t", session_name], cwd, 15, env=env)
        if paste.returncode != 0:
            detail = _combined_process_output(paste) or "tmux paste-buffer failed without diagnostics"
            raise RuntimeError(f"claude interactive bridge failed to paste prompt: {detail[:2000]}")
        send = _run_control_command(["tmux", "send-keys", "-t", session_name, "Enter"], cwd, 15, env=env)
        if send.returncode != 0:
            detail = _combined_process_output(send) or "tmux send-keys failed without diagnostics"
            raise RuntimeError(f"claude interactive bridge failed to submit prompt: {detail[:2000]}")
    finally:
        Path(prompt_file).unlink(missing_ok=True)
        try:
            _run_control_command(["tmux", "delete-buffer", "-b", buffer_name], cwd, 15, env=env)
        except RuntimeError:
            pass


def _paste_prompt_into_psmux(
    *,
    session_name: str,
    prompt: str,
    cwd: str,
    env: dict[str, str] | None,
) -> None:
    fd, prompt_file = tempfile.mkstemp(prefix="agenthub-claude-bridge-", suffix=".txt")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(prompt)
        pane_id = _psmux_primary_pane_id(session_name, cwd, env)
        load = _run_control_command(["psmux", "load-buffer", prompt_file], cwd, 15, env=env)
        if load.returncode != 0:
            detail = _combined_process_output(load) or "psmux load-buffer failed without diagnostics"
            raise RuntimeError(f"claude interactive bridge failed to stage prompt: {detail[:2000]}")
        paste = _run_control_command(["psmux", "paste-buffer", "-t", pane_id], cwd, 15, env=env)
        if paste.returncode != 0:
            detail = _combined_process_output(paste) or "psmux paste-buffer failed without diagnostics"
            raise RuntimeError(f"claude interactive bridge failed to paste prompt: {detail[:2000]}")
        send = _run_control_command(["psmux", "send-keys", "-t", pane_id, "Enter"], cwd, 15, env=env)
        if send.returncode != 0:
            detail = _combined_process_output(send) or "psmux send-keys failed without diagnostics"
            raise RuntimeError(f"claude interactive bridge failed to submit prompt: {detail[:2000]}")
    finally:
        Path(prompt_file).unlink(missing_ok=True)
        try:
            _run_control_command(["psmux", "delete-buffer"], cwd, 15, env=env)
        except RuntimeError:
            pass


def _claude_interactive_session_exists(session_name: str, cwd: str, env: dict[str, str] | None, bridge_mode: str) -> bool:
    if bridge_mode == "tmux":
        return _claude_tmux_session_exists(session_name, cwd, env)
    if bridge_mode == "psmux":
        return _claude_psmux_session_exists(session_name, cwd, env)
    raise RuntimeError(f"Unsupported Claude interactive bridge: {bridge_mode}")


def _start_interactive_command_session(
    session_name: str,
    command_args: list[str],
    cwd: str,
    env: dict[str, str] | None,
    bridge_mode: str,
) -> None:
    if bridge_mode == "tmux":
        _start_tmux_command_session(session_name, command_args, cwd, env)
        return
    if bridge_mode == "psmux":
        _start_psmux_command_session(session_name, command_args, cwd, env)
        return
    raise RuntimeError(f"Unsupported Claude interactive bridge: {bridge_mode}")


def _paste_prompt_into_interactive_bridge(
    *,
    session_name: str,
    prompt: str,
    cwd: str,
    env: dict[str, str] | None,
    bridge_mode: str,
) -> None:
    if bridge_mode == "tmux":
        _paste_prompt_into_tmux(session_name=session_name, prompt=prompt, cwd=cwd, env=env)
        return
    if bridge_mode == "psmux":
        _paste_prompt_into_psmux(session_name=session_name, prompt=prompt, cwd=cwd, env=env)
        return
    raise RuntimeError(f"Unsupported Claude interactive bridge: {bridge_mode}")


def _poll_created_session(
    before: list[dict[str, Any]],
    *,
    roots: list[Path],
    backend: str,
    workspace_root: str,
    timeout_seconds: int,
) -> dict[str, Any] | None:
    deadline = time.monotonic() + max(2.0, min(float(timeout_seconds), 20.0))
    while time.monotonic() < deadline:
        after = _discover_local_sessions(roots)
        created = _select_created_session(before, after, backend=backend, workspace_root=workspace_root)
        if created is not None:
            return created
        time.sleep(0.5)
    return None


def _latest_assistant_text(session: dict[str, Any]) -> str:
    runtime_metadata = session.get("runtime_metadata") if isinstance(session.get("runtime_metadata"), dict) else {}
    messages = runtime_metadata.get("messages") if isinstance(runtime_metadata, dict) else None
    if isinstance(messages, list):
        for item in reversed(messages):
            if not isinstance(item, dict):
                continue
            if str(item.get("role") or "").strip().lower() != "assistant":
                continue
            text = str(item.get("text") or "").strip()
            if text:
                return text
    return str(session.get("last_message") or "").strip()


def _poll_session_result_text(
    session_id: str,
    *,
    roots: list[Path],
    timeout_seconds: int,
) -> tuple[dict[str, Any] | None, str]:
    deadline = time.monotonic() + max(3.0, min(float(timeout_seconds), 45.0))
    last_text = ""
    stable_reads = 0
    last_session: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        current = next((item for item in _discover_local_sessions(roots) if str(item.get("session_id") or "") == session_id), None)
        if current is not None:
            last_session = current
            text = _latest_assistant_text(current)
            if text:
                stable_reads = stable_reads + 1 if text == last_text else 1
                last_text = text
                status = str(current.get("status") or "").strip().lower()
                if stable_reads >= 2 or status in {"ready", "needs_reply", "failed", "terminated"}:
                    return current, text
        time.sleep(0.75)
    return last_session, last_text


def _kill_tmux_session(session_name: str, cwd: str, env: dict[str, str] | None) -> None:
    try:
        _run_control_command(["tmux", "kill-session", "-t", session_name], cwd, 15, env=env)
    except RuntimeError:
        pass


def _kill_psmux_session(session_name: str, cwd: str, env: dict[str, str] | None) -> None:
    try:
        _run_control_command(["psmux", "kill-session", "-t", session_name], cwd, 15, env=env)
    except RuntimeError:
        pass


def _kill_interactive_session(session_name: str, cwd: str, env: dict[str, str] | None, bridge_mode: str) -> None:
    if bridge_mode == "tmux":
        _kill_tmux_session(session_name, cwd, env)
        return
    if bridge_mode == "psmux":
        _kill_psmux_session(session_name, cwd, env)
        return


def _cleanup_claude_sidecar_runtime(session: dict[str, Any] | None) -> None:
    if not isinstance(session, dict):
        return
    runtime_ref = str(session.get("runtime_session_ref") or "").strip()
    if not runtime_ref:
        return
    try:
        path = Path(runtime_ref)
        if path.is_file():
            path.unlink(missing_ok=True)
    except OSError:
        return


def _execute_claude_interactive_bridge(job: dict[str, Any], payload: dict[str, Any], secret_env: dict[str, str]) -> str:
    bridge_mode = _resolve_claude_interactive_bridge(payload)
    if not bridge_mode:
        raise RuntimeError("claude interactive bridge is not available on this worker")
    workspace_root = _effective_workspace_root(job, payload)
    session_id = str(job.get("target_session_id") or "").strip()
    if not session_id:
        raise ValueError("session_input target_session_id is required")
    process_env = _backend_process_env(job, secret_env)
    session_name = _claude_interactive_session_name(session_id)
    if not _claude_interactive_session_exists(session_name, workspace_root, process_env, bridge_mode):
        _start_interactive_command_session(
            session_name,
            ["claude", "--resume", session_id],
            workspace_root,
            process_env,
            bridge_mode,
        )
    _paste_prompt_into_interactive_bridge(
        session_name=session_name,
        prompt=_prompt(job),
        cwd=workspace_root,
        env=process_env,
        bridge_mode=bridge_mode,
    )
    return f"{CLAUDE_INTERACTIVE_BRIDGE_READY_TEXT}（{bridge_mode}:{session_name}）"


def _execute_codex_native_plan_cli_fallback(job: dict[str, Any], payload: dict[str, Any]) -> str:
    fallback_payload = dict(payload)
    fallback_payload["prompt"] = _build_codex_native_plan_fallback_prompt(job)
    fallback_job = dict(job)
    fallback_job["payload"] = fallback_payload
    output_file: str | None = None
    fd, output_file = tempfile.mkstemp(prefix="agenthub-codex-plan-fallback-", suffix=".txt")
    os.close(fd)
    attachments: list[MaterializedAttachment] = []
    try:
        attachments = _materialize_attachments(payload)
        fallback_job = _job_with_attachment_context(fallback_job, attachments)
        image_paths = [str(attachment.path) for attachment in attachments if attachment.is_image]
        args = build_backend_command(fallback_job, output_file=output_file, attachment_paths=image_paths)
        return _run_backend_command(
            args,
            str(job.get("workspace_root") or "."),
            _job_timeout_seconds(payload),
            output_file=output_file,
        )
    finally:
        for attachment in attachments:
            attachment.path.unlink(missing_ok=True)
        if output_file:
            Path(output_file).unlink(missing_ok=True)


def _execute_session_input_cli(job: dict[str, Any], payload: dict[str, Any], secret_env: dict[str, str]) -> str:
    backend = str(job.get("backend") or "").lower()
    workspace_root = _effective_workspace_root(job, payload)
    output_file: str | None = None
    if backend == "codex" and not payload.get("dry_run"):
        fd, output_file = tempfile.mkstemp(prefix="agenthub-codex-", suffix=".txt")
        os.close(fd)
    attachments: list[MaterializedAttachment] = []
    try:
        attachments = _materialize_attachments(payload)
        job_for_command = _job_with_attachment_context(job, attachments)
        job_for_command["workspace_root"] = workspace_root
        if (
            backend == "claude"
            and _resolve_claude_interactive_bridge(payload)
            and all(not attachment.is_image for attachment in attachments)
        ):
            if payload.get("dry_run"):
                bridge_mode = _resolve_claude_interactive_bridge(payload)
                return f"dry_run: claude interactive bridge ({bridge_mode}) --resume {job.get('target_session_id')}"
            return _execute_claude_interactive_bridge(job_for_command, _payload(job_for_command), secret_env)
        image_paths = [str(attachment.path) for attachment in attachments if attachment.is_image]
        args = build_backend_command(job_for_command, output_file=output_file, attachment_paths=image_paths)
        timeout_seconds = _job_timeout_seconds(payload)
        process_env = _backend_process_env(job, secret_env)
        if payload.get("dry_run"):
            return f"dry_run: {_format_command(args)}"
        if process_env:
            return _run_backend_command(
                args,
                workspace_root,
                timeout_seconds,
                output_file=output_file,
                env=process_env,
            )
        return _run_backend_command(args, workspace_root, timeout_seconds, output_file=output_file)
    except RuntimeError as exc:
        if backend == "codex" and _is_codex_context_full_error(str(exc)):
            if output_file:
                Path(output_file).write_text("", encoding="utf-8")
            fallback_args = build_codex_compact_handoff_command(
                _job_with_attachment_context(job, attachments),
                output_file=output_file,
                attachment_paths=[str(attachment.path) for attachment in attachments if attachment.is_image],
            )
            if process_env:
                return _run_backend_command(
                    fallback_args,
                    workspace_root,
                    timeout_seconds,
                    output_file=output_file,
                    env=process_env,
                )
            return _run_backend_command(
                fallback_args,
                workspace_root,
                timeout_seconds,
                output_file=output_file,
            )
        raise
    finally:
        for attachment in attachments:
            attachment.path.unlink(missing_ok=True)
        if output_file:
            Path(output_file).unlink(missing_ok=True)


def execute_job(job: dict[str, Any], *, client: Any | None = None, worker_id: str = "") -> str:
    kind = job["kind"]
    payload = _payload(job)
    if kind == "health_check":
        return "ok"
    if kind == "session_discovery":
        return "session discovery requested"
    if kind in {"session_start", "session_fork"}:
        return _execute_session_start(job, client=client, worker_id=worker_id)
    if kind == "session_btw":
        return _execute_session_btw(job, client=client)
    if kind == "provider_login":
        return _execute_provider_auth(job, "login")
    if kind == "provider_logout":
        return _execute_provider_auth(job, "logout")
    if kind == "file_list":
        return _execute_file_list(job)
    if kind == "file_read":
        return _execute_file_read(job)
    if kind == "file_write":
        return _execute_file_write(job)
    if kind == "session_fast_state_refresh":
        backend = str(job.get("backend") or "").lower()
        if backend != "codex":
            raise ValueError("session_fast_state_refresh is only supported for codex")
        timeout_seconds = _job_timeout_seconds(payload)
        return _json_result(read_codex_fast_mode(job, timeout_seconds=timeout_seconds))
    if kind == "session_fast_toggle":
        backend = str(job.get("backend") or "").lower()
        if backend != "codex":
            raise ValueError("session_fast_toggle is only supported for codex")
        timeout_seconds = _job_timeout_seconds(payload)
        enabled = bool(payload.get("enabled"))
        return _json_result(toggle_codex_fast_mode(job, enabled=enabled, timeout_seconds=timeout_seconds))
    if kind == "session_input":
        backend = str(job.get("backend") or "").lower()
        secret_env = _resolve_job_secrets(client, job, payload)
        native_turn_mode = str(payload.get("native_turn_mode") or "").strip().lower()
        if backend == "codex" and native_turn_mode == "default":
            timeout_seconds = _job_timeout_seconds(payload)
            if payload.get("dry_run"):
                return f"dry_run: codex app-server turn/start default {_prompt(job)}"
            try:
                return run_codex_turn(
                    job,
                    collaboration_mode="default",
                    client=client,
                    worker_id=worker_id,
                    timeout_seconds=timeout_seconds,
                )
            except RuntimeError as exc:
                if _is_codex_native_default_fallback_error(str(exc)):
                    return _execute_session_input_cli(job, payload, secret_env)
                raise
        if backend == "codex" and payload.get("reply_mode") == "plan" and payload.get("native_plan_mode") is True:
            timeout_seconds = _job_timeout_seconds(payload)
            if payload.get("attachments"):
                return _execute_codex_native_plan_cli_fallback(job, payload)
            if payload.get("dry_run"):
                return f"dry_run: codex app-server turn/start plan {_prompt(job)}"
            try:
                return run_codex_plan_turn(job, client=client, worker_id=worker_id, timeout_seconds=timeout_seconds)
            except RuntimeError as exc:
                if _is_codex_native_plan_fallback_error(str(exc)):
                    return _execute_codex_native_plan_cli_fallback(job, payload)
                raise
        return _execute_session_input_cli(job, payload, secret_env)
    if kind in {"observer", "reflector", "memory_extract"}:
        return f"{kind} accepted"
    raise ValueError(f"Unknown job kind: {kind}")
