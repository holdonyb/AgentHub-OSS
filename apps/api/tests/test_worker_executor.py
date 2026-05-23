from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path
import time

import pytest

from agenthub_worker import executor
from agenthub_worker.executor import build_backend_command, build_session_start_command, execute_job


VALID_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


def fake_popen_factory(
    *,
    stdout: str = "ok",
    stderr: str = "",
    returncode: int = 0,
    calls: list[list[str]] | None = None,
    captured: dict[str, object] | None = None,
):
    class FakeProcess:
        pid = 1234

        def __init__(self, args: list[str], **kwargs: object) -> None:
            self.args = args
            self.returncode = returncode
            if calls is not None:
                calls.append(args)
            if captured is not None:
                captured.update(kwargs)

        def communicate(self, timeout: int | None = None) -> tuple[str, str]:
            return stdout, stderr

        def poll(self) -> int | None:
            return self.returncode

        def kill(self) -> None:
            self.returncode = -9

    return FakeProcess


def test_session_input_builds_backend_specific_commands() -> None:
    codex = build_backend_command(
        {
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "继续执行", "controls": {"model": "gpt-5.2", "sandbox_mode": "workspace-write"}},
        }
    )
    assert codex[:3] == ["codex", "-C", "E:/work/AgentHub"]
    assert codex[-3:] == ["--skip-git-repo-check", "codex-session", "继续执行"]
    assert codex.index("exec") < codex.index("resume")
    assert codex.index("--skip-git-repo-check") > codex.index("resume")
    assert "--model" in codex
    assert "--sandbox" in codex
    assert "--ask-for-approval" not in codex

    claude = build_backend_command(
        {
            "kind": "session_input",
            "backend": "claude",
            "target_session_id": "claude-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "继续执行", "controls": {"model": "sonnet"}},
        }
    )
    assert claude[:3] == ["claude", "-p", "--resume"]
    assert "--model" in claude

    kimi = build_backend_command(
        {
            "kind": "session_input",
            "backend": "kimi",
            "target_session_id": "kimi-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "继续执行", "controls": {"model": "kimi-k2.5", "yolo": True, "thinking": True}},
        }
    )
    assert kimi[:5] == ["kimi", "--quiet", "--work-dir", "E:/work/AgentHub", "-S"]
    assert "--yolo" in kimi
    assert "--thinking" in kimi

    opencode = build_backend_command(
        {
            "kind": "session_input",
            "backend": "opencode",
            "target_session_id": "opencode-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "继续执行",
                "controls": {"model": "anthropic/claude-sonnet-4", "agent": "plan", "yolo": True},
            },
        },
        attachment_paths=["C:/Temp/mock.png"],
    )
    assert opencode[:6] == ["opencode", "run", "--dir", "E:/work/AgentHub", "--session", "opencode-session"]
    assert "--model" in opencode
    assert "--agent" in opencode
    assert "--dangerously-skip-permissions" in opencode
    assert "--file" in opencode
    assert opencode[-1] == "继续执行"


def test_session_input_preserves_http_url_prompt_as_single_backend_argument() -> None:
    prompt = (
        "检查链接 http://example.com/a?x=1&next=https%3A%2F%2Fagenthub.example.com%2Fcb#frag\n"
        "第二行 https://agenthub.example.com/path?q=http%3A%2F%2Fnested.local%2Fa%3Fb%3D1&ok=true"
    )

    codex = build_backend_command(
        {
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": prompt, "controls": {"sandbox_mode": "danger-full-access", "approval_mode": "never"}},
        }
    )
    claude = build_backend_command(
        {
            "kind": "session_input",
            "backend": "claude",
            "target_session_id": "claude-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": prompt},
        }
    )
    kimi = build_backend_command(
        {
            "kind": "session_input",
            "backend": "kimi",
            "target_session_id": "kimi-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": prompt},
        }
    )
    opencode = build_backend_command(
        {
            "kind": "session_input",
            "backend": "opencode",
            "target_session_id": "opencode-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": prompt},
        }
    )

    assert codex[-1] == prompt
    assert claude[-1] == prompt
    assert kimi[-1] == prompt
    assert opencode[-1] == prompt


def test_provider_auth_supports_opencode_cli_handoff() -> None:
    login = executor._provider_handoff_command("opencode", "login")
    logout = executor._provider_handoff_command("opencode", "logout")

    assert login == ["opencode", "auth", "login"]
    assert logout == ["opencode", "auth", "logout"]


def test_claude_session_input_uses_resume_prompt_path() -> None:
    prompt = "Continue until all mobile inbox checks pass and the APK is published"

    claude = build_backend_command(
        {
            "kind": "session_input",
            "backend": "claude",
            "target_session_id": "claude-goal-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": prompt,
                "controls": {"model": "sonnet", "permission_mode": "auto"},
            },
        }
    )

    assert claude[:3] == ["claude", "-p", "--resume"]
    assert claude[3] == "claude-goal-session"
    assert "--model" in claude
    assert "--permission-mode" in claude
    assert claude[-1] == prompt


def test_codex_session_input_adds_image_paths_to_exec_resume() -> None:
    codex = build_backend_command(
        {
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "看截图继续", "controls": {"sandbox_mode": "danger-full-access"}},
        },
        attachment_paths=["C:/Temp/agenthub-screen.png"],
    )

    assert codex[codex.index("resume") + 1 : codex.index("codex-session")] == [
        "--skip-git-repo-check",
        "-i",
        "C:/Temp/agenthub-screen.png",
    ]
    assert codex[-2:] == ["codex-session", "看截图继续"]


def test_codex_approval_flag_is_global_before_exec() -> None:
    codex = build_backend_command(
        {
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "继续执行", "controls": {"approval_mode": "never"}},
        }
    )

    assert codex[:3] == ["codex", "-C", "E:/work/AgentHub"]
    assert codex.index("--ask-for-approval") < codex.index("exec")
    assert codex.index("--skip-git-repo-check") > codex.index("resume")
    assert codex[-3:] == ["--skip-git-repo-check", "codex-session", "继续执行"]


def test_codex_yolo_omits_conflicting_sandbox_and_approval_flags() -> None:
    codex = build_backend_command(
        {
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "继续执行",
                "controls": {
                    "approval_mode": "never",
                    "sandbox_mode": "danger-full-access",
                    "yolo": True,
                },
            },
        }
    )

    assert "--dangerously-bypass-approvals-and-sandbox" in codex
    assert "--ask-for-approval" not in codex
    assert "--sandbox" not in codex


