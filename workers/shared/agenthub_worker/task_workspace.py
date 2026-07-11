from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any


TASK_ID_PATTERN = re.compile(r"^tsk_[0-9a-f]{32}$")
CREATED_SESSION_MARKER = re.compile(r"\Acreated_session_id=[^\s\r\n]+(?:\r?\n|\Z)")
MAX_REPORT_BYTES = 2_000_000


@dataclass(frozen=True)
class PreparedTaskWorkspace:
    task_id: str
    relative_path: str
    directory: Path
    resolved_directory: str
    task_file: Path
    metadata_file: Path
    status_file: Path
    report_file: Path
    attempt_number: int
    review_note: str
    prompt: str


def normalize_relevant_path(value: Any) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    if not raw or "\x00" in raw or raw.startswith("/") or (len(raw) > 1 and raw[1] == ":"):
        raise ValueError("Relevant path must be workspace-relative")
    parts = [part for part in raw.split("/") if part not in {"", "."}]
    if any(part == ".." or ":" in part for part in parts):
        raise ValueError("Relevant path must stay inside the workspace")
    normalized = "/".join(parts) or "."
    if len(normalized) > 1024:
        raise ValueError("Relevant path is too long")
    return normalized


def _validated_task_id(value: Any) -> str:
    task_id = str(value or "").strip()
    if not TASK_ID_PATTERN.fullmatch(task_id) or task_id in {".", ".."}:
        raise ValueError("Invalid task_id for task workspace")
    return task_id


