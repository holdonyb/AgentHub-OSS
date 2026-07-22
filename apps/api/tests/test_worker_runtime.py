from __future__ import annotations

import json
from pathlib import Path
from concurrent.futures import Future
import subprocess
import threading
import time
from typing import Any

import pytest

import agenthub_worker.providers as providers_module
import agenthub_worker.runtime as runtime_module
import agenthub_worker.discovery as discovery_module
from agenthub_worker.providers import AgentProvider
from agenthub_worker.runtime import WorkerRuntime


class FakeClient:
    def __init__(
        self,
        jobs: list[dict[str, Any]] | None = None,
        *,
        heartbeat_worker: dict[str, Any] | None = None,
        runtime_settings: dict[str, Any] | None = None,
    ) -> None:
        self.jobs = jobs or []
        self.heartbeat_worker = heartbeat_worker or {"worker_id": "test-worker"}
        self.runtime_settings = runtime_settings
        self.heartbeats: list[dict[str, Any]] = []
        self.published_sessions: list[list[dict[str, Any]]] = []
        self.published_timelines: list[tuple[str, list[dict[str, Any]], bool]] = []
        self.published_providers: list[list[dict[str, Any]]] = []
        self.completed: list[tuple[str, str]] = []
        self.failed: list[tuple[str, str]] = []

    def heartbeat(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.heartbeats.append(payload)
        worker_payload = dict(self.heartbeat_worker)
        response: dict[str, Any] = {"worker": worker_payload}
        if self.runtime_settings is not None and "runtime_settings" not in worker_payload:
            response["runtime_settings"] = self.runtime_settings
        return response

    def publish_sessions(self, sessions: list[dict[str, Any]]) -> None:
        self.published_sessions.append(sessions)

    def publish_provider_snapshots(self, providers: list[dict[str, Any]]) -> None:
        self.published_providers.append(providers)

    def publish_timeline(self, session_id: str, items: list[dict[str, Any]], *, replace: bool = False) -> None:
        self.published_timelines.append((session_id, items, replace))

    def claim_job(self) -> dict[str, Any] | None:
        if not self.jobs:
            return None
        return self.jobs.pop(0)

    def complete_job(self, job_id: str, result_text: str) -> None:
        self.completed.append((job_id, result_text))

    def fail_job(self, job_id: str, error_text: str) -> None:
        self.failed.append((job_id, error_text))


def test_worker_runtime_keeps_enough_timeline_for_mobile_review() -> None:
    assert runtime_module.MAX_RUNTIME_TIMELINE_ITEMS >= 300


def test_worker_runtime_heartbeats_and_publishes_discovered_sessions() -> None:
    client = FakeClient()
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/work")],
        discover_capabilities=lambda: {"codex": True, "claude": False},
        discover_sessions=lambda roots: [
            {
                "session_id": "codex-1",
                "backend": "codex",
                "workspace_root": str(roots[0]),
                "project_name": "work",
                "runtime_session_ref": "codex-1.jsonl",
            }
        ],
    )

    runtime.run_once()

    assert client.heartbeats == [
        {
            "status": "online",
            "reachable_backends": ["codex"],
            "workspace_roots": ["E:/work"],
            "capabilities": {"codex": True, "claude": False},
            "active_job_ids": [],
        }
    ]
    assert client.published_sessions[0][0]["worker_id"] == "test-worker"
    assert client.published_providers[0][0]["backend"] == "codex"
    assert client.published_providers[0][0]["status"] == "ready"


def test_worker_runtime_marks_discovery_publication_after_summary_and_timeline_succeed() -> None:
    client = FakeClient()
    marked: list[list[dict[str, Any]]] = []
    session = {
        "session_id": "codex-delta",
        "backend": "codex",
        "workspace_root": "E:/Work",
        "project_name": "Work",
        "runtime_session_ref": "delta.jsonl",
        "_agenthub_publication": {"path": "delta.jsonl"},
        "timeline": [{"item_type": "assistant_message", "text": "done"}],
    }
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/Work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=lambda _roots: [session],
        mark_sessions_published=lambda sessions: marked.append(sessions),
    )

    runtime.run_once()

    assert marked == [[session]]
    assert "_agenthub_publication" not in client.published_sessions[0][0]


