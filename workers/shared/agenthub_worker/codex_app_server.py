from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol


ALLOWED_SANDBOX = {"read-only", "workspace-write", "danger-full-access"}
ALLOWED_APPROVAL = {"never", "on-request", "on-failure", "untrusted"}
ALLOWED_EFFORT = {"none", "minimal", "low", "medium", "high", "xhigh"}
DEFAULT_PLAN_MODEL = "gpt-5.4"
NATIVE_PERMISSION_SOURCE = "codex_request_user_input"
CODEX_APPROVAL_SOURCES = {
    "item/commandExecution/requestApproval": "codex_command_approval",
    "execCommandApproval": "codex_command_approval",
    "item/fileChange/requestApproval": "codex_file_change_approval",
    "applyPatchApproval": "codex_file_change_approval",
    "item/permissions/requestApproval": "codex_permission_approval",
}
APPROVAL_DECISIONS = {"approved", "approved_for_session", "denied", "abort"}


class PermissionClient(Protocol):
    def request_permission(self, permission: dict[str, Any]) -> dict[str, Any]: ...

    def get_permission(self, permission_id: str) -> dict[str, Any]: ...

    def publish_timeline(self, session_id: str, items: list[dict[str, Any]], *, replace: bool = False) -> None: ...


def _payload(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("payload") or {}
    return payload if isinstance(payload, dict) else {}


def _controls(job: dict[str, Any]) -> dict[str, Any]:
    controls = _payload(job).get("controls") or {}
    return controls if isinstance(controls, dict) else {}


def _session_id(job: dict[str, Any]) -> str:
    session_id = str(job.get("target_session_id") or "").strip()
    if not session_id:
        raise ValueError("codex plan target_session_id is required")
    return session_id


def _workspace_root(job: dict[str, Any]) -> str:
    return str(job.get("workspace_root") or ".").strip() or "."


def _prompt(job: dict[str, Any]) -> str:
    prompt = str(_payload(job).get("prompt") or "").strip()
    if not prompt:
        raise ValueError("codex plan prompt cannot be empty")
    return prompt


def _model(controls: dict[str, Any]) -> str:
    return (
        str(
            controls.get("model")
            or os.getenv("AGENTHUB_CODEX_PLAN_MODEL")
            or os.getenv("AGENTHUB_CODEX_DEFAULT_MODEL")
            or DEFAULT_PLAN_MODEL
        ).strip()
        or DEFAULT_PLAN_MODEL
    )


def _reasoning_effort(controls: dict[str, Any]) -> str:
    value = str(controls.get("reasoning_effort") or controls.get("model_reasoning_effort") or "medium").strip()
    return value if value in ALLOWED_EFFORT else "medium"


def _approval_policy(controls: dict[str, Any]) -> str | None:
    if controls.get("yolo") is True:
        return "never"
    approval = str(controls.get("approval_mode") or "").strip()
    if not approval:
        return None
    if approval not in ALLOWED_APPROVAL:
        raise ValueError("Unsupported codex approval_mode")
    return approval


def _sandbox_mode(controls: dict[str, Any]) -> str | None:
    if controls.get("yolo") is True:
        return "danger-full-access"
    sandbox = str(controls.get("sandbox_mode") or "").strip()
    if not sandbox:
        return None
    if sandbox not in ALLOWED_SANDBOX:
        raise ValueError("Unsupported codex sandbox_mode")
    return sandbox


def _sandbox_policy(sandbox: str | None) -> dict[str, Any] | None:
    if sandbox == "danger-full-access":
        return {"type": "dangerFullAccess"}
    if sandbox == "read-only":
        return {"type": "readOnly", "networkAccess": True}
    if sandbox == "workspace-write":
        return {
            "type": "workspaceWrite",
            "writableRoots": [],
            "networkAccess": True,
            "excludeTmpdirEnvVar": False,
            "excludeSlashTmp": False,
        }
    return None


def build_collaboration_mode(job: dict[str, Any]) -> dict[str, Any]:
    controls = _controls(job)
    return {
        "mode": "plan",
        "settings": {
            "model": _model(controls),
            "reasoning_effort": _reasoning_effort(controls),
            "developer_instructions": None,
        },
    }


def build_thread_resume_params(job: dict[str, Any]) -> dict[str, Any]:
    controls = _controls(job)
    params: dict[str, Any] = {
        "threadId": _session_id(job),
        "cwd": _workspace_root(job),
        "persistExtendedHistory": True,
    }
    model = str(controls.get("model") or "").strip()
    if model:
        params["model"] = model
    approval = _approval_policy(controls)
    if approval:
        params["approvalPolicy"] = approval
    sandbox = _sandbox_mode(controls)
    if sandbox:
        params["sandbox"] = sandbox
    return params


def build_turn_start_params(job: dict[str, Any]) -> dict[str, Any]:
    controls = _controls(job)
    params: dict[str, Any] = {
        "threadId": _session_id(job),
        "input": [{"type": "text", "text": _prompt(job), "text_elements": []}],
        "cwd": _workspace_root(job),
        "collaborationMode": build_collaboration_mode(job),
    }
    approval = _approval_policy(controls)
    if approval:
        params["approvalPolicy"] = approval
    sandbox = _sandbox_policy(_sandbox_mode(controls))
    if sandbox:
        params["sandboxPolicy"] = sandbox
    return params


def _candidate_native_codex(shim_path: str) -> str | None:
    if os.name != "nt":
        return None
    path = Path(shim_path)
    if path.suffix.lower() not in {".cmd", ".bat", ".ps1"} and path.name.lower() != "codex":
        return shim_path if path.name.lower() == "codex.exe" else None
    npm_dir = path.parent
    for candidate in npm_dir.glob("node_modules/@openai/codex/node_modules/@openai/codex-win32-*/vendor/**/codex.exe"):
        if candidate.is_file():
            return str(candidate)
    return None


def resolve_codex_executable() -> str:
    executable = shutil.which("codex")
    if executable is None:
        raise RuntimeError("Backend CLI not found: codex")
    return _candidate_native_codex(executable) or executable


def _safe_fragment(value: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", str(value or "").strip())[:28].strip("-") or "request"


def _permission_id(job: dict[str, Any], request_id: Any, params: dict[str, Any]) -> str:
    job_id = _safe_fragment(job.get("job_id") or "job")
    item_id = _safe_fragment(params.get("itemId") or request_id)
    return f"prm_codex_{job_id}_{item_id}"[:64]


def _approval_permission_id(job: dict[str, Any], request_id: Any, params: dict[str, Any]) -> str:
    job_id = _safe_fragment(job.get("job_id") or "job")
    approval_id = _safe_fragment(params.get("approvalId") or params.get("callId") or params.get("itemId") or request_id)
    return f"prm_codex_{job_id}_{approval_id}"[:64]


def _choice_options(questions: list[dict[str, Any]]) -> list[dict[str, str]]:
    choices: list[dict[str, str]] = []
    for question in questions:
        question_id = str(question.get("id") or "question")
        options = question.get("options") if isinstance(question.get("options"), list) else []
        for index, option in enumerate(options):
            if not isinstance(option, dict):
                continue
            label = str(option.get("label") or "").strip()
            if not label:
                continue
            choice: dict[str, str] = {"id": f"{question_id}:{index}", "label": label, "question_id": question_id}
            description = str(option.get("description") or "").strip()
            if description:
                choice["description"] = description
            choices.append(choice)
    return choices


def _request_title(questions: list[dict[str, Any]]) -> str:
    if not questions:
        return "Codex Plan needs input"
    header = str(questions[0].get("header") or "").strip()
    question = str(questions[0].get("question") or "").strip()
    return (header or question or "Codex Plan needs input")[:240]


def _request_description(questions: list[dict[str, Any]]) -> str:
    if not questions:
        return "Codex app-server requested user input."
    return str(questions[0].get("question") or "").strip()


def _answer_label(permission: dict[str, Any], questions: list[dict[str, Any]]) -> str:
    response = permission.get("response") if isinstance(permission.get("response"), dict) else {}
    action = str(response.get("action") or permission.get("status") or "")
    if action in {"deny", "denied"}:
        raise RuntimeError("User denied Codex plan input request")
    answer = response.get("response") if isinstance(response.get("response"), dict) else {}
    label = str(answer.get("label") or answer.get("text") or answer.get("value") or "").strip()
    if label:
        return label
    choice_id = str(answer.get("choice") or "").strip()
    choices = _choice_options(questions)
    for choice in choices:
        if choice.get("id") == choice_id:
            return str(choice.get("label") or "").strip()
    return choice_id or "继续执行"


def _answer_labels_by_question(permission: dict[str, Any], questions: list[dict[str, Any]]) -> dict[str, str]:
    response = permission.get("response") if isinstance(permission.get("response"), dict) else {}
    answer = response.get("response") if isinstance(response.get("response"), dict) else {}
    answers = answer.get("answers") if isinstance(answer.get("answers"), dict) else {}
    choices = _choice_options(questions)
    labels: dict[str, str] = {}
    for question in questions:
        question_id = str(question.get("id") or "").strip()
        if not question_id:
            continue
        value = answers.get(question_id) if isinstance(answers.get(question_id), dict) else {}
        raw_label = str(value.get("label") or "").strip()
        freeform_text = str(value.get("text") or "").strip()
        choice_id = str(value.get("choice") or "").strip()
        if freeform_text and (choice_id.endswith(":other") or raw_label.lower().startswith("other") or raw_label.startswith("其他")):
            label = freeform_text
        else:
            label = str(value.get("label") or value.get("text") or value.get("value") or "").strip()
        if not label:
            for choice in choices:
                if choice.get("id") == choice_id:
                    label = str(choice.get("label") or "").strip()
                    break
        labels[question_id] = label or _answer_label(permission, [question])
    return labels


def _tool_user_input_response(permission: dict[str, Any], questions: list[dict[str, Any]]) -> dict[str, Any]:
    labels_by_question = _answer_labels_by_question(permission, questions)
    answers: dict[str, Any] = {}
    for question in questions:
        question_id = str(question.get("id") or "").strip()
        if question_id:
            answers[question_id] = {"answers": [labels_by_question.get(question_id) or _answer_label(permission, [question])]}
    return {"answers": answers}


def _approval_choices() -> list[dict[str, str]]:
    return [
        {"id": "approved", "label": "批准", "description": "允许这一次请求。"},
        {"id": "approved_for_session", "label": "本会话批准", "description": "本次会话后续同类请求尽量直接允许。"},
        {"id": "denied", "label": "拒绝", "description": "拒绝本次请求，让 agent 尝试其他方式。"},
        {"id": "abort", "label": "中止", "description": "拒绝并让 agent 停下等待下一条指令。"},
    ]


def _approval_title(method: str) -> str:
    if "commandExecution" in method or "execCommand" in method:
        return "批准执行命令"
    if "fileChange" in method or "applyPatch" in method:
        return "批准修改文件"
    return "批准权限请求"


def _approval_kind(method: str) -> str:
    return "command_approval" if "commandExecution" in method or "execCommand" in method else "tool_approval"


def _approval_description(params: dict[str, Any]) -> str:
    reason = str(params.get("reason") or "").strip()
    if reason:
        return reason
    command = params.get("command")
    if isinstance(command, list) and command:
        return " ".join(str(item) for item in command)
    return "Codex 请求用户批准后继续。"


def _approval_decision(permission: dict[str, Any]) -> str:
    response = permission.get("response") if isinstance(permission.get("response"), dict) else {}
    action = str(response.get("action") or permission.get("status") or "").strip()
    answer = response.get("response") if isinstance(response.get("response"), dict) else {}
    choice = str(answer.get("choice") or answer.get("decision") or "").strip()
    if choice in APPROVAL_DECISIONS:
        return choice
    if action in {"allow", "allowed"}:
        return "approved"
    if action in {"deny", "denied"}:
        return "denied"
    return "approved"


def _is_retryable_app_server_error(params: dict[str, Any]) -> bool:
    if params.get("willRetry") is True:
        return True
    error = params.get("error") if isinstance(params.get("error"), dict) else {}
    info = error.get("codexErrorInfo") if isinstance(error.get("codexErrorInfo"), dict) else {}
    return "responseStreamDisconnected" in info


@dataclass
class CodexTurnResult:
    text: str
    timeline_items: list[dict[str, Any]] = field(default_factory=list)


class CodexAppServerClient:
    def __init__(self, executable: str | None = None) -> None:
        self.executable = executable or resolve_codex_executable()
        self._process: subprocess.Popen[str] | None = None
        self._stdout: queue.Queue[str] = queue.Queue()
        self._stderr: list[str] = []
        self._backlog: list[dict[str, Any]] = []
        self._next_id = 1

    def __enter__(self) -> "CodexAppServerClient":
        self.start()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    def start(self) -> None:
        if self._process is not None:
            return
        self._process = subprocess.Popen(
            [self.executable, "app-server", "--listen", "stdio://"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        assert self._process.stdout is not None
        assert self._process.stderr is not None
        threading.Thread(target=self._read_stdout, args=(self._process.stdout,), daemon=True).start()
        threading.Thread(target=self._read_stderr, args=(self._process.stderr,), daemon=True).start()

    def close(self) -> None:
        process = self._process
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False)
                else:
                    process.kill()
        self._process = None

    def initialize(self) -> dict[str, Any]:
        return self.request(
            "initialize",
            {
                "clientInfo": {"name": "AgentHub Worker", "title": "AgentHub Worker", "version": "0.1.0"},
                "capabilities": {"experimentalApi": True},
            },
            timeout_seconds=30,
        )

    def request(self, method: str, params: dict[str, Any] | None, *, timeout_seconds: int) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            message = self._read_message(deadline, use_backlog=False)
            if message is None:
                continue
            if message.get("id") == request_id and "method" not in message:
                if "error" in message:
                    raise RuntimeError(f"codex app-server {method} failed: {message['error']}")
                result = message.get("result")
                return result if isinstance(result, dict) else {}
        raise TimeoutError(f"codex app-server {method} timed out")

    def run_plan_turn(
        self,
        job: dict[str, Any],
        *,
        client: PermissionClient | None,
        worker_id: str,
        timeout_seconds: int,
    ) -> CodexTurnResult:
        self.initialize()
        self.request("thread/resume", build_thread_resume_params(job), timeout_seconds=timeout_seconds)
        self.request("turn/start", build_turn_start_params(job), timeout_seconds=timeout_seconds)
        return self._wait_for_turn(job, client=client, worker_id=worker_id, timeout_seconds=timeout_seconds)

    def _wait_for_turn(
        self,
        job: dict[str, Any],
        *,
        client: PermissionClient | None,
        worker_id: str,
        timeout_seconds: int,
    ) -> CodexTurnResult:
        deadline = time.monotonic() + timeout_seconds
        plan_chunks: list[str] = []
        assistant_chunks: list[str] = []
        latest_plan = ""
        while time.monotonic() < deadline:
            message = self._read_message(deadline)
            if message is None:
                continue
            method = str(message.get("method") or "")
            params = message.get("params") if isinstance(message.get("params"), dict) else {}
            if "id" in message and method == "item/tool/requestUserInput":
                self._handle_user_input_request(job, message, params, client=client, worker_id=worker_id, deadline=deadline)
                continue
            if "id" in message and method in CODEX_APPROVAL_SOURCES:
                self._handle_approval_request(job, message, params, client=client, worker_id=worker_id, deadline=deadline)
                continue
            if method == "item/plan/delta":
                plan_chunks.append(str(params.get("delta") or ""))
                continue
            if method == "item/agentMessage/delta":
                assistant_chunks.append(str(params.get("delta") or ""))
                continue
            if method == "turn/plan/updated":
                latest_plan = _format_plan_update(params)
                continue
            if method == "error":
                if _is_retryable_app_server_error(params):
                    continue
                raise RuntimeError(f"codex app-server error: {params}")
            if method == "turn/completed":
                break
        else:
            raise TimeoutError("codex app-server plan turn timed out")

        text = (latest_plan or "".join(plan_chunks) or "".join(assistant_chunks)).strip()
        if not text:
            text = "Codex Plan turn completed."
        return CodexTurnResult(
            text=text,
            timeline_items=[
                {
                    "item_type": "assistant_message",
                    "role": "assistant",
                    "text": text,
                    "status": "completed",
                    "payload": {"source": "codex_app_server", "reply_mode": "plan"},
                }
            ],
        )

    def _handle_user_input_request(
        self,
        job: dict[str, Any],
        request: dict[str, Any],
        params: dict[str, Any],
        *,
        client: PermissionClient | None,
        worker_id: str,
        deadline: float,
    ) -> None:
        questions = [item for item in params.get("questions", []) if isinstance(item, dict)]
        request_id = request.get("id")
        if client is None:
            self._write_error(request_id, "AgentHub worker is not connected to the control plane")
            raise RuntimeError("Codex Plan requested user input but no AgentHub client is available")
        permission_id = _permission_id(job, request_id, params)
        requested = client.request_permission(
            {
                "permission_id": permission_id,
                "session_id": _session_id(job),
                "backend": "codex",
                "kind": "question",
                "title": _request_title(questions),
                "description": _request_description(questions),
                "detail": {
                    "source": NATIVE_PERMISSION_SOURCE,
                    "server_request_id": request_id,
                    "thread_id": params.get("threadId"),
                    "turn_id": params.get("turnId"),
                    "item_id": params.get("itemId"),
                    "questions": questions,
                },
                "actions": {"choices": _choice_options(questions)},
            }
        )
        permission = requested
        while time.monotonic() < deadline:
            if permission.get("status") != "pending":
                self._write({"jsonrpc": "2.0", "id": request_id, "result": _tool_user_input_response(permission, questions)})
                return
            time.sleep(2)
            permission = client.get_permission(permission_id)
        self._write_error(request_id, "Timed out waiting for AgentHub user input")
        raise TimeoutError("Timed out waiting for AgentHub user input")

    def _handle_approval_request(
        self,
        job: dict[str, Any],
        request: dict[str, Any],
        params: dict[str, Any],
        *,
        client: PermissionClient | None,
        worker_id: str,
        deadline: float,
    ) -> None:
        request_id = request.get("id")
        method = str(request.get("method") or "")
        if client is None:
            self._write_error(request_id, "AgentHub worker is not connected to the control plane")
            raise RuntimeError("Codex requested approval but no AgentHub client is available")
        permission_id = _approval_permission_id(job, request_id, params)
        requested = client.request_permission(
            {
                "permission_id": permission_id,
                "session_id": str(params.get("conversationId") or params.get("threadId") or _session_id(job)),
                "backend": "codex",
                "kind": _approval_kind(method),
                "title": _approval_title(method),
                "description": _approval_description(params),
                "detail": {
                    "source": CODEX_APPROVAL_SOURCES.get(method, "codex_approval"),
                    "method": method,
                    "server_request_id": request_id,
                    "approval_id": params.get("approvalId"),
                    "call_id": params.get("callId"),
                    "item_id": params.get("itemId"),
                    "command": params.get("command"),
                    "cwd": params.get("cwd"),
                    "reason": params.get("reason"),
                    "raw_params": params,
                },
                "actions": {"choices": _approval_choices()},
            }
        )
        permission = requested
        while time.monotonic() < deadline:
            if permission.get("status") != "pending":
                self._write({"jsonrpc": "2.0", "id": request_id, "result": {"decision": _approval_decision(permission)}})
                return
            time.sleep(2)
            permission = client.get_permission(permission_id)
        self._write_error(request_id, "Timed out waiting for AgentHub approval")
        raise TimeoutError("Timed out waiting for AgentHub approval")

    def _write_error(self, request_id: Any, message: str) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": message}})

    def _write(self, message: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None:
            raise RuntimeError("codex app-server is not running")
        process.stdin.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
        process.stdin.flush()

    def _read_message(self, deadline: float, *, use_backlog: bool = True) -> dict[str, Any] | None:
        if use_backlog and self._backlog:
            return self._backlog.pop(0)
        process = self._process
        if process is None:
            raise RuntimeError("codex app-server is not running")
        timeout = max(0.05, min(0.5, deadline - time.monotonic()))
        try:
            line = self._stdout.get(timeout=timeout)
        except queue.Empty:
            if process.poll() is not None:
                raise RuntimeError(f"codex app-server exited {process.returncode}: {self._stderr_text()}")
            return None
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            return {"method": "warning", "params": {"message": line.strip()}}
        return message if isinstance(message, dict) else None

    def _stderr_text(self) -> str:
        return "\n".join(self._stderr)[-2000:].strip()

    def _read_stdout(self, pipe: Any) -> None:
        for line in pipe:
            self._stdout.put(line)

    def _read_stderr(self, pipe: Any) -> None:
        for line in pipe:
            self._stderr.append(line.rstrip())
            if len(self._stderr) > 80:
                del self._stderr[:20]


def _format_plan_update(params: dict[str, Any]) -> str:
    lines: list[str] = []
    explanation = str(params.get("explanation") or "").strip()
    if explanation:
        lines.append(explanation)
    plan = params.get("plan") if isinstance(params.get("plan"), list) else []
    for index, step in enumerate(plan, start=1):
        if not isinstance(step, dict):
            continue
        text = str(step.get("step") or step.get("text") or "").strip()
        status = str(step.get("status") or "").strip()
        if not text:
            continue
        prefix = f"{index}. "
        suffix = f" [{status}]" if status else ""
        lines.append(f"{prefix}{text}{suffix}")
    return "\n".join(lines).strip()


def _publish_plan_timeline(client: PermissionClient | None, session_id: str, result: CodexTurnResult) -> None:
    if client is None or not result.timeline_items:
        return
    try:
        client.publish_timeline(session_id, result.timeline_items, replace=False)
    except Exception:
        return


def run_codex_plan_turn(
    job: dict[str, Any],
    *,
    client: PermissionClient | None = None,
    worker_id: str = "",
    timeout_seconds: int = 3600,
) -> str:
    with CodexAppServerClient() as app_server:
        result = app_server.run_plan_turn(job, client=client, worker_id=worker_id, timeout_seconds=timeout_seconds)
    _publish_plan_timeline(client, _session_id(job), result)
    return result.text