def test_file_list_returns_workspace_entries_without_shell(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("# AgentHub\n", encoding="utf-8")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("print('ok')\n", encoding="utf-8")

    result = execute_job(
        {
            "job_id": "job-file-list",
            "kind": "file_list",
            "workspace_root": str(tmp_path),
            "payload": {"path": "."},
        }
    )

    payload = json.loads(result)
    assert payload["path"] == "."
    assert [entry["name"] for entry in payload["entries"]] == ["src", "README.md"]
    assert payload["entries"][0]["kind"] == "directory"
    assert payload["entries"][1]["kind"] == "file"
    assert payload["entries"][1]["path"] == "README.md"


def test_file_read_returns_bounded_text_preview(tmp_path: Path) -> None:
    target = tmp_path / "notes.md"
    target.write_text("第一行\n第二行\n第三行\n", encoding="utf-8")

    result = execute_job(
        {
            "job_id": "job-file-read",
            "kind": "file_read",
            "workspace_root": str(tmp_path),
            "payload": {"path": "notes.md", "max_bytes": 18},
        }
    )

    payload = json.loads(result)
    assert payload["path"] == "notes.md"
    assert payload["truncated"] is True
    assert payload["text"].startswith("第一行")
    assert payload["size_bytes"] > 18


def test_file_read_returns_inline_download_data_for_small_images(tmp_path: Path) -> None:
    target = tmp_path / "diagram.png"
    target.write_bytes(VALID_PNG_BYTES)

    result = execute_job(
        {
            "job_id": "job-file-read-image",
            "kind": "file_read",
            "workspace_root": str(tmp_path),
            "payload": {"path": "diagram.png", "max_bytes": 200_000},
        }
    )

    payload = json.loads(result)
    assert payload["path"] == "diagram.png"
    assert payload["content_type"] == "image/png"
    assert payload["preview_kind"] == "image"
    assert payload["downloadable"] is True
    assert payload["data_base64"] == base64.b64encode(VALID_PNG_BYTES).decode("ascii")
    assert "text" not in payload


def test_file_read_rejects_paths_outside_workspace(tmp_path: Path) -> None:
    outside = tmp_path.parent / "secret.txt"
    outside.write_text("secret", encoding="utf-8")

    with pytest.raises(ValueError, match="outside workspace"):
        execute_job(
            {
                "job_id": "job-file-read-outside",
                "kind": "file_read",
                "workspace_root": str(tmp_path),
                "payload": {"path": "../secret.txt"},
            }
        )


def test_session_input_dry_run_returns_command_without_shell_execution() -> None:
    result = execute_job(
        {
            "job_id": "job-1",
            "kind": "session_input",
            "backend": "kimi",
            "target_session_id": "kimi-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "继续执行", "dry_run": True, "controls": {"yolo": True}},
        }
    )

    assert result.startswith("dry_run:")
    assert "kimi" in result
    assert "继续执行" in result


def test_session_input_default_timeout_supports_long_coding_jobs(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}
    monkeypatch.delenv("AGENTHUB_JOB_TIMEOUT_SECONDS", raising=False)

    def fake_run_backend_command(
        args: list[str],
        cwd: str,
        timeout_seconds: int,
        *,
        output_file: str | None = None,
    ) -> str:
        captured["args"] = args
        captured["cwd"] = cwd
        captured["timeout"] = timeout_seconds
        captured["output_file"] = output_file
        return "KIMI_OK"

    monkeypatch.setattr(executor, "_run_backend_command", fake_run_backend_command)

    result = execute_job(
        {
            "job_id": "job-long",
            "kind": "session_input",
            "backend": "kimi",
            "target_session_id": "kimi-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "完整实现并测试"},
        }
    )

    assert result == "KIMI_OK"
    assert captured["timeout"] == 3600
    assert captured["args"] == ["kimi", "--quiet", "--work-dir", "E:/work/AgentHub", "-S", "kimi-session", "-p", "完整实现并测试"]


def test_backend_command_timeout_is_reported_as_job_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 1234
        returncode: int | None = None

        def __init__(self, args: list[str], **kwargs: object) -> None:
            captured["args"] = args
            captured["kwargs"] = kwargs
            self.args = args
            self.communicate_calls = 0

        def poll(self) -> int | None:
            return self.returncode

        def kill(self) -> None:
            self.returncode = -9

        def communicate(self, timeout: int | None = None) -> tuple[str, str]:
            self.communicate_calls += 1
            if self.communicate_calls == 1:
                raise subprocess.TimeoutExpired(self.args, timeout)
            self.returncode = -9
            return "", "still running"

    monkeypatch.setattr(executor.shutil, "which", lambda name: f"C:/bin/{name}.exe")
    monkeypatch.setattr(executor.subprocess, "Popen", FakeProcess)
    monkeypatch.setattr(
        executor.subprocess,
        "run",
        lambda args, **kwargs: subprocess.CompletedProcess(args=args, returncode=0, stdout="", stderr=""),
    )

    with pytest.raises(RuntimeError, match="python timed out after 1 seconds"):
        executor._run_backend_command(
            ["python", "-c", "import time; time.sleep(5)"],
            ".",
            1,
        )
    assert captured["args"] == ["C:/bin/python.exe", "-c", "import time; time.sleep(5)"]


def test_codex_plan_session_input_uses_native_app_server(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []
    client = object()

    def fake_run_codex_plan_turn(
        job: dict[str, object],
        *,
        client: object | None = None,
        worker_id: str = "",
        timeout_seconds: int = 0,
    ) -> str:
        calls.append(
            {
                "job": job,
                "client": client,
                "worker_id": worker_id,
                "timeout_seconds": timeout_seconds,
            }
        )
        return "PLAN_OK"

    monkeypatch.setattr(executor, "run_codex_plan_turn", fake_run_codex_plan_turn, raising=False)
    monkeypatch.setattr(
        executor,
        "_run_backend_command",
        lambda *args, **kwargs: pytest.fail("native codex plan must not use the CLI exec resume path"),
    )

    result = execute_job(
        {
            "job_id": "job-plan",
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "先规划 UI 改造",
                "reply_mode": "plan",
                "native_plan_mode": True,
                "timeout_seconds": 123,
                "controls": {"model": "gpt-5.4", "sandbox_mode": "danger-full-access", "approval_mode": "never", "yolo": True},
            },
        },
        client=client,
        worker_id="win-main",
    )

    assert result == "PLAN_OK"
    assert calls[0]["client"] is client
    assert calls[0]["worker_id"] == "win-main"
    assert calls[0]["timeout_seconds"] == 123
    payload = calls[0]["job"]["payload"]  # type: ignore[index]
    assert payload["prompt"] == "先规划 UI 改造"  # type: ignore[index]
    assert payload["controls"]["sandbox_mode"] == "danger-full-access"  # type: ignore[index]


def test_codex_default_turn_uses_native_app_server_to_exit_plan_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []
    client = object()

    def fake_run_codex_turn(
        job: dict[str, object],
        *,
        collaboration_mode: str,
        client: object | None = None,
        worker_id: str = "",
        timeout_seconds: int = 0,
    ) -> str:
        calls.append(
            {
                "job": job,
                "collaboration_mode": collaboration_mode,
                "client": client,
                "worker_id": worker_id,
                "timeout_seconds": timeout_seconds,
            }
        )
        return "DIRECT_OK"

    monkeypatch.setattr(executor, "run_codex_turn", fake_run_codex_turn, raising=False)
    monkeypatch.setattr(
        executor,
        "_run_backend_command",
        lambda *args, **kwargs: pytest.fail("native codex default turn must not fall back to CLI resume"),
    )

    result = execute_job(
        {
            "job_id": "job-implement-plan",
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "Implement the plan.",
                "raw_prompt": "Implement the plan.",
                "reply_mode": "direct",
                "native_turn_mode": "default",
                "timeout_seconds": 321,
                "controls": {"sandbox_mode": "danger-full-access", "approval_mode": "never"},
            },
        },
        client=client,
        worker_id="win-main",
    )

    assert result == "DIRECT_OK"
    assert calls[0]["collaboration_mode"] == "default"
    assert calls[0]["client"] is client
    assert calls[0]["worker_id"] == "win-main"
    assert calls[0]["timeout_seconds"] == 321
    payload = calls[0]["job"]["payload"]  # type: ignore[index]
    assert payload["prompt"] == "Implement the plan."  # type: ignore[index]