def test_worker_runtime_does_not_mark_discovery_when_summary_publish_fails() -> None:
    class FailingSummaryClient(FakeClient):
        def publish_sessions(self, sessions: list[dict[str, Any]]) -> None:
            raise RuntimeError("summary unavailable")

    marked: list[list[dict[str, Any]]] = []
    runtime = WorkerRuntime(
        client=FailingSummaryClient(),
        worker_id="test-worker",
        workspace_roots=[Path("E:/Work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=lambda _roots: [{"session_id": "codex-delta", "backend": "codex"}],
        mark_sessions_published=lambda sessions: marked.append(sessions),
    )

    with pytest.raises(RuntimeError, match="summary unavailable"):
        runtime.run_once()

    assert marked == []


def test_worker_runtime_does_not_mark_discovery_when_timeline_publish_fails() -> None:
    class FailingTimelineClient(FakeClient):
        def publish_timeline(
            self, session_id: str, items: list[dict[str, Any]], *, replace: bool = False
        ) -> None:
            raise RuntimeError("timeline unavailable")

    marked: list[list[dict[str, Any]]] = []
    runtime = WorkerRuntime(
        client=FailingTimelineClient(),
        worker_id="test-worker",
        workspace_roots=[Path("E:/Work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=lambda _roots: [
            {
                "session_id": "codex-delta",
                "backend": "codex",
                "timeline": [{"item_type": "assistant_message", "text": "done"}],
            }
        ],
        mark_sessions_published=lambda sessions: marked.append(sessions),
    )

    runtime.run_once()

    assert marked == []


def test_worker_runtime_applies_runtime_settings_from_nested_heartbeat_worker_payload() -> None:
    client = FakeClient(
        heartbeat_worker={
            "worker_id": "test-worker",
            "runtime_settings": {
                "max_concurrent_jobs": 4,
                "job_poll_interval_seconds": 9,
                "heartbeat_interval_seconds": 45,
            },
        }
    )
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=lambda roots: [],
        background_jobs=True,
        max_concurrent_jobs=1,
        job_poll_interval_seconds=5,
        heartbeat_interval_seconds=30,
    )

    try:
        runtime.heartbeat_once()
        assert runtime.max_concurrent_jobs == 4
        assert runtime.job_poll_interval_seconds == 9
        assert runtime.heartbeat_interval_seconds == 45
        assert runtime._executor is not None
        assert runtime._executor._max_workers == 4
    finally:
        runtime.shutdown(wait=False)


def test_worker_runtime_reports_active_background_jobs_in_heartbeat() -> None:
    client = FakeClient()
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=lambda roots: [],
        background_jobs=True,
    )
    active_future: Future[None] = Future()
    with runtime._active_jobs_lock:
        runtime._active_jobs[active_future] = "job-active-1"

    try:
        runtime.heartbeat_once()
    finally:
        active_future.set_result(None)
        runtime.shutdown(wait=False)

    assert client.heartbeats[-1]["active_job_ids"] == ["job-active-1"]


def test_worker_runtime_applies_top_level_runtime_settings_from_heartbeat() -> None:
    client = FakeClient(
        runtime_settings={
            "max_concurrent_jobs": 4,
            "job_poll_interval_seconds": 9,
            "heartbeat_interval_seconds": 45,
        }
    )
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=lambda roots: [],
        background_jobs=True,
    )

    try:
        runtime.heartbeat_once()
    finally:
        runtime.shutdown(wait=False)

    assert runtime.max_concurrent_jobs == 4
    assert runtime.job_poll_interval_seconds == 9
    assert runtime.heartbeat_interval_seconds == 45


def test_worker_runtime_prefers_top_level_runtime_settings_over_stale_nested_worker_payload() -> None:
    class ConflictingHeartbeatClient(FakeClient):
        def heartbeat(self, payload: dict[str, Any]) -> dict[str, Any]:
            self.heartbeats.append(payload)
            return {
                "worker": {
                    "worker_id": "test-worker",
                    "runtime_settings": {
                        "max_concurrent_jobs": 2,
                        "job_poll_interval_seconds": 5,
                        "heartbeat_interval_seconds": 30,
                    },
                },
                "runtime_settings": {
                    "max_concurrent_jobs": 6,
                    "job_poll_interval_seconds": 11,
                    "heartbeat_interval_seconds": 44,
                },
            }

    client = ConflictingHeartbeatClient()
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=lambda roots: [],
        background_jobs=True,
    )

    try:
        runtime.heartbeat_once()
    finally:
        runtime.shutdown(wait=False)

    assert runtime.max_concurrent_jobs == 6
    assert runtime.job_poll_interval_seconds == 11
    assert runtime.heartbeat_interval_seconds == 44


