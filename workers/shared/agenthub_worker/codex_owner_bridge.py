from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid
from typing import Any

from agenthub_worker.codex_app_server import CodexAppServerClient


ACTIVE_WRITER_MARKER = "already has an active writer"


class CodexOwnerBridgeUnavailable(RuntimeError):
    """Raised when AgentHub cannot hand a turn to the process owning a Codex thread."""


def is_codex_active_writer_error(message: str) -> bool:
    lowered = message.lower()
    return "codex app-server thread/resume failed" in lowered and ACTIVE_WRITER_MARKER in lowered


@dataclass(frozen=True)
class SendMessageCapability:
    accepts_model: bool
    thinking_values: frozenset[str]


def extract_desktop_pipe_path(command_line: str) -> str | None:
    if "CODEX_APP_TOOLS_PIPE_PATH" not in command_line:
        return None
    decoded = command_line
    pipe_pattern = re.compile(r"\\\\\.\\pipe\\[^\s\"']+")
    for _ in range(5):
        match = pipe_pattern.search(decoded)
        if match:
            return match.group(0)
        updated = decoded.replace('\\"', '"').replace('\\\\', '\\')
        if updated == decoded:
            break
        decoded = updated
    return None


def parse_send_message_capability(tools: list[dict[str, Any]]) -> SendMessageCapability:
    for tool in tools:
        name = str(tool.get("name") or tool.get("tool") or "")
        if str(tool.get("namespace") or "") != "codex_app" or name != "send_message_to_thread":
            continue
        schema = tool.get("inputSchema")
        if not isinstance(schema, dict):
            break
        required = {str(value) for value in schema.get("required", []) if isinstance(value, str)}
        properties = schema.get("properties")
        if not isinstance(properties, dict):
            break
        if not {"threadId", "prompt"}.issubset(required) or not {"threadId", "prompt"}.issubset(properties):
            break
        thinking_schema = properties.get("thinking")
        thinking_values: frozenset[str] = frozenset()
        if isinstance(thinking_schema, dict) and isinstance(thinking_schema.get("enum"), list):
            thinking_values = frozenset(str(value) for value in thinking_schema["enum"] if isinstance(value, str))
        return SendMessageCapability(
            accepts_model="model" in properties,
            thinking_values=thinking_values,
        )
    raise CodexOwnerBridgeUnavailable(
        "Codex Desktop does not advertise a compatible codex_app.send_message_to_thread capability"
    )


def discover_desktop_pipe_paths() -> list[str]:
    if os.name != "nt":
        return []
    powershell = shutil.which("pwsh") or shutil.which("powershell") or shutil.which("powershell.exe")
    if not powershell:
        return []
    script = (
        "$ErrorActionPreference='Stop'; "
        "@(Get-CimInstance Win32_Process | Where-Object { "
        "$_.Name -ieq 'codex.exe' -and $_.CommandLine -like '*app-server*' -and "
        "$_.CommandLine -like '*CODEX_APP_TOOLS_PIPE_PATH*' } | "
        "Select-Object ProcessId,CommandLine,ExecutablePath) | ConvertTo-Json -Compress"
    )
    try:
        completed = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if completed.returncode != 0 or not completed.stdout.strip():
        return []
    try:
        decoded = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return []
    processes = decoded if isinstance(decoded, list) else [decoded]
    paths: list[str] = []
    for process in processes:
        if not isinstance(process, dict):
            continue
        path = extract_desktop_pipe_path(str(process.get("CommandLine") or ""))
        if path and path not in paths:
            paths.append(path)
    return paths