def test_codex_default_turn_falls_back_to_cli_resume_for_legacy_provider_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    def fake_run_codex_turn(*args: object, **kwargs: object) -> str:
        raise RuntimeError(
            "codex app-server thread/resume failed: {'code': -32600, "
            "'message': 'failed to load configuration: Model provider `codex` not found'}"
        )

    def fake_run_backend_command(
        args: list[str],
        cwd: str,
        timeout_seconds: int,
        *,
        output_file: str | None = None,
        env: dict[str, str] | None = None,
    ) -> str:
        calls.append(
            {
                "args": args,
                "cwd": cwd,
                "timeout_seconds": timeout_seconds,
                "output_file": output_file,
                "env": env,
            }
        )
        return "legacy resume fallback"

    monkeypatch.setattr(executor, "run_codex_turn", fake_run_codex_turn, raising=False)
    monkeypatch.setattr(executor, "_run_backend_command", fake_run_backend_command)

    result = execute_job(
        {
            "job_id": "job-legacy-default",
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "legacy-codex-session",
            "workspace_root": "E:/work",
            "payload": {
                "prompt": "认真研究客户反馈",
                "raw_prompt": "认真研究客户反馈",
                "reply_mode": "direct",
                "native_turn_mode": "default",
                "timeout_seconds": 77,
                "controls": {"sandbox_mode": "danger-full-access", "approval_mode": "never"},
            },
        },
        client=object(),
        worker_id="win-main",
    )

    assert result == "legacy resume fallback"
    assert calls[0]["cwd"] == "E:/work"
    assert calls[0]["timeout_seconds"] == 77
    args = calls[0]["args"]  # type: ignore[assignment]
    assert args[:3] == ["codex", "-C", "E:/work"]
    assert "exec" in args
    assert "resume" in args
    assert args[-2:] == ["legacy-codex-session", "认真研究客户反馈"]
    assert "AgentHub native plan fallback" not in args[-1]


def test_codex_native_plan_falls_back_to_cli_plan_prompt_when_app_server_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def fake_run_codex_plan_turn(*args: object, **kwargs: object) -> str:
        raise RuntimeError("codex app-server error: {'willRetry': True, 'message': 'Reconnecting... 2/5'}")

    def fake_run_backend_command(args: list[str], cwd: str, timeout_seconds: int, *, output_file: str | None = None) -> str:
        calls.append({"args": args, "cwd": cwd, "timeout_seconds": timeout_seconds, "output_file": output_file})
        return "fallback plan"

    monkeypatch.setattr(executor, "run_codex_plan_turn", fake_run_codex_plan_turn, raising=False)
    monkeypatch.setattr(executor, "_run_backend_command", fake_run_backend_command)

    result = execute_job(
        {
            "job_id": "job-plan-fallback",
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "先规划 UI 改造",
                "raw_prompt": "先规划 UI 改造",
                "reply_mode": "plan",
                "native_plan_mode": True,
                "timeout_seconds": 123,
                "controls": {"sandbox_mode": "danger-full-access", "approval_mode": "never", "yolo": True},
            },
        },
        client=object(),
        worker_id="win-main",
    )

    assert result == "fallback plan"
    assert calls[0]["cwd"] == "E:/work/AgentHub"
    assert calls[0]["timeout_seconds"] == 123
    args = calls[0]["args"]  # type: ignore[assignment]
    assert args[:4] == ["codex", "-C", "E:/work/AgentHub", "--dangerously-bypass-approvals-and-sandbox"]
    assert "resume" in args
    assert args[-2] == "codex-session"
    assert "AgentHub native plan fallback" in args[-1]
    assert "先规划 UI 改造" in args[-1]


def test_codex_native_plan_with_image_attachment_uses_cli_fallback_to_preserve_image(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(executor.shutil, "which", lambda name: f"C:/Users/holdo/AppData/Roaming/npm/{name}.cmd")
    monkeypatch.setattr(
        executor,
        "run_codex_plan_turn",
        lambda *args, **kwargs: pytest.fail("native app-server plan path cannot preserve image attachments"),
        raising=False,
    )

    def fake_run_backend_command(args: list[str], cwd: str, timeout_seconds: int, *, output_file: str | None = None) -> str:
        image_path = Path(args[args.index("-i") + 1])
        captured["args"] = args
        captured["cwd"] = cwd
        captured["timeout_seconds"] = timeout_seconds
        captured["image_bytes"] = image_path.read_bytes()
        if output_file:
            Path(output_file).write_text("Codex saw plan image", encoding="utf-8")
        return "Codex saw plan image"

    monkeypatch.setattr(executor, "_run_backend_command", fake_run_backend_command)

    result = execute_job(
        {
            "job_id": "job-plan-image",
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "看顶栏截图，先列计划",
                "raw_prompt": "看顶栏截图，先列计划",
                "reply_mode": "plan",
                "native_plan_mode": True,
                "timeout_seconds": 123,
                "controls": {"sandbox_mode": "danger-full-access", "approval_mode": "never", "yolo": True},
                "attachments": [
                    {
                        "filename": "topbar.png",
                        "content_type": "image/png",
                        "size_bytes": len(VALID_PNG_BYTES),
                        "data_base64": base64.b64encode(VALID_PNG_BYTES).decode("ascii"),
                    }
                ],
            },
        },
        client=object(),
        worker_id="win-main",
    )

    assert result == "Codex saw plan image"
    assert captured["cwd"] == "E:/work/AgentHub"
    assert captured["timeout_seconds"] == 123
    assert captured["image_bytes"] == VALID_PNG_BYTES
    args = captured["args"]
    assert isinstance(args, list)
    assert "-i" in args
    assert "AgentHub native plan fallback" in args[-1]
    assert "看顶栏截图，先列计划" in args[-1]