def test_provider_snapshots_advertise_interaction_support_boundaries(monkeypatch) -> None:
    monkeypatch.setattr(
        providers_module.AgentProvider,
        "get_diagnostic",
        lambda provider: {
            "available": True,
            "auth_status": "unknown",
            "feature_overrides": {},
            "models": provider.default_models,
        },
    )
    snapshots = providers_module.provider_snapshots_from_capabilities(
        {"codex": True, "claude": True, "kimi": True, "opencode": True},
    )
    by_backend = {snapshot["backend"]: snapshot for snapshot in snapshots}

    codex_features = by_backend["codex"]["features"]
    assert codex_features["interaction_bridge"] == "native"
    assert codex_features["request_user_input"] is True
    assert codex_features["plan_exit"] is True
    assert codex_features["goal"] is True
    assert codex_features["native_goal_command"] is True
    assert codex_features["native_fast_mode"] is True

    claude_features = by_backend["claude"]["features"]
    assert claude_features["interaction_bridge"] == "compatibility"
    assert claude_features["plan_result_choices"] is True
    assert claude_features["goal"] is True
    assert claude_features["native_runtime_prompts"] is False

    kimi_features = by_backend["kimi"]["features"]
    assert kimi_features["interaction_bridge"] == "compatibility"
    assert kimi_features["plan_result_choices"] is True
    assert kimi_features["native_runtime_prompts"] is False
    assert kimi_features["structured_protocols"] == ["acp", "wire"]

    opencode_features = by_backend["opencode"]["features"]
    assert opencode_features["interaction_bridge"] == "compatibility"
    assert opencode_features["plan_result_choices"] is True
    assert opencode_features["plan_exit"] is True
    assert opencode_features["goal"] is True
    assert opencode_features["native_runtime_prompts"] is False
    assert opencode_features["attachments"] is True
    assert opencode_features["agent"] is True


def test_worker_runtime_uses_separate_session_roots_for_discovery() -> None:
    client = FakeClient()
    seen_roots: list[Path] = []

    def discover_sessions(roots: list[Path]) -> list[dict[str, Any]]:
        seen_roots.extend(roots)
        return []

    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("C:/Work")],
        session_roots=[Path("C:/Users/test/.codex/sessions")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=discover_sessions,
    )

    runtime.run_once()

    assert client.heartbeats[0]["workspace_roots"] == ["C:/Work"]
    assert seen_roots == [Path("C:/Users/test/.codex/sessions")]