def invoke_desktop_pipe(pipe_path: str, request: dict[str, Any], *, timeout_seconds: int) -> dict[str, Any]:
    node = shutil.which("node")
    helper = Path(__file__).with_name("codex_desktop_pipe.mjs")
    if not node or not helper.is_file():
        raise CodexOwnerBridgeUnavailable("Node.js 20 and the Codex Desktop pipe helper are required")
    envelope = {"pipePath": pipe_path, "request": request, "timeoutMs": max(1, timeout_seconds) * 1000}
    try:
        completed = subprocess.run(
            [node, str(helper)],
            input=json.dumps(envelope, ensure_ascii=False),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=max(1, timeout_seconds) + 2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CodexOwnerBridgeUnavailable(f"Codex Desktop pipe request failed: {exc}") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise CodexOwnerBridgeUnavailable(f"Codex Desktop pipe request failed: {detail or 'unknown error'}")
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise CodexOwnerBridgeUnavailable("Codex Desktop pipe returned invalid JSON") from exc
    if not isinstance(response, dict):
        raise CodexOwnerBridgeUnavailable("Codex Desktop pipe returned a non-object response")
    if "error" in response:
        raise CodexOwnerBridgeUnavailable(f"Codex Desktop pipe RPC failed: {response['error']}")
    return response


def _session_id(job: dict[str, Any]) -> str:
    session_id = str(job.get("target_session_id") or "").strip()
    if not session_id:
        raise ValueError("Codex owner bridge target_session_id is required")
    return session_id


def _payload(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("payload")
    return payload if isinstance(payload, dict) else {}


def _owner_prompt(job: dict[str, Any], collaboration_mode: str) -> str:
    prompt = str(_payload(job).get("prompt") or "").strip()
    if not prompt:
        raise ValueError("Codex owner bridge prompt is required")
    if collaboration_mode != "plan":
        return prompt
    return (
        "<agenthub_plan_mode>\n"
        "Analyze the request and return an implementation plan only. Do not make changes yet.\n"
        "</agenthub_plan_mode>\n\n"
        f"{prompt}"
    )


def _response_result(response: dict[str, Any], operation: str) -> dict[str, Any]:
    result = response.get("result")
    if not isinstance(result, dict):
        raise CodexOwnerBridgeUnavailable(f"Codex Desktop {operation} returned no result")
    return result


def _deliver_through_desktop(job: dict[str, Any], prompt: str, *, timeout_seconds: int) -> None:
    session_id = _session_id(job)
    failures: list[str] = []
    for pipe_path in discover_desktop_pipe_paths():
        try:
            list_response = invoke_desktop_pipe(
                pipe_path,
                {
                    "jsonrpc": "2.0",
                    "id": f"agenthub-tools-{uuid.uuid4()}",
                    "method": "tools/list",
                    "params": {"threadStartKind": "all"},
                },
                timeout_seconds=min(timeout_seconds, 30),
            )
            list_result = _response_result(list_response, "tools/list")
            tools = list_result.get("tools")
            if not isinstance(tools, list):
                raise CodexOwnerBridgeUnavailable("Codex Desktop tools/list returned no tools")
            capability = parse_send_message_capability([tool for tool in tools if isinstance(tool, dict)])
            arguments: dict[str, Any] = {"threadId": session_id, "prompt": prompt}
            controls = _payload(job).get("controls")
            controls = controls if isinstance(controls, dict) else {}
            model = str(controls.get("model") or "").strip()
            if model and capability.accepts_model:
                arguments["model"] = model
            thinking = str(controls.get("reasoning_effort") or controls.get("model_reasoning_effort") or "").strip()
            if thinking and thinking in capability.thinking_values:
                arguments["thinking"] = thinking
            request_id = f"agenthub-send-{uuid.uuid4()}"
            send_response = invoke_desktop_pipe(
                pipe_path,
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "tools/call",
                    "params": {
                        "namespace": "codex_app",
                        "tool": "send_message_to_thread",
                        "arguments": arguments,
                        "callId": request_id,
                        "threadId": session_id,
                        "turnId": f"agenthub-owner-{uuid.uuid4()}",
                    },
                },
                timeout_seconds=min(timeout_seconds, 30),
            )
            send_result = _response_result(send_response, "send_message_to_thread")
            if send_result.get("success") is False or send_result.get("isError") is True:
                raise CodexOwnerBridgeUnavailable(f"Codex Desktop rejected the message: {send_result}")
            return
        except CodexOwnerBridgeUnavailable as exc:
            failures.append(str(exc))
    if not failures:
        failures.append("no live Codex Desktop app-tools pipe was discovered")
    raise CodexOwnerBridgeUnavailable("; ".join(failures))


def _turns_from_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    for candidate in (result.get("data"), result.get("items"), result.get("turns")):
        if isinstance(candidate, list):
            return [turn for turn in candidate if isinstance(turn, dict)]
    thread = result.get("thread")
    if isinstance(thread, dict) and isinstance(thread.get("turns"), list):
        return [turn for turn in thread["turns"] if isinstance(turn, dict)]
    return []


def _read_turns(observer: CodexAppServerClient, session_id: str, *, timeout_seconds: int) -> list[dict[str, Any]]:
    try:
        result = observer.request(
            "thread/turns/list",
            {
                "threadId": session_id,
                "limit": 100,
                "sortDirection": "desc",
                "itemsView": "full",
            },
            timeout_seconds=max(1, timeout_seconds),
        )
    except RuntimeError as turns_error:
        try:
            result = observer.request(
                "thread/read",
                {"threadId": session_id, "includeTurns": True},
                timeout_seconds=max(1, timeout_seconds),
            )
        except RuntimeError as read_error:
            raise CodexOwnerBridgeUnavailable(
                f"Codex read-only turn history is unavailable: {turns_error}; {read_error}"
            ) from read_error
    return _turns_from_result(result)


def _turn_id(turn: dict[str, Any]) -> str:
    return str(turn.get("id") or turn.get("turnId") or "").strip()


def _item_text(item: dict[str, Any]) -> str:
    direct = str(item.get("text") or "").strip()
    if direct:
        return direct
    content = item.get("content")
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(part.get("text") or "").strip()
        for part in content
        if isinstance(part, dict) and str(part.get("text") or "").strip()
    )