def test_codex_app_server_plan_params_preserve_full_access_controls() -> None:
    from agenthub_worker.codex_app_server import build_thread_resume_params, build_turn_start_params

    job = {
        "kind": "session_input",
        "backend": "codex",
        "target_session_id": "codex-session",
        "workspace_root": "E:/work/AgentHub",
        "payload": {
            "prompt": "只列计划",
            "controls": {
                "model": "gpt-5.4",
                "reasoning_effort": "high",
                "sandbox_mode": "danger-full-access",
                "approval_mode": "never",
                "yolo": True,
            },
        },
    }

    resume_params = build_thread_resume_params(job)
    turn_params = build_turn_start_params(job)

    assert resume_params["threadId"] == "codex-session"
    assert resume_params["cwd"] == "E:/work/AgentHub"
    assert resume_params["approvalPolicy"] == "never"
    assert resume_params["sandbox"] == "danger-full-access"
    assert turn_params["threadId"] == "codex-session"
    assert turn_params["input"] == [{"type": "text", "text": "只列计划", "text_elements": []}]
    assert turn_params["cwd"] == "E:/work/AgentHub"
    assert turn_params["approvalPolicy"] == "never"
    assert turn_params["sandboxPolicy"] == {"type": "dangerFullAccess"}
    assert turn_params["collaborationMode"] == {
        "mode": "plan",
        "settings": {"model": "gpt-5.4", "reasoning_effort": "high", "developer_instructions": None},
    }


def test_codex_app_server_retryable_turn_error_does_not_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    from agenthub_worker.codex_app_server import CodexAppServerClient

    app_server = CodexAppServerClient(executable="codex")
    messages = iter(
        [
            {
                "method": "error",
                "params": {
                    "error": {"message": "Reconnecting... 2/5", "codexErrorInfo": {"responseStreamDisconnected": {}}},
                    "willRetry": True,
                    "additionalDetails": "timeout waiting for child process to exit",
                },
            },
            {
                "method": "turn/plan/updated",
                "params": {"plan": [{"step": "修复附件", "status": "pending"}, {"step": "修复计划模式", "status": "pending"}]},
            },
            {"method": "turn/completed", "params": {}},
        ]
    )

    monkeypatch.setattr(app_server, "_read_message", lambda deadline, use_backlog=True: next(messages))

    result = app_server._wait_for_turn(
        {
            "job_id": "job-plan",
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "列计划"},
        },
        collaboration_mode="plan",
        client=None,
        worker_id="win-main",
        timeout_seconds=5,
    )

    assert "修复附件" in result.text
    assert result.timeline_items[0]["payload"]["source"] == "codex_app_server"


def test_codex_app_server_request_ignores_notifications_while_waiting(monkeypatch: pytest.MonkeyPatch) -> None:
    from agenthub_worker.codex_app_server import CodexAppServerClient

    app_server = CodexAppServerClient(executable="codex")
    messages = iter(
        [
            {"method": "remoteControl/status/changed", "params": {"status": "disabled"}},
            {"id": 1, "result": {"data": [{"name": "Plan", "mode": "plan"}]}},
        ]
    )
    read_flags: list[bool] = []

    monkeypatch.setattr(app_server, "_write", lambda message: None)

    def fake_read_message(deadline: float, *, use_backlog: bool = True) -> dict[str, object]:
        read_flags.append(use_backlog)
        return next(messages)

    monkeypatch.setattr(app_server, "_read_message", fake_read_message)

    result = app_server.request("collaborationMode/list", {}, timeout_seconds=5)

    assert result == {"data": [{"name": "Plan", "mode": "plan"}]}
    assert read_flags == [False, False]


def test_codex_app_server_request_user_input_round_trips_agenthub_permission(monkeypatch: pytest.MonkeyPatch) -> None:
    from agenthub_worker.codex_app_server import CodexAppServerClient

    class FakeClient:
        def __init__(self) -> None:
            self.requested: dict[str, object] | None = None

        def request_permission(self, permission: dict[str, object]) -> dict[str, object]:
            self.requested = permission
            return {**permission, "status": "pending", "response": {}}

        def get_permission(self, permission_id: str) -> dict[str, object]:
            assert permission_id == "prm_codex_job-plan_item-1"
            return {
                "permission_id": permission_id,
                "status": "answered",
                "response": {"action": "answer", "response": {"choice": "direction:0", "label": "先做 UI"}},
            }

    app_server = CodexAppServerClient(executable="codex")
    writes: list[dict[str, object]] = []
    fake_client = FakeClient()
    monkeypatch.setattr(app_server, "_write", lambda message: writes.append(message))
    monkeypatch.setattr(time, "sleep", lambda seconds: None)

    app_server._handle_user_input_request(
        {
            "job_id": "job-plan",
            "target_session_id": "codex-session",
            "payload": {"prompt": "先规划", "controls": {}},
        },
        {"id": 7},
        {
            "threadId": "codex-session",
            "turnId": "turn-1",
            "itemId": "item-1",
            "questions": [
                {
                    "id": "direction",
                    "header": "选择方向",
                    "question": "下一步怎么做？",
                    "isOther": False,
                    "isSecret": False,
                    "options": [{"label": "先做 UI", "description": "调整布局"}],
                }
            ],
        },
        client=fake_client,
        worker_id="win-main",
        deadline=time.monotonic() + 5,
    )

    assert fake_client.requested is not None
    assert fake_client.requested["permission_id"] == "prm_codex_job-plan_item-1"
    assert fake_client.requested["detail"]["source"] == "codex_request_user_input"  # type: ignore[index]
    assert fake_client.requested["actions"] == {
        "choices": [{"id": "direction:0", "label": "先做 UI", "description": "调整布局", "question_id": "direction"}]
    }
    assert writes[-1] == {
        "jsonrpc": "2.0",
        "id": 7,
        "result": {"answers": {"direction": {"answers": ["先做 UI"]}}},
    }