def test_kimi_provider_marks_auth_ready_from_local_credentials(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    credential_dir = tmp_path / ".kimi" / "credentials"
    credential_dir.mkdir(parents=True)
    (credential_dir / "kimi-code.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setattr(providers_module.shutil, "which", lambda executable: f"C:/tools/{executable}.exe")

    def fake_run(*_args: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(["kimi", "--version"], 0, stdout="kimi, version 1.24.0", stderr="")

    monkeypatch.setattr(providers_module.subprocess, "run", fake_run)

    snapshot = AgentProvider(backend="kimi", executable="kimi").snapshot(available=True)

    assert snapshot["auth_status"] == "ready"
    assert snapshot["diagnostics"]["auth_status"] == "ready"


def test_claude_provider_uses_auth_status_command(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(providers_module.shutil, "which", lambda executable: f"C:/tools/{executable}.exe")

    def fake_run(args: list[str], *_rest: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        if args[:3] == ["claude", "auth", "status"]:
            return subprocess.CompletedProcess(args, 0, stdout='{"loggedIn": true}', stderr="")
        if args[:2] == ["claude", "agents"]:
            return subprocess.CompletedProcess(args, 0, stdout="Built-in agents:\n  Plan · inherit\n", stderr="")
        return subprocess.CompletedProcess(args, 0, stdout="claude 1.0.0", stderr="")

    monkeypatch.setattr(providers_module.subprocess, "run", fake_run)

    snapshot = AgentProvider(backend="claude", executable="claude").snapshot(available=True)

    assert snapshot["auth_status"] == "ready"
    assert snapshot["diagnostics"]["auth_status"] == "ready"
    assert snapshot["features"]["native_goal_command"] is False
    assert snapshot["features"]["native_plan_command"] is False
    assert snapshot["features"]["plan_agent"] is True


def test_claude_provider_can_advertise_tmux_bridge_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENTHUB_CLAUDE_INTERACTIVE_BRIDGE", "1")
    monkeypatch.setattr(providers_module.shutil, "which", lambda executable: f"C:/tools/{executable}.exe")
    monkeypatch.setattr(providers_module, "_preferred_claude_interactive_bridge", lambda: "tmux")

    def fake_run(args: list[str], *_rest: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        if args[:3] == ["claude", "auth", "status"]:
            return subprocess.CompletedProcess(args, 0, stdout='{"loggedIn": true}', stderr="")
        if args[:2] == ["claude", "agents"]:
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
        return subprocess.CompletedProcess(args, 0, stdout="claude 1.0.0", stderr="")

    monkeypatch.setattr(providers_module.subprocess, "run", fake_run)

    snapshot = AgentProvider(backend="claude", executable="claude").snapshot(available=True)

    assert snapshot["features"]["interaction_bridge"] == "tmux"
    assert snapshot["features"]["native_runtime_prompts"] is True


def test_claude_provider_can_advertise_psmux_bridge_from_env_on_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENTHUB_CLAUDE_INTERACTIVE_BRIDGE", "1")
    monkeypatch.setattr(providers_module.shutil, "which", lambda executable: f"C:/tools/{executable}.exe")
    monkeypatch.setattr(providers_module, "_preferred_claude_interactive_bridge", lambda: "psmux")

    def fake_run(args: list[str], *_rest: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        if args[:3] == ["claude", "auth", "status"]:
            return subprocess.CompletedProcess(args, 0, stdout='{"loggedIn": true}', stderr="")
        if args[:2] == ["claude", "agents"]:
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
        return subprocess.CompletedProcess(args, 0, stdout="claude 1.0.0", stderr="")

    monkeypatch.setattr(providers_module.subprocess, "run", fake_run)

    snapshot = AgentProvider(backend="claude", executable="claude").snapshot(available=True)

    assert snapshot["features"]["interaction_bridge"] == "psmux"
    assert snapshot["features"]["native_runtime_prompts"] is True


def test_codex_provider_uses_feature_list_probe_for_native_goal_command(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(providers_module.shutil, "which", lambda executable: f"C:/tools/{executable}.exe")

    def fake_run(args: list[str], *_rest: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        if args[:3] == ["codex", "debug", "models"]:
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=json.dumps({"models": [{"slug": "gpt-5.6-sol", "display_name": "GPT-5.6-Sol"}]}),
                stderr="",
            )
        if args[:3] == ["codex", "features", "list"]:
            return subprocess.CompletedProcess(args, 0, stdout="goals stable false\n", stderr="")
        if args[:3] == ["codex", "login", "status"]:
            return subprocess.CompletedProcess(args, 0, stdout="Logged in", stderr="")
        return subprocess.CompletedProcess(args, 0, stdout="codex-cli 0.133.0", stderr="")

    monkeypatch.setattr(providers_module.subprocess, "run", fake_run)

    snapshot = AgentProvider(backend="codex", executable="codex").snapshot(available=True)

    assert snapshot["auth_status"] == "ready"
    assert snapshot["diagnostics"]["auth_status"] == "ready"
    assert snapshot["features"]["native_goal_command"] is False
    assert snapshot["models"] == [{"id": "gpt-5.6-sol", "label": "GPT-5.6-Sol"}]


def test_kimi_provider_uses_models_declared_in_config(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    kimi_home = tmp_path / ".kimi"
    kimi_home.mkdir(parents=True)
    (kimi_home / "config.toml").write_text(
        '\n'.join(
            [
                'default_model = "kimi-code/kimi-for-coding"',
                '',
                '[models."kimi-code/kimi-for-coding"]',
                'provider = "managed:kimi-code"',
                'model = "kimi-for-coding"',
                '',
                '[models."kimi-code/kimi-thinking"]',
                'provider = "managed:kimi-code"',
                'model = "kimi-thinking"',
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("KIMI_HOME", str(kimi_home))
    monkeypatch.setattr(providers_module.shutil, "which", lambda executable: f"C:/tools/{executable}.exe")

    def fake_run(*_args: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(["kimi", "--version"], 0, stdout="kimi, version 1.24.0", stderr="")

    monkeypatch.setattr(providers_module.subprocess, "run", fake_run)

    snapshot = AgentProvider(backend="kimi", executable="kimi").snapshot(available=True)

    assert [model["id"] for model in snapshot["models"]] == [
        "kimi-code/kimi-for-coding",
        "kimi-code/kimi-thinking",
    ]


def test_opencode_provider_uses_credentials_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(providers_module.shutil, "which", lambda executable: f"C:/tools/{executable}.exe")

    def fake_run(args: list[str], *_rest: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        if args[:2] == ["opencode", "models"]:
            return subprocess.CompletedProcess(
                args,
                0,
                stdout="openai/gpt-5\nanthropic/claude-sonnet-4\n",
                stderr="",
            )
        if args[:3] == ["opencode", "providers", "list"]:
            return subprocess.CompletedProcess(args, 0, stdout="1 credentials", stderr="")
        if args[:3] == ["opencode", "agent", "list"]:
            return subprocess.CompletedProcess(args, 0, stdout="plan (primary)\npermission: plan_exit\n", stderr="")
        return subprocess.CompletedProcess(args, 0, stdout="opencode 1.15.7", stderr="")

    monkeypatch.setattr(providers_module.subprocess, "run", fake_run)

    snapshot = AgentProvider(backend="opencode", executable="opencode").snapshot(available=True)

    assert snapshot["auth_status"] == "ready"
    assert snapshot["diagnostics"]["auth_status"] == "ready"
    assert snapshot["features"]["native_goal_command"] is False
    assert snapshot["features"]["native_plan_command"] is False
    assert snapshot["features"]["plan_agent"] is True
    assert snapshot["models"] == [
        {"id": "openai/gpt-5", "label": "openai/gpt-5"},
        {"id": "anthropic/claude-sonnet-4", "label": "anthropic/claude-sonnet-4"},
    ]


def test_opencode_provider_accepts_resolved_config_api_key_without_saved_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(providers_module.shutil, "which", lambda executable: f"C:/tools/{executable}.exe")

    def fake_run(args: list[str], *_rest: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        if args[:3] == ["opencode", "providers", "list"]:
            return subprocess.CompletedProcess(args, 0, stdout="0 credentials", stderr="")
        if args[:3] == ["opencode", "debug", "config"]:
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=json.dumps(
                    {
                        "model": "anthropic/claude-sonnet-4-5",
                        "provider": {
                            "anthropic": {
                                "options": {
                                    "apiKey": "env-backed-key",
                                }
                            }
                        },
                    }
                ),
                stderr="",
            )
        return subprocess.CompletedProcess(args, 0, stdout="opencode 1.15.7", stderr="")

    monkeypatch.setattr(providers_module.subprocess, "run", fake_run)

    snapshot = AgentProvider(backend="opencode", executable="opencode").snapshot(available=True)

    assert snapshot["auth_status"] == "ready"
    assert snapshot["diagnostics"]["auth_status"] == "ready"


def test_opencode_provider_accepts_enabled_provider_env_key_without_saved_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(providers_module.shutil, "which", lambda executable: f"C:/tools/{executable}.exe")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    def fake_run(args: list[str], *_rest: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        if args[:3] == ["opencode", "providers", "list"]:
            return subprocess.CompletedProcess(args, 0, stdout="0 credentials", stderr="")
        if args[:3] == ["opencode", "debug", "config"]:
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=json.dumps(
                    {
                        "model": "anthropic/claude-sonnet-4-5",
                        "enabled_providers": ["anthropic"],
                    }
                ),
                stderr="",
            )
        return subprocess.CompletedProcess(args, 0, stdout="opencode 1.15.7", stderr="")

    monkeypatch.setattr(providers_module.subprocess, "run", fake_run)

    snapshot = AgentProvider(backend="opencode", executable="opencode").snapshot(available=True)

    assert snapshot["auth_status"] == "ready"
    assert snapshot["diagnostics"]["auth_status"] == "ready"


def test_provider_probes_use_resolved_windows_executable_without_rewriting_args(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        providers_module.shutil,
        "which",
        lambda executable: f"C:/Users/test/AppData/Roaming/npm/{executable}.CMD",
    )
    captured: list[tuple[list[str], str | None]] = []

    def fake_run(args: list[str], *_rest: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
        captured.append((list(args), kwargs.get("executable")))
        if args[:2] == ["opencode", "models"]:
            return subprocess.CompletedProcess(args, 0, stdout="openai/gpt-5\n", stderr="")
        if args[:3] == ["opencode", "providers", "list"]:
            return subprocess.CompletedProcess(args, 0, stdout="1 credentials", stderr="")
        if args[:3] == ["opencode", "agent", "list"]:
            return subprocess.CompletedProcess(args, 0, stdout="plan (primary)\npermission: plan_exit\n", stderr="")
        return subprocess.CompletedProcess(args, 0, stdout="opencode 1.15.7", stderr="")

    monkeypatch.setattr(providers_module.subprocess, "run", fake_run)

    snapshot = AgentProvider(backend="opencode", executable="opencode").snapshot(available=True)

    assert snapshot["auth_status"] == "ready"
    assert (
        ["opencode", "--version"],
        "C:/Users/test/AppData/Roaming/npm/opencode.CMD",
    ) in captured
    assert (
        ["opencode", "models"],
        "C:/Users/test/AppData/Roaming/npm/opencode.CMD",
    ) in captured
    assert (
        ["opencode", "providers", "list"],
        "C:/Users/test/AppData/Roaming/npm/opencode.CMD",
    ) in captured
    assert (
        ["opencode", "agent", "list"],
        "C:/Users/test/AppData/Roaming/npm/opencode.CMD",
    ) in captured


def test_worker_runtime_batches_and_trims_large_session_discovery_payloads() -> None:
    client = FakeClient()
    long_text = "x" * 6000
    timeline = [
        {
            "seq": index,
            "item_type": "assistant_message",
            "role": "assistant",
            "text": long_text,
            "payload": {"kind": "assistant"},
        }
        for index in range(runtime_module.MAX_RUNTIME_TIMELINE_ITEMS + 30)
    ]
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=lambda roots: [
            {
                "session_id": f"codex-{index}",
                "backend": "codex",
                "workspace_root": str(roots[0]),
                "project_name": "work",
                "runtime_session_ref": f"codex-{index}.jsonl",
                "activity_summary": long_text,
                "last_message": long_text,
                "timeline": timeline,
                "runtime_metadata": {
                    "messages": [
                        {"role": "user", "text": long_text},
                        {"role": "assistant", "text": long_text},
                        {"role": "system", "text": long_text},
                    ],
                    "timeline": timeline,
                },
            }
            for index in range(61)
        ],
    )

    runtime.run_once()

    assert [len(batch) for batch in client.published_sessions] == [25, 25, 11]
    assert all(
        runtime_module._json_payload_bytes({"worker_id": "test-worker", "sessions": batch})
        <= runtime_module.MAX_DISCOVERY_PAYLOAD_BYTES
        for batch in client.published_sessions
    )
    first = client.published_sessions[0][0]
    assert first["worker_id"] == "test-worker"
    assert "timeline" not in first
    assert "timeline" not in first["runtime_metadata"]
    assert len(first["activity_summary"]) <= 503
    assert len(first["last_message"]) <= 1203
    assert len(first["runtime_metadata"]["messages"]) == 3
    assert first["runtime_metadata"]["messages"][0]["text"] == long_text
    assert first["runtime_metadata"]["messages"][1]["text"] == long_text
    assert len(first["runtime_metadata"]["messages"][2]["text"]) <= runtime_module.MAX_TOOL_MESSAGE_CHARS
    assert len(client.published_timelines) > 61
    assert all(
        runtime_module._json_payload_bytes({"worker_id": "test-worker", "items": items, "replace": replace})
        <= runtime_module.MAX_TIMELINE_PAYLOAD_BYTES
        for _, items, replace in client.published_timelines
    )
    timeline_session_id, timeline_items, replace = client.published_timelines[0]
    assert timeline_session_id == "codex-0"
    assert replace is True
    assert all(item["text"] == long_text for item in timeline_items)


def test_worker_runtime_batch_sizing_does_not_reserialize_accumulated_lists(monkeypatch: pytest.MonkeyPatch) -> None:
    real_json_payload_bytes = runtime_module._json_payload_bytes
    serialized_sessions_lengths: list[int] = []
    serialized_timeline_lengths: list[int] = []

    def tracking_json_payload_bytes(value: Any) -> int:
        if isinstance(value, dict) and isinstance(value.get("sessions"), list):
            serialized_sessions_lengths.append(len(value["sessions"]))
        if isinstance(value, dict) and isinstance(value.get("items"), list):
            serialized_timeline_lengths.append(len(value["items"]))
        return real_json_payload_bytes(value)

    monkeypatch.setattr(runtime_module, "_json_payload_bytes", tracking_json_payload_bytes)

    session_batches = runtime_module.session_batches(
        [
            {
                "session_id": f"codex-{index}",
                "runtime_metadata": {"timeline": []},
            }
            for index in range(10)
        ],
        "test-worker",
    )
    timeline_batches = runtime_module.timeline_batches(
        [
            {
                "session_id": "codex-1",
                "runtime_metadata": {
                    "timeline": [
                        {"seq": index, "item_type": "assistant_message", "text": "x" * 100}
                        for index in range(10)
                    ]
                },
            }
        ],
        "test-worker",
    )

    assert [len(batch) for batch in session_batches] == [10]
    assert len(timeline_batches) == 1
    assert len(timeline_batches[0].items) == 10
    assert serialized_sessions_lengths == [0]
    assert serialized_timeline_lengths == [0]


def test_worker_runtime_skips_unchanged_timeline_publish_on_next_tick() -> None:
    client = FakeClient()
    timeline = [
        {
            "seq": 1,
            "item_type": "assistant_message",
            "role": "assistant",
            "text": "同一份 transcript 不应该每轮重复上传",
        }
    ]
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=lambda roots: [
            {
                "session_id": "codex-traffic",
                "backend": "codex",
                "workspace_root": str(roots[0]),
                "project_name": "work",
                "runtime_session_ref": "codex-traffic.jsonl",
                "timeline": timeline,
            }
        ],
    )

    runtime.run_once()
    runtime.run_once()

    assert len(client.published_timelines) == 1

    timeline.append(
        {
            "seq": 2,
            "item_type": "assistant_message",
            "role": "assistant",
            "text": "变更后才需要再次上传",
        }
    )
    runtime.run_once()

    assert len(client.published_timelines) == 2


def test_worker_runtime_keeps_long_conversation_text_but_marks_truncated_tool_output() -> None:
    client = FakeClient()
    long_conversation = "assistant full text " * 400
    long_tool_output = "tool output " * 400
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=lambda roots: [
            {
                "session_id": "codex-long-text",
                "backend": "codex",
                "workspace_root": str(roots[0]),
                "project_name": "work",
                "runtime_session_ref": "codex-long-text.jsonl",
                "timeline": [
                    {
                        "seq": 1,
                        "item_type": "assistant_message",
                        "role": "assistant",
                        "text": long_conversation,
                    },
                    {
                        "seq": 2,
                        "item_type": "tool_call",
                        "role": "tool",
                        "text": long_tool_output,
                    },
                ],
            }
        ],
    )

    runtime.run_once()

    _, items, _ = client.published_timelines[0]
    assert items[0]["text"] == long_conversation
    assert len(items[1]["text"]) <= 1300
    assert "[AgentHub truncated this item]" in items[1]["text"]
    assert long_tool_output not in items[1]["text"]


def test_worker_runtime_optional_runtime_surfaces_do_not_block_session_sync() -> None:
    class FlakyClient(FakeClient):
        def publish_provider_snapshots(self, providers: list[dict[str, Any]]) -> None:
            raise RuntimeError("old api does not have provider endpoint")

        def publish_timeline(self, session_id: str, items: list[dict[str, Any]], *, replace: bool = False) -> None:
            raise RuntimeError("timeline endpoint temporarily unavailable")

    client = FlakyClient()
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=lambda roots: [
            {
                "session_id": "codex-1",
                "backend": "codex",
                "workspace_root": str(roots[0]),
                "project_name": "work",
                "runtime_session_ref": "codex-1.jsonl",
                "runtime_metadata": {
                    "timeline": [
                        {
                            "seq": 1,
                            "item_type": "user_message",
                            "role": "user",
                            "text": "hello",
                        }
                    ]
                },
            }
        ],
    )

    runtime.run_once()

    assert client.published_sessions
    assert client.completed == []
    assert client.failed == []


def test_worker_runtime_completes_claimed_jobs() -> None:
    client = FakeClient(jobs=[{"job_id": "job_1", "kind": "health_check", "payload": {}}])
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[],
        discover_capabilities=lambda: {},
        discover_sessions=lambda roots: [],
    )

    runtime.run_once()

    assert client.completed == [("job_1", "ok")]
    assert client.failed == []


def test_worker_runtime_background_jobs_do_not_block_session_sync(monkeypatch: pytest.MonkeyPatch) -> None:
    started = threading.Event()
    release = threading.Event()

    def slow_execute_job(job: dict[str, Any], **kwargs: Any) -> str:
        started.set()
        release.wait(timeout=3)
        return "slow-ok"

    monkeypatch.setattr(runtime_module, "execute_job", slow_execute_job)
    client = FakeClient(jobs=[{"job_id": "job_slow", "kind": "session_input", "payload": {"prompt": "slow"}}])
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=lambda roots: [
            {
                "session_id": "codex-1",
                "backend": "codex",
                "workspace_root": str(roots[0]),
                "project_name": "work",
                "runtime_session_ref": "codex-1.jsonl",
            }
        ],
        background_jobs=True,
        max_concurrent_jobs=1,
    )

    try:
        runtime.run_once()
        assert started.wait(timeout=1)
        assert client.published_sessions, "long-running jobs must not block session discovery sync"
        assert client.completed == []
    finally:
        release.set()
        runtime.shutdown(wait=True)

    assert client.completed == [("job_slow", "slow-ok")]
    assert client.failed == []


def test_worker_runtime_background_poller_claims_while_discovery_is_busy(monkeypatch: pytest.MonkeyPatch) -> None:
    discovery_started = threading.Event()
    release_discovery = threading.Event()

    def fast_execute_job(job: dict[str, Any], **kwargs: Any) -> str:
        return "late-ok"

    def discover_sessions(roots: list[Path]) -> list[dict[str, Any]]:
        discovery_started.set()
        release_discovery.wait(timeout=3)
        return []

    monkeypatch.setattr(runtime_module, "execute_job", fast_execute_job)
    client = FakeClient()
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=discover_sessions,
        background_jobs=True,
        max_concurrent_jobs=1,
        job_poll_interval_seconds=1,
    )

    run_thread = threading.Thread(target=runtime.run_once)
    try:
        runtime.start_job_poller()
        run_thread.start()
        assert discovery_started.wait(timeout=1)
        client.jobs.append({"job_id": "job_late", "kind": "session_input", "payload": {"prompt": "late"}})
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and client.completed == []:
            time.sleep(0.05)
        assert client.completed == [("job_late", "late-ok")]
    finally:
        release_discovery.set()
        run_thread.join(timeout=2)
        runtime.shutdown(wait=True)


def test_worker_runtime_heartbeat_poller_runs_while_discovery_is_busy() -> None:
    discovery_started = threading.Event()
    release_discovery = threading.Event()

    def discover_sessions(roots: list[Path]) -> list[dict[str, Any]]:
        discovery_started.set()
        release_discovery.wait(timeout=3)
        return []

    client = FakeClient()
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[Path("E:/work")],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=discover_sessions,
        background_jobs=True,
        heartbeat_interval_seconds=1,
    )

    run_thread = threading.Thread(target=runtime.run_once)
    try:
        runtime.start_heartbeat_poller()
        run_thread.start()
        assert discovery_started.wait(timeout=1)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and len(client.heartbeats) < 2:
            time.sleep(0.05)
        assert len(client.heartbeats) >= 2
    finally:
        release_discovery.set()
        run_thread.join(timeout=2)
        runtime.shutdown(wait=True)


def test_worker_runtime_claims_jobs_before_slow_session_discovery() -> None:
    order: list[str] = []

    class OrderedClient(FakeClient):
        def claim_job(self) -> dict[str, Any] | None:
            order.append("claim")
            return super().claim_job()

        def complete_job(self, job_id: str, result_text: str) -> None:
            order.append("complete")
            super().complete_job(job_id, result_text)

    def discover_sessions(roots: list[Path]) -> list[dict[str, Any]]:
        order.append("discover")
        return []

    client = OrderedClient(jobs=[{"job_id": "job_fast", "kind": "health_check", "payload": {}}])
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[],
        discover_capabilities=lambda: {"codex": True},
        discover_sessions=discover_sessions,
    )

    runtime.run_once()

    assert order[:3] == ["claim", "complete", "claim"]
    assert order[3] == "discover"
    assert order[-1] == "claim"
    assert client.completed == [("job_fast", "ok")]


def test_worker_runtime_fails_job_when_execution_errors() -> None:
    client = FakeClient(jobs=[{"job_id": "job_2", "kind": "unknown", "payload": {}}])
    runtime = WorkerRuntime(
        client=client,
        worker_id="test-worker",
        workspace_roots=[],
        discover_capabilities=lambda: {},
        discover_sessions=lambda roots: [],
    )

    runtime.run_once()

    assert client.completed == []
    assert client.failed
    assert client.failed[0][0] == "job_2"
    assert "Unknown job kind" in client.failed[0][1]


def test_run_forever_backs_off_after_transient_runtime_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    class BrokenRuntime:
        calls = 0

        def run_once(self) -> None:
            self.calls += 1
            raise RuntimeError("api is temporarily down")

    broken = BrokenRuntime()
    sleeps: list[int] = []

    def fake_sleep(seconds: int) -> None:
        sleeps.append(seconds)
        raise KeyboardInterrupt

    monkeypatch.setattr(runtime_module.time, "sleep", fake_sleep)

    with pytest.raises(KeyboardInterrupt):
        runtime_module.run_forever(broken, 7)

    assert broken.calls == 1
    assert sleeps == [7]


def test_discover_opencode_sessions_uses_cli_json_and_workspace_filter(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    workspace = tmp_path / "AgentHub"
    other_workspace = tmp_path / "OtherRepo"
    workspace.mkdir()
    other_workspace.mkdir()

    class FakeCompleted:
        returncode = 0
        stdout = json.dumps(
            [
                {
                    "id": "open-1",
                    "title": "OpenCode planning",
                    "path": str(workspace),
                    "updatedAt": "2026-05-22T14:00:00Z",
                    "summary": "梳理 OpenCode provider 接入",
                },
                {
                    "id": "open-2",
                    "title": "Other repo",
                    "path": str(other_workspace),
                    "updatedAt": "2026-05-22T13:00:00Z",
                },
            ]
        )

    monkeypatch.setattr(discovery_module.shutil, "which", lambda _: "C:/mock/opencode.cmd")
    monkeypatch.setattr(discovery_module.subprocess, "run", lambda *args, **kwargs: FakeCompleted())

    sessions = discovery_module.discover_opencode_sessions([workspace])

    assert len(sessions) == 1
    assert sessions[0].backend == "opencode"
    assert sessions[0].session_id == "open-1"
    assert sessions[0].workspace_root == discovery_module.normalize_workspace_root(str(workspace))
    assert sessions[0].display_title == "OpenCode planning"


def test_discover_opencode_sessions_accepts_current_cli_directory_schema(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[dict[str, Any]] = []
    workspace = tmp_path / "AgentHub"
    workspace.mkdir()

    class FakeCompleted:
        returncode = 0
        stdout = json.dumps(
            [
                {
                    "id": "ses_1ad4977c4ffe1sNEEleKcTSJKK",
                    "title": "New session",
                    "directory": str(workspace),
                    "updated": 1779504156927,
                    "created": 1779504154684,
                }
            ]
        )

    monkeypatch.setattr(discovery_module.shutil, "which", lambda _: "C:/mock/opencode.cmd")

    def fake_run(*args: Any, **kwargs: Any) -> FakeCompleted:
        calls.append({"args": args, "kwargs": kwargs})
        return FakeCompleted()

    monkeypatch.setattr(discovery_module.subprocess, "run", fake_run)

    sessions = discovery_module.discover_opencode_sessions([workspace])

    assert len(sessions) == 1
    assert sessions[0].session_id == "ses_1ad4977c4ffe1sNEEleKcTSJKK"
    assert sessions[0].workspace_root == discovery_module.normalize_workspace_root(str(workspace))
    assert sessions[0].last_activity_at.year == 2026
    assert calls[0]["kwargs"]["executable"] == "C:/mock/opencode.cmd"


def test_discover_opencode_sessions_skips_agent_store_roots(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    monkeypatch.setattr(discovery_module.shutil, "which", lambda _: "C:/mock/opencode.cmd")
    monkeypatch.setattr(discovery_module.subprocess, "run", lambda *args, **kwargs: calls.append({"args": args, "kwargs": kwargs}))

    sessions = discovery_module.discover_opencode_sessions([Path("C:/Users/me/.local/share/opencode")])

    assert sessions == []
    assert calls == []
