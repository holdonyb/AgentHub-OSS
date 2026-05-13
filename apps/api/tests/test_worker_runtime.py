from __future__ import annotations

from pathlib import Path
from concurrent.futures import Future
import subprocess
import threading
import time
from typing import Any

import pytest

import agenthub_worker.providers as providers_module
import agenthub_worker.runtime as runtime_module
from agenthub_worker.providers import AgentProvider
from agenthub_worker.runtime import WorkerRuntime


class FakeClient:
    def __init__(self, jobs: list[dict[str, Any]] | None = None) -> None:
        self.jobs = jobs or []
        self.heartbeats: list[dict[str, Any]] = []
        self.published_sessions: list[list[dict[str, Any]]] = []
        self.published_timelines: list[tuple[str, list[dict[str, Any]], bool]] = []
        self.published_providers: list[list[dict[str, Any]]] = []
        self.completed: list[tuple[str, str]] = []
        self.failed: list[tuple[str, str]] = []

    def heartbeat(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.heartbeats.append(payload)
        return {"worker": {"worker_id": "test-worker"}}

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


def test_provider_snapshots_advertise_interaction_support_boundaries() -> None:
    snapshots = providers_module.provider_snapshots_from_capabilities(
        {"codex": True, "claude": True, "kimi": True},
    )
    by_backend = {snapshot["backend"]: snapshot for snapshot in snapshots}

    codex_features = by_backend["codex"]["features"]
    assert codex_features["interaction_bridge"] == "native"
    assert codex_features["request_user_input"] is True
    assert codex_features["plan_exit"] is True

    claude_features = by_backend["claude"]["features"]
    assert claude_features["interaction_bridge"] == "compatibility"
    assert claude_features["plan_result_choices"] is True
    assert claude_features["native_runtime_prompts"] is False

    kimi_features = by_backend["kimi"]["features"]
    assert kimi_features["interaction_bridge"] == "compatibility"
    assert kimi_features["plan_result_choices"] is True
    assert kimi_features["native_runtime_prompts"] is False
    assert kimi_features["structured_protocols"] == ["acp", "wire"]


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