def test_codex_app_server_request_user_input_supports_multiple_questions(monkeypatch: pytest.MonkeyPatch) -> None:
    from agenthub_worker.codex_app_server import CodexAppServerClient

    class FakeClient:
        def __init__(self) -> None:
            self.requested: dict[str, object] | None = None

        def request_permission(self, permission: dict[str, object]) -> dict[str, object]:
            self.requested = permission
            return {**permission, "status": "pending", "response": {}}

        def get_permission(self, permission_id: str) -> dict[str, object]:
            return {
                "permission_id": permission_id,
                "status": "answered",
                "response": {
                    "action": "answer",
                    "response": {
                        "answers": {
                            "maintenance_window": {"choice": "maintenance_window:1", "label": "只允许关应用"},
                            "docker_scope": {"choice": "docker_scope:0", "label": "迁到 E 盘"},
                        }
                    },
                },
            }

    app_server = CodexAppServerClient(executable="codex")
    writes: list[dict[str, object]] = []
    fake_client = FakeClient()
    monkeypatch.setattr(app_server, "_write", lambda message: writes.append(message))
    monkeypatch.setattr(time, "sleep", lambda seconds: None)

    questions = [
        {
            "id": "maintenance_window",
            "header": "维护窗口",
            "question": "接受哪种维护窗口？",
            "options": [
                {"label": "今晚可重启", "description": "允许重启"},
                {"label": "只允许关应用", "description": "不重启"},
            ],
        },
        {
            "id": "docker_scope",
            "header": "Docker/WSL",
            "question": "Docker/WSL 怎么处理？",
            "options": [
                {"label": "迁到 E 盘", "description": "长期最稳"},
                {"label": "先不动 Docker", "description": "风险更低"},
            ],
        },
    ]

    app_server._handle_user_input_request(
        {"job_id": "job-plan", "target_session_id": "codex-session", "payload": {"prompt": "先规划", "controls": {}}},
        {"id": 7},
        {"threadId": "codex-session", "turnId": "turn-1", "itemId": "item-1", "questions": questions},
        client=fake_client,
        worker_id="win-main",
        deadline=time.monotonic() + 5,
    )

    assert fake_client.requested is not None
    assert fake_client.requested["actions"] == {
        "choices": [
            {"id": "maintenance_window:0", "label": "今晚可重启", "description": "允许重启", "question_id": "maintenance_window"},
            {"id": "maintenance_window:1", "label": "只允许关应用", "description": "不重启", "question_id": "maintenance_window"},
            {"id": "docker_scope:0", "label": "迁到 E 盘", "description": "长期最稳", "question_id": "docker_scope"},
            {"id": "docker_scope:1", "label": "先不动 Docker", "description": "风险更低", "question_id": "docker_scope"},
        ]
    }
    assert writes[-1] == {
        "jsonrpc": "2.0",
        "id": 7,
        "result": {
            "answers": {
                "maintenance_window": {"answers": ["只允许关应用"]},
                "docker_scope": {"answers": ["迁到 E 盘"]},
            }
        },
    }


def test_codex_app_server_request_user_input_prefers_freeform_text(monkeypatch: pytest.MonkeyPatch) -> None:
    from agenthub_worker.codex_app_server import CodexAppServerClient

    class FakeClient:
        def request_permission(self, permission: dict[str, object]) -> dict[str, object]:
            return {**permission, "status": "pending", "response": {}}

        def get_permission(self, permission_id: str) -> dict[str, object]:
            return {
                "permission_id": permission_id,
                "status": "answered",
                "response": {
                    "action": "answer",
                    "response": {
                        "answers": {
                            "object_store": {
                                "choice": "object_store:other",
                                "label": "其他：Cloudflare R2",
                                "text": "Cloudflare R2",
                            }
                        }
                    },
                },
            }

    app_server = CodexAppServerClient(executable="codex")
    writes: list[dict[str, object]] = []
    monkeypatch.setattr(app_server, "_write", lambda message: writes.append(message))
    monkeypatch.setattr(time, "sleep", lambda seconds: None)

    app_server._handle_user_input_request(
        {"job_id": "job-plan", "target_session_id": "codex-session", "payload": {"prompt": "先规划", "controls": {}}},
        {"id": 7},
        {
            "threadId": "codex-session",
            "turnId": "turn-1",
            "itemId": "item-1",
            "questions": [
                {
                    "id": "object_store",
                    "header": "对象存储",
                    "question": "上传服务优先适配哪类对象存储？",
                    "options": [{"label": "S3兼容/MinIO"}],
                }
            ],
        },
        client=FakeClient(),
        worker_id="win-main",
        deadline=time.monotonic() + 5,
    )

    assert writes[-1] == {
        "jsonrpc": "2.0",
        "id": 7,
        "result": {"answers": {"object_store": {"answers": ["Cloudflare R2"]}}},
    }


def test_codex_app_server_returns_goal_updates_in_timeline(monkeypatch: pytest.MonkeyPatch) -> None:
    from agenthub_worker.codex_app_server import CodexAppServerClient

    class FakeClient:
        def __init__(self) -> None:
            self.timeline_items: list[dict[str, object]] = []

        def publish_timeline(self, session_id: str, items: list[dict[str, object]], *, replace: bool = False) -> None:
            assert session_id == "codex-session"
            assert replace is False
            self.timeline_items.extend(items)

    app_server = CodexAppServerClient(executable="codex")
    monkeypatch.setattr(app_server, "initialize", lambda: {})
    monkeypatch.setattr(app_server, "request", lambda *args, **kwargs: {})
    messages = iter(
        [
            {
                "method": "thread/goal/updated",
                "params": {
                    "threadId": "codex-session",
                    "turnId": "turn-1",
                    "goal": {
                        "threadId": "codex-session",
                        "objective": "完成移动端收件箱打磨",
                        "status": "active",
                        "createdAt": 1,
                        "updatedAt": 2,
                        "tokensUsed": 128,
                        "tokenBudget": 1000,
                        "timeUsedSeconds": 15,
                    },
                },
            },
            {"method": "turn/completed", "params": {"threadId": "codex-session", "turnId": "turn-1"}},
        ]
    )
    monkeypatch.setattr(app_server, "_read_message", lambda deadline: next(messages))

    result = app_server.run_turn(
        {
            "job_id": "job-goal",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "/goal 完成移动端收件箱打磨", "controls": {}},
        },
        collaboration_mode="default",
        client=FakeClient(),
        worker_id="win-main",
        timeout_seconds=30,
    )

    assert "完成移动端收件箱打磨" in result.text
    assert result.timeline_items[0]["item_type"] == "goal"
    assert result.timeline_items[0]["status"] == "active"
    assert "完成移动端收件箱打磨" in result.timeline_items[0]["text"]
    assert result.timeline_items[0]["payload"]["source"] == "codex_goal"  # type: ignore[index]


def test_codex_app_server_command_approval_round_trips_agenthub_permission(monkeypatch: pytest.MonkeyPatch) -> None:
    from agenthub_worker.codex_app_server import CodexAppServerClient

    class FakeClient:
        def __init__(self) -> None:
            self.requested: dict[str, object] | None = None

        def request_permission(self, permission: dict[str, object]) -> dict[str, object]:
            self.requested = permission
            return {**permission, "status": "pending", "response": {}}

        def get_permission(self, permission_id: str) -> dict[str, object]:
            return {
                "permission_id": permission_id,
                "status": "answered",
                "response": {
                    "action": "answer",
                    "response": {"choice": "approved_for_session", "label": "本会话批准"},
                },
            }

    app_server = CodexAppServerClient(executable="codex")
    fake_client = FakeClient()
    writes: list[dict[str, object]] = []
    monkeypatch.setattr(app_server, "_write", lambda message: writes.append(message))
    monkeypatch.setattr(time, "sleep", lambda seconds: None)

    app_server._handle_approval_request(
        {"job_id": "job-plan", "target_session_id": "codex-session", "payload": {"prompt": "执行测试", "controls": {}}},
        {
            "id": 8,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "callId": "call-1",
                "approvalId": "approval-1",
                "conversationId": "codex-session",
                "cwd": "E:/work/AgentHub",
                "command": ["npm", "run", "api:test"],
                "reason": "需要运行测试验证修改",
            },
        },
        {
            "callId": "call-1",
            "approvalId": "approval-1",
            "conversationId": "codex-session",
            "cwd": "E:/work/AgentHub",
            "command": ["npm", "run", "api:test"],
            "reason": "需要运行测试验证修改",
        },
        client=fake_client,
        worker_id="win-main",
        deadline=time.monotonic() + 5,
    )

    assert fake_client.requested is not None
    assert fake_client.requested["kind"] == "command_approval"
    assert fake_client.requested["title"] == "批准执行命令"
    assert fake_client.requested["detail"]["source"] == "codex_command_approval"  # type: ignore[index]
    assert fake_client.requested["detail"]["command"] == ["npm", "run", "api:test"]  # type: ignore[index]
    assert writes[-1] == {"jsonrpc": "2.0", "id": 8, "result": {"decision": "approved_for_session"}}


