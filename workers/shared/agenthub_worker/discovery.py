from __future__ import annotations

import json
import os
import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from agenthub_protocol.models import AgentTimelineItem, SessionSnapshot
from agenthub_worker.paths import normalize_workspace_root, project_name_from_root


GENERIC_TITLES = {"codex session", "claude session", "kimi session", "session"}
DEFAULT_DISCOVERY_MAX_FILES = 80
DEFAULT_RUNNING_STALE_SECONDS = 1800
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


def _env_int(name: str, fallback: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(fallback))))
    except ValueError:
        return fallback


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


def backend_for_session_path(path: Path) -> str:
    lower_parts = [part.lower() for part in path.parts]
    lower_name = path.name.lower()
    if "codex" in lower_name or ".codex" in lower_parts:
        return "codex"
    if "claude" in lower_name or ".claude" in lower_parts:
        return "claude"
    if "kimi" in lower_name or ".kimi" in lower_parts:
        return "kimi"
    return ""


def recent_session_files(search_roots: list[Path], max_files: int | None = None) -> list[tuple[str, Path]]:
    limit = max_files or _env_int("AGENTHUB_DISCOVERY_MAX_FILES", DEFAULT_DISCOVERY_MAX_FILES)
    candidates: list[tuple[float, str, str, Path]] = []
    for root in search_roots:
        if not root.exists():
            continue
        for path in _iter_jsonl_paths(root):
            lower_parts = [part.lower() for part in path.parts]
            if "subagents" in lower_parts:
                continue
            backend = backend_for_session_path(path)
            if path.name.lower() == "wire.jsonl" and ".kimi" not in lower_parts:
                continue
            if backend == "kimi" and path.name.lower() == "context.jsonl" and (path.parent / "wire.jsonl").exists():
                continue
            if backend not in {"codex", "claude", "kimi"}:
                continue
            try:
                modified_at = path.stat().st_mtime
            except OSError:
                continue
            candidates.append((modified_at, str(path).lower(), backend, path))
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [(backend, path) for _, _, backend, path in candidates[:limit]]


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
                status="completed",
                payload={"kind": message.get("kind")},
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


def _message(session_id: str, role: str, text: str, created_at: datetime, kind: str) -> dict[str, Any] | None:
    clean = text.strip()
    if not clean:
        return None
    return {"session_id": session_id, "role": role, "text": clean, "created_at": created_at, "kind": kind}


def parse_codex_jsonl(path: Path) -> SessionSnapshot:
    rows = _read_jsonl(path)
    stat = path.stat()
    fallback_mtime = datetime.fromtimestamp(stat.st_mtime)
    session_id = path.stem
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
                session_id = str(source.get("id") or source.get("session_id") or session_id)
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


def parse_claude_jsonl(path: Path) -> SessionSnapshot:
    rows = _read_jsonl(path)
    stat = path.stat()
    fallback_mtime = datetime.fromtimestamp(stat.st_mtime)
    session_id = path.stem
    workspace_root = ""
    messages: list[dict[str, Any]] = []
    explicit_title = ""
    for row in rows:
        timestamp = _timestamp(row.get("timestamp"), fallback_mtime)
        session_id = str(row.get("sessionId") or row.get("session_id") or session_id)
        workspace_root = str(row.get("cwd") or row.get("workspace_root") or workspace_root)
        if row.get("summary"):
            explicit_title = str(row["summary"])
        row_type = row.get("type")
        if row_type in {"assistant", "user"}:
            message_payload = row.get("message") if isinstance(row.get("message"), dict) else {}
            role = str(message_payload.get("role") or row_type)
            text = _text_from_content(message_payload.get("content") or row.get("content"))
            if item := _message(session_id, role, text, timestamp, role):
                messages.append(item)
        elif row_type == "system" and row.get("subtype") in {"api_error", "stop_hook_summary"}:
            text = _text_from_content(row.get("summary") or row.get("message") or row.get("error") or row.get("cause") or "")
            if item := _message(session_id, "system", text, timestamp, str(row.get("subtype"))):
                messages.append(item)
    workspace_root = workspace_root or str(path.parent)
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


def parse_kimi_session(session_dir: Path) -> SessionSnapshot:
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
        for row in _read_jsonl(wire_path):
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
                text = f"调用工具: {payload.get('name') or payload.get('tool') or 'function'}"
                if item := _message(session_id, "system", text, timestamp, "action"):
                    messages.append(item)
            elif message.get("type") == "ToolResult":
                text = f"工具结果:\n{_text_from_content(payload.get('content') or payload.get('result') or '')[:1000]}"
                if item := _message(session_id, "system", text, timestamp, "action"):
                    messages.append(item)

    if not messages and context_path.exists():
        for row in _read_jsonl(context_path):
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