def _user_text(turn: dict[str, Any]) -> str:
    items = turn.get("items")
    if not isinstance(items, list):
        return ""
    return "\n".join(
        _item_text(item)
        for item in items
        if isinstance(item, dict) and str(item.get("type") or "") in {"userMessage", "user_message"}
    )


def _agent_text(turn: dict[str, Any]) -> str:
    items = turn.get("items")
    if not isinstance(items, list):
        return ""
    messages = [
        _item_text(item)
        for item in items
        if isinstance(item, dict) and str(item.get("type") or "") in {"agentMessage", "assistantMessage", "agent_message"}
    ]
    return next((message for message in reversed(messages) if message), "")


def _turn_client_ids(turn: dict[str, Any]) -> set[str]:
    ids = {
        str(turn.get(key) or "").strip()
        for key in ("clientId", "clientUserMessageId")
        if str(turn.get(key) or "").strip()
    }
    items = turn.get("items")
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, dict) or str(item.get("type") or "") not in {"userMessage", "user_message"}:
                continue
            for key in ("clientId", "clientUserMessageId"):
                value = str(item.get(key) or "").strip()
                if value:
                    ids.add(value)
    return ids


def _queue_owner_message(
    observer: CodexAppServerClient,
    job: dict[str, Any],
    prompt: str,
    *,
    timeout_seconds: int,
) -> str:
    job_id = str(job.get("job_id") or uuid.uuid4()).strip()
    client_user_message_id = f"agenthub:{job_id}"
    observer.request(
        "thread/queue/add",
        {
            "threadId": _session_id(job),
            "input": [{"type": "text", "text": prompt}],
            "clientUserMessageId": client_user_message_id,
        },
        timeout_seconds=max(1, min(timeout_seconds, 30)),
    )
    return client_user_message_id


def _wait_for_completed_turn(
    observer: CodexAppServerClient,
    session_id: str,
    *,
    baseline_turn_ids: set[str],
    prompt: str,
    client_user_message_id: str | None = None,
    timeout_seconds: int,
) -> str:
    deadline = time.monotonic() + max(1, timeout_seconds)
    while time.monotonic() < deadline:
        remaining = max(1, int(deadline - time.monotonic()))
        turns = _read_turns(observer, session_id, timeout_seconds=min(remaining, 30))
        for turn in turns:
            turn_id = _turn_id(turn)
            if not turn_id or turn_id in baseline_turn_ids:
                continue
            client_ids = _turn_client_ids(turn)
            if client_user_message_id and client_ids:
                if client_user_message_id not in client_ids:
                    continue
            elif prompt not in _user_text(turn):
                continue
            if str(turn.get("status") or "").lower() != "completed":
                continue
            result = _agent_text(turn)
            if result:
                return result
        time.sleep(min(1.0, max(0.05, deadline - time.monotonic())))
    raise TimeoutError(f"Timed out waiting for Codex owner thread {session_id} to complete the delivered turn")


def run_codex_owner_turn(
    job: dict[str, Any],
    *,
    collaboration_mode: str,
    client: Any | None = None,
    worker_id: str = "",
    timeout_seconds: int,
) -> str:
    del client, worker_id
    session_id = _session_id(job)
    prompt = _owner_prompt(job, collaboration_mode)
    with CodexAppServerClient() as observer:
        observer.initialize()
        baseline_turn_ids = {
            turn_id
            for turn in _read_turns(observer, session_id, timeout_seconds=min(timeout_seconds, 30))
            if (turn_id := _turn_id(turn))
        }
        client_user_message_id: str | None = None
        try:
            _deliver_through_desktop(job, prompt, timeout_seconds=timeout_seconds)
        except CodexOwnerBridgeUnavailable as desktop_error:
            try:
                client_user_message_id = _queue_owner_message(
                    observer,
                    job,
                    prompt,
                    timeout_seconds=timeout_seconds,
                )
            except (RuntimeError, TimeoutError) as queue_error:
                raise CodexOwnerBridgeUnavailable(
                    f"Codex Desktop owner delivery failed: {desktop_error}; durable queue failed: {queue_error}"
                ) from queue_error
        return _wait_for_completed_turn(
            observer,
            session_id,
            baseline_turn_ids=baseline_turn_ids,
            prompt=prompt,
            client_user_message_id=client_user_message_id,
            timeout_seconds=timeout_seconds,
        )