def test_codex_backend_execution_uses_native_binary_when_available(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    monkeypatch.setattr(executor.shutil, "which", lambda name: f"C:/Users/holdo/AppData/Roaming/npm/{name}.cmd")
    monkeypatch.setattr(
        executor,
        "resolve_codex_executable",
        lambda: "C:/Users/holdo/AppData/Roaming/npm/node_modules/@openai/codex/vendor/codex.exe",
    )

    monkeypatch.setattr(executor.subprocess, "Popen", fake_popen_factory(stdout="ok", calls=calls))

    result = executor._run_backend_command(["codex", "resume", "session-id", "继续"], "E:/Work", 30)

    assert result == "ok"
    assert calls[0][0].endswith("codex.exe")


def test_backend_execution_decodes_cli_output_as_utf8_with_replacement(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(executor.shutil, "which", lambda name: f"C:/Users/holdo/AppData/Roaming/npm/{name}.cmd")

    monkeypatch.setattr(executor.subprocess, "Popen", fake_popen_factory(stdout="ok", captured=captured))

    result = executor._run_backend_command(["codex", "exec", "resume", "session-id", "继续"], "E:/Work", 30)

    assert result == "ok"
    assert captured["encoding"] == "utf-8"
    assert captured["errors"] == "replace"


def test_codex_session_input_returns_output_last_message(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    monkeypatch.setattr(executor.shutil, "which", lambda name: f"C:/Users/holdo/AppData/Roaming/npm/{name}.cmd")

    def fake_run_backend_command(
        args: list[str],
        cwd: str,
        timeout_seconds: int,
        *,
        output_file: str | None = None,
    ) -> str:
        calls.append(args)
        if output_file:
            Path(output_file).write_text("AGENTHUB_REMOTE_OK", encoding="utf-8")
        return "AGENTHUB_REMOTE_OK"

    monkeypatch.setattr(executor, "_run_backend_command", fake_run_backend_command)

    result = execute_job(
        {
            "job_id": "job-remote-reply",
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "remote smoke"},
        }
    )

    assert result == "AGENTHUB_REMOTE_OK"
    assert "--output-last-message" in calls[0]
    assert calls[0].index("--output-last-message") > calls[0].index("resume")


def test_codex_session_input_materializes_uploaded_image_attachment(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(executor.shutil, "which", lambda name: f"C:/Users/holdo/AppData/Roaming/npm/{name}.cmd")

    def fake_run_backend_command(
        args: list[str],
        cwd: str,
        timeout_seconds: int,
        *,
        output_file: str | None = None,
    ) -> str:
        image_path = Path(args[args.index("-i") + 1])
        captured["image_path"] = image_path
        captured["image_bytes"] = image_path.read_bytes()
        if output_file:
            Path(output_file).write_text("Codex saw image", encoding="utf-8")
        return "Codex saw image"

    monkeypatch.setattr(executor, "_run_backend_command", fake_run_backend_command)

    result = execute_job(
        {
            "job_id": "job-image",
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "看截图继续",
                "attachments": [
                    {
                        "filename": "screen.png",
                        "content_type": "image/png",
                        "size_bytes": len(VALID_PNG_BYTES),
                        "data_base64": base64.b64encode(VALID_PNG_BYTES).decode("ascii"),
                    }
                ],
            },
        }
    )

    assert result == "Codex saw image"
    assert captured["image_bytes"] == VALID_PNG_BYTES
    assert isinstance(captured["image_path"], Path)
    assert not captured["image_path"].exists()


def test_codex_session_input_rejects_invalid_uploaded_image_attachment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(executor.shutil, "which", lambda name: f"C:/Users/holdo/AppData/Roaming/npm/{name}.cmd")
    monkeypatch.setattr(executor, "_run_backend_command", lambda *args, **kwargs: "unexpected")

    with pytest.raises(ValueError, match="Invalid image attachment data"):
        execute_job(
            {
                "job_id": "job-invalid-image",
                "kind": "session_input",
                "backend": "codex",
                "target_session_id": "codex-session",
                "workspace_root": "E:/work/AgentHub",
                "payload": {
                    "prompt": "看截图继续",
                    "attachments": [
                        {
                            "filename": "screen.png",
                            "content_type": "image/png",
                            "size_bytes": len(b"fake-png-bytes"),
                            "data_base64": base64.b64encode(b"fake-png-bytes").decode("ascii"),
                        }
                    ],
                },
            }
        )


def test_codex_session_input_materializes_file_attachment_as_prompt_context(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(executor.shutil, "which", lambda name: f"C:/Users/holdo/AppData/Roaming/npm/{name}.cmd")

    def fake_run_backend_command(
        args: list[str],
        cwd: str,
        timeout_seconds: int,
        *,
        output_file: str | None = None,
    ) -> str:
        prompt = str(args[-1])
        captured["prompt"] = prompt
        assert "-i" not in args
        marker = "config.txt (text/plain): "
        file_path = Path(prompt.split(marker, 1)[1].splitlines()[0])
        captured["file_path"] = file_path
        captured["file_bytes"] = file_path.read_bytes()
        if output_file:
            Path(output_file).write_text("Codex saw file", encoding="utf-8")
        return "Codex saw file"

    monkeypatch.setattr(executor, "_run_backend_command", fake_run_backend_command)

    result = execute_job(
        {
            "job_id": "job-file",
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "用这个配置测试",
                "attachments": [
                    {
                        "filename": "config.txt",
                        "content_type": "text/plain",
                        "size_bytes": len(b"OPENAI_API_KEY=test"),
                        "data_base64": base64.b64encode(b"OPENAI_API_KEY=test").decode("ascii"),
                    }
                ],
            },
        }
    )

    assert result == "Codex saw file"
    assert "AgentHub attachments" in str(captured["prompt"])
    assert captured["file_bytes"] == b"OPENAI_API_KEY=test"
    assert isinstance(captured["file_path"], Path)
    assert not captured["file_path"].exists()


def test_codex_context_full_falls_back_to_compact_handoff(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    monkeypatch.setattr(executor.shutil, "which", lambda name: f"C:/Users/holdo/AppData/Roaming/npm/{name}.cmd")

    def fake_run_backend_command(
        args: list[str],
        cwd: str,
        timeout_seconds: int,
        *,
        output_file: str | None = None,
    ) -> str:
        calls.append(args)
        if len(calls) == 1:
            raise RuntimeError("codex exited 1: ERROR: Codex ran out of room in the model's context window.")
        if output_file:
            Path(output_file).write_text("AGENTHUB_COMPACT_FALLBACK_OK", encoding="utf-8")
        return "AGENTHUB_COMPACT_FALLBACK_OK"

    monkeypatch.setattr(executor, "_run_backend_command", fake_run_backend_command)

    result = execute_job(
        {
            "job_id": "job-context-full",
            "kind": "session_input",
            "backend": "codex",
            "target_session_id": "codex-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "继续执行",
                "handoff_context": {
                    "session_id": "codex-session",
                    "title": "旧会话",
                    "activity_summary": "之前完成了 API、worker 和部署排查",
                    "timeline": [
                        {"role": "user", "item_type": "user_message", "text": "请完整测试远程控制"},
                        {"role": "system", "item_type": "tool_call", "text": "noisy tool output"},
                        {"role": "assistant", "item_type": "assistant_message", "text": "已定位到 Codex 上下文满"},
                    ],
                },
                "controls": {"approval_mode": "never", "sandbox_mode": "read-only"},
            },
        }
    )

    assert result == "AGENTHUB_COMPACT_FALLBACK_OK"
    assert "resume" in calls[0]
    assert "resume" not in calls[1]
    assert calls[1].index("exec") < calls[1].index("--skip-git-repo-check")
    fallback_prompt = calls[1][-1]
    assert "AgentHub compact handoff" in fallback_prompt
    assert "继续执行" in fallback_prompt
    assert "之前完成了 API、worker 和部署排查" in fallback_prompt
    assert "请完整测试远程控制" in fallback_prompt
    assert "noisy tool output" not in fallback_prompt


def test_backend_failure_includes_combined_cli_diagnostics(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(executor.shutil, "which", lambda name: f"C:/Users/holdo/AppData/Roaming/npm/{name}.cmd")

    monkeypatch.setattr(
        executor.subprocess,
        "Popen",
        fake_popen_factory(stderr="ERROR: Codex ran out of room in the model's context window.", returncode=1),
    )

    with pytest.raises(RuntimeError) as exc_info:
        executor._run_backend_command(["codex", "exec", "resume", "session-id", "继续"], "E:/Work", 30)

    message = str(exc_info.value)
    assert "codex exited 1" in message
    assert "上下文已满" in message
    assert "ran out of room" in message


def test_backend_auth_error_is_reported_even_when_cli_exits_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(executor.shutil, "which", lambda name: f"C:/Users/holdo/AppData/Roaming/npm/{name}.cmd")
    monkeypatch.setattr(
        executor.subprocess,
        "Popen",
        fake_popen_factory(stdout="Error: invalid x-api-key", returncode=0),
    )

    with pytest.raises(RuntimeError) as exc_info:
        executor._run_backend_command(["opencode", "run", "hello"], "E:/Work", 30)

    message = str(exc_info.value)
    assert "opencode exited 0" in message
    assert "invalid x-api-key" in message


def test_session_start_builds_non_interactive_backend_commands() -> None:
    codex = build_session_start_command(
        {
            "kind": "session_start",
            "backend": "codex",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "新建会话",
                "controls": {"model": "gpt-5.4", "sandbox_mode": "danger-full-access", "approval_mode": "never"},
            },
        },
        output_file="C:/Temp/codex-last.txt",
    )
    assert codex[:3] == ["codex", "-C", "E:/work/AgentHub"]
    assert codex.index("--model") < codex.index("exec")
    assert codex.index("--sandbox") < codex.index("exec")
    assert codex.index("--ask-for-approval") < codex.index("exec")
    assert "resume" not in codex
    assert codex[codex.index("exec") + 1 : -1] == [
        "--skip-git-repo-check",
        "--output-last-message",
        "C:/Temp/codex-last.txt",
    ]
    assert codex[-1] == "新建会话"

    claude = build_session_start_command(
        {
            "kind": "session_start",
            "backend": "claude",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "新建 Claude", "controls": {"model": "sonnet", "permission_mode": "plan"}},
        }
    )
    assert claude == ["claude", "-p", "--model", "sonnet", "--permission-mode", "plan", "新建 Claude"]

    kimi = build_session_start_command(
        {
            "kind": "session_start",
            "backend": "kimi",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "新建 Kimi", "controls": {"thinking": True, "yolo": True}},
        }
    )
    assert kimi[:4] == ["kimi", "--quiet", "--work-dir", "E:/work/AgentHub"]
    assert "--thinking" in kimi
    assert "--yolo" in kimi
    assert kimi[-2:] == ["-p", "新建 Kimi"]

    opencode = build_session_start_command(
        {
            "kind": "session_start",
            "backend": "opencode",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "新建 OpenCode",
                "controls": {"model": "openai/gpt-5", "agent": "build", "yolo": True},
            },
        }
    )
    assert opencode[:4] == ["opencode", "run", "--dir", "E:/work/AgentHub"]
    assert "--model" in opencode
    assert "--agent" in opencode
    assert "--dangerously-skip-permissions" in opencode
    assert opencode[-1] == "新建 OpenCode"