def _normalized_paths(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        path = normalize_relevant_path(value)
        if path not in seen:
            result.append(path)
            seen.add(path)
    return result


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as temporary:
            temporary.write(content)
        os.replace(temporary_name, path)
    finally:
        Path(temporary_name).unlink(missing_ok=True)


def _read_existing_metadata(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _status_markdown(*, attempt_number: int, review_note: str, state: str) -> str:
    lines = [
        "# Task Status",
        "",
        f"- State: {state}",
        f"- Attempt: {attempt_number}",
    ]
    if review_note:
        lines.extend(["", "## Requested Changes", "", review_note])
    lines.append("")
    return "\n".join(lines)


def _task_markdown(config: dict[str, Any]) -> str:
    title = str(config.get("title") or "AgentHub Task").strip() or "AgentHub Task"
    brief = str(config.get("brief_markdown") or "").strip()
    criteria = str(config.get("success_criteria_markdown") or "").strip()
    review_note = str(config.get("review_note") or "").strip()
    paths = _normalized_paths(config.get("relevant_paths"))
    lines = [
        f"# {title}",
        "",
        "## Brief",
        "",
        brief or "No task brief was provided.",
        "",
        "## Success Criteria",
        "",
        criteria or "- Produce a concise delivery report.",
        "",
        "## Relevant Paths",
        "",
    ]
    lines.extend(f"- `{path}`" for path in paths or ["."])
    if review_note:
        lines.extend(["", "## Requested Changes", "", review_note])
    lines.append("")
    return "\n".join(lines)


def _workspace_prompt(base_prompt: str, relative_path: str) -> str:
    return (
        f"{base_prompt.strip()}\n\n"
        "## AgentHub Task Workspace\n"
        f"The task workspace is `{relative_path}` inside the current workspace.\n"
        "Before working, read `task.md`, `agenthub.task.json`, and `status.md` from that directory.\n"
        "Treat the authority paths in `agenthub.task.json` as declared boundaries. Runtime controls are mapped "
        "where the backend supports them, but this contract does not provide command-level enforcement.\n"
        "Keep `status.md` current when useful. Before ending, write the final delivery to report.md in the task "
        "workspace, including changed files, validation, remaining risks, and next steps."
    ).strip()


def prepare_task_workspace(job: dict[str, Any]) -> PreparedTaskWorkspace | None:
    if str(job.get("kind") or "") != "session_start":
        return None
    payload = job.get("payload") if isinstance(job.get("payload"), dict) else {}
    task_id_value = payload.get("task_id")
    if not task_id_value:
        return None
    task_id = _validated_task_id(task_id_value)
    raw_config = payload.get("task_workspace")
    config = dict(raw_config) if isinstance(raw_config, dict) else {}
    configured_task_id = _validated_task_id(config.get("task_id") or task_id)
    if configured_task_id != task_id:
        raise ValueError("task_id does not match task workspace configuration")

    workspace_root = Path(str(job.get("workspace_root") or "").strip()).resolve(strict=True)
    if not workspace_root.is_dir():
        raise ValueError("Workspace root is not available")
    relative_path = f".agenthub/tasks/{task_id}"
    configured_relative_path = str(config.get("relative_path") or relative_path).replace("\\", "/").strip("/")
    if configured_relative_path != relative_path:
        raise ValueError("Task workspace path does not match task_id")
    directory = (workspace_root / ".agenthub" / "tasks" / task_id).resolve(strict=False)
    try:
        directory.relative_to(workspace_root)
    except ValueError:
        raise ValueError("Task workspace resolves outside the workspace root") from None
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "artifacts").mkdir(exist_ok=True)
    (directory / "logs").mkdir(exist_ok=True)

    try:
        attempt_number = int(config.get("attempt_number") or 1)
    except (TypeError, ValueError):
        raise ValueError("Task workspace attempt_number must be a positive integer") from None
    if attempt_number < 1:
        raise ValueError("Task workspace attempt_number must be a positive integer")
    review_note = str(config.get("review_note") or "").strip()
    relevant_paths = _normalized_paths(config.get("relevant_paths"))
    authority_value = config.get("authority")
    authority = dict(authority_value) if isinstance(authority_value, dict) else {}
    authority["read_paths"] = _normalized_paths(authority.get("read_paths")) or relevant_paths or ["."]
    authority["write_paths"] = _normalized_paths(authority.get("write_paths"))
    runtime_controls = authority.get("runtime_controls")
    authority["runtime_controls"] = dict(runtime_controls) if isinstance(runtime_controls, dict) else {}
    authority["enforcement"] = {
        "runtime_controls": "mapped",
        "command_level": "declared_only",
    }
    authority["limitations"] = [
        "Runtime controls are mapped to backend sandbox, approval, or permission options where supported.",
        "Command-level enforcement is not provided by the task workspace contract.",
    ]

    metadata_file = directory / "agenthub.task.json"
    report_file = directory / "report.md"
    existing_metadata = _read_existing_metadata(metadata_file)
    if report_file.exists():
        try:
            previous_attempt = max(1, int(existing_metadata.get("attempt_number") or attempt_number - 1 or 1))
        except (TypeError, ValueError):
            previous_attempt = max(1, attempt_number - 1)
        report_file.replace(directory / "artifacts" / f"report-attempt-{previous_attempt}.md")

    normalized_config = {
        "schema_version": 1,
        "task_id": task_id,
        "relative_path": relative_path,
        "title": str(config.get("title") or payload.get("title") or "AgentHub Task").strip(),
        "brief_markdown": str(config.get("brief_markdown") or payload.get("prompt") or "").strip(),
        "success_criteria_markdown": str(config.get("success_criteria_markdown") or "").strip(),
        "template_key": str(config.get("template_key") or "implement_feature"),
        "authority_preset": str(config.get("authority_preset") or "feature"),
        "relevant_paths": relevant_paths,
        "attempt_number": attempt_number,
        "review_note": review_note,
        "authority": authority,
    }
    task_file = directory / "task.md"
    status_file = directory / "status.md"
    _atomic_write_text(task_file, _task_markdown(normalized_config))
    _atomic_write_text(metadata_file, json.dumps(normalized_config, ensure_ascii=False, indent=2) + "\n")
    _atomic_write_text(
        status_file,
        _status_markdown(attempt_number=attempt_number, review_note=review_note, state="running"),
    )
    return PreparedTaskWorkspace(
        task_id=task_id,
        relative_path=relative_path,
        directory=directory,
        resolved_directory=str(directory.resolve(strict=True)),
        task_file=task_file,
        metadata_file=metadata_file,
        status_file=status_file,
        report_file=report_file,
        attempt_number=attempt_number,
        review_note=review_note,
        prompt=_workspace_prompt(str(payload.get("prompt") or ""), relative_path),
    )


def finalize_task_result(result_text: str, prepared: PreparedTaskWorkspace | None) -> str:
    if prepared is None:
        return result_text
    try:
        current_directory = str(prepared.directory.resolve(strict=True))
    except OSError:
        return result_text
    if os.path.normcase(os.path.normpath(current_directory)) != os.path.normcase(
        os.path.normpath(prepared.resolved_directory)
    ):
        return result_text
    _atomic_write_text(
        prepared.status_file,
        _status_markdown(
            attempt_number=prepared.attempt_number,
            review_note=prepared.review_note,
            state="completed",
        ),
    )
    if (
        not prepared.report_file.exists()
        or not prepared.report_file.is_file()
        or prepared.report_file.is_symlink()
    ):
        return result_text
    try:
        prepared.report_file.resolve(strict=True).relative_to(Path(prepared.resolved_directory))
    except (OSError, ValueError):
        return result_text
    report = (
        prepared.report_file.read_bytes()[:MAX_REPORT_BYTES]
        .decode("utf-8", errors="replace")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .strip()
    )
    if not report:
        return result_text
    marker = CREATED_SESSION_MARKER.match(result_text)
    if marker is None:
        return report
    return f"{marker.group(0).strip()}\n{report}"