def test_opencode_session_start_uses_worker_default_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENTHUB_OPENCODE_MODEL", "opencode/deepseek-v4-flash-free")

    opencode = build_session_start_command(
        {
            "kind": "session_start",
            "backend": "opencode",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "新建 OpenCode", "controls": {"yolo": True}},
        }
    )

    assert opencode[:4] == ["opencode", "run", "--dir", "E:/work/AgentHub"]
    assert opencode[opencode.index("--model") + 1] == "opencode/deepseek-v4-flash-free"
    assert "--dangerously-skip-permissions" in opencode
    assert opencode[-1] == "新建 OpenCode"


def test_session_fork_dry_run_uses_bounded_handoff_prompt() -> None:
    result = execute_job(
        {
            "job_id": "job-fork",
            "kind": "session_fork",
            "backend": "codex",
            "target_session_id": "source-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "继续做新建 session",
                "dry_run": True,
                "handoff_context": {
                    "session_id": "source-session",
                    "title": "AgentHub UI",
                    "workspace_root": "E:/work/AgentHub",
                    "activity_summary": "已经修过移动端回复区",
                    "timeline": [
                        {"role": "user", "item_type": "user_message", "text": "先改 UI"},
                        {"role": "assistant", "item_type": "assistant_message", "text": "回复区已经上移"},
                    ],
                },
            },
        }
    )

    assert result.startswith("dry_run:")
    assert "AgentHub fork handoff" in result
    assert "source-session" in result
    assert "继续做新建 session" in result
    assert "回复区已经上移" in result


def test_session_fork_dry_run_does_not_scan_local_sessions(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_discovery(_roots: list[Path]) -> list[dict[str, object]]:
        raise AssertionError("dry-run session forks should not scan local session stores")

    monkeypatch.setattr(executor, "_discover_local_sessions", fail_discovery)

    result = execute_job(
        {
            "job_id": "job-fork",
            "kind": "session_fork",
            "backend": "codex",
            "target_session_id": "source-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "继续做新建 session", "dry_run": True},
        }
    )

    assert result.startswith("dry_run:")


def test_session_btw_dry_run_uses_one_shot_handoff_without_resuming_source() -> None:
    result = execute_job(
        {
            "job_id": "job-btw",
            "kind": "session_btw",
            "backend": "codex",
            "target_session_id": "source-session",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "quickly compare two storage options",
                "dry_run": True,
                "handoff_context": {
                    "session_id": "source-session",
                    "title": "AgentHub mainline",
                    "workspace_root": "E:/work/AgentHub",
                    "project_name": "AgentHub",
                    "activity_summary": "main session is still running",
                    "timeline": [
                        {"role": "user", "item_type": "user_message", "text": "build the interaction bus"},
                        {"role": "assistant", "item_type": "assistant_message", "text": "implemented plan choices"},
                    ],
                },
                "controls": {"sandbox_mode": "read-only", "approval_mode": "never"},
            },
        }
    )

    assert result.startswith("dry_run:")
    assert "AgentHub BTW side question" in result
    assert "Do not resume or mutate the source runtime session" in result
    assert "source-session" in result
    assert "implemented plan choices" in result
    assert "quickly compare two storage options" in result
    assert " exec resume " not in result


def test_session_input_resolves_secret_refs_into_process_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeClient:
        def resolve_secrets(self, refs: list[str], *, environment: str, namespace: str, job_id: str) -> dict[str, str]:
            captured["secret_request"] = {"refs": refs, "environment": environment, "namespace": namespace, "job_id": job_id}
            return {"OPENAI_API_KEY": "sk-test", "KIMI_API_KEY": "kimi-test"}

    def fake_run_backend_command(
        args: list[str],
        cwd: str,
        timeout_seconds: int,
        *,
        output_file: str | None = None,
        env: dict[str, str] | None = None,
    ) -> str:
        captured["args"] = args
        captured["env"] = env
        return "ok"

    monkeypatch.setattr(executor, "_run_backend_command", fake_run_backend_command)

    result = execute_job(
        {
            "job_id": "job-secret-input",
            "kind": "session_input",
            "target_session_id": "sess-secret",
            "backend": "kimi",
            "workspace_root": "E:/work/AgentHub",
            "payload": {
                "prompt": "use configured api",
                "controls": {
                    "secret_refs": ["OPENAI_API_KEY", "KIMI_API_KEY"],
                    "secret_environment": "test",
                    "secret_namespace": "agenthub",
                },
            },
        },
        client=FakeClient(),
    )

    assert result == "ok"
    assert captured["secret_request"] == {
        "refs": ["OPENAI_API_KEY", "KIMI_API_KEY"],
        "environment": "test",
        "namespace": "agenthub",
        "job_id": "job-secret-input",
    }
    assert captured["env"] == {"OPENAI_API_KEY": "sk-test", "KIMI_API_KEY": "kimi-test"}


def test_session_start_publishes_newly_discovered_session(monkeypatch: pytest.MonkeyPatch) -> None:
    published: list[list[dict[str, object]]] = []
    calls: list[list[str]] = []

    class FakeClient:
        def publish_sessions(self, sessions: list[dict[str, object]]) -> None:
            published.append(sessions)

    monkeypatch.setattr(executor.shutil, "which", lambda name: f"C:/bin/{name}.cmd")
    monkeypatch.setattr(executor, "resolve_codex_executable", lambda: "C:/bin/codex.cmd")
    monkeypatch.setattr(executor, "_discover_local_sessions", lambda roots: list(executor._DISCOVERY_FIXTURE))
    executor._DISCOVERY_FIXTURE = [
        {"session_id": "old", "backend": "codex", "workspace_root": "E:/work/AgentHub", "last_activity_at": "2026-01-01T00:00:00"},
    ]

    def fake_run_backend_command(
        args: list[str],
        cwd: str,
        timeout_seconds: int,
        *,
        output_file: str | None = None,
    ) -> str:
        calls.append(args)
        executor._DISCOVERY_FIXTURE = [
            {"session_id": "old", "backend": "codex", "workspace_root": "E:/work/AgentHub", "last_activity_at": "2026-01-01T00:00:00"},
            {
                "session_id": "new-session",
                "backend": "codex",
                "worker_id": "",
                "workspace_root": "E:/work/AgentHub",
                "project_name": "AgentHub",
                "runtime_session_ref": "codex/new-session.jsonl",
                "last_activity_at": "2026-01-02T00:00:00",
                "runtime_metadata": {},
                },
            ]
        if output_file:
            Path(output_file).write_text("created", encoding="utf-8")
        return "created"

    monkeypatch.setattr(executor, "_run_backend_command", fake_run_backend_command)

    result = execute_job(
        {
            "job_id": "job-start",
            "kind": "session_start",
            "backend": "codex",
            "worker_id": "win-main",
            "workspace_root": "E:/work/AgentHub",
            "payload": {"prompt": "新建会话", "project_name": "AgentHub", "namespace": "default", "title": "新会话"},
        },
        client=FakeClient(),
        worker_id="win-main",
    )

    assert "created_session_id=new-session" in result
    assert published[0][0]["session_id"] == "new-session"
    assert published[0][0]["worker_id"] == "win-main"
    assert published[0][0]["runtime_metadata"]["created_by_job_id"] == "job-start"
    assert calls[0][:3] == ["codex", "-C", "E:/work/AgentHub"]


def test_session_start_matches_windows_workspace_case_insensitively() -> None:
    created = executor._select_created_session(
        before=[
            {
                "session_id": "old",
                "backend": "opencode",
                "workspace_root": "E:/Work/AgentHub",
                "last_activity_at": "2026-01-01T00:00:00",
            }
        ],
        after=[
            {
                "session_id": "old",
                "backend": "opencode",
                "workspace_root": "E:/Work/AgentHub",
                "last_activity_at": "2026-01-01T00:00:00",
            },
            {
                "session_id": "new",
                "backend": "opencode",
                "workspace_root": "E:/Work/AgentHub",
                "last_activity_at": "2026-01-02T00:00:00",
            },
        ],
        backend="opencode",
        workspace_root="E:/work/AgentHub",
    )

    assert created is not None
    assert created["session_id"] == "new"


def test_provider_auth_jobs_are_whitelisted_and_non_blocking() -> None:
    login_result = execute_job({"job_id": "job-login", "kind": "provider_login", "backend": "claude", "payload": {"backend": "claude"}})
    assert "请在 worker 本机运行" in login_result
    assert "claude auth login" in login_result

    logout_result = execute_job(
        {"job_id": "job-logout", "kind": "provider_logout", "backend": "kimi", "payload": {"backend": "kimi", "dry_run": True}}
    )
    assert logout_result.startswith("dry_run:")
    assert "kimi logout" in logout_result
