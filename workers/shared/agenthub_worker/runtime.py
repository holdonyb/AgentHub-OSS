from __future__ import annotations

import time
import hashlib
import json
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
import sys
import threading
from typing import Any, Protocol

from agenthub_worker.executor import execute_job
from agenthub_worker.paths import normalize_workspace_root
from agenthub_worker.providers import provider_snapshots_from_capabilities

SESSION_DISCOVERY_BATCH_SIZE = 25
MAX_DISCOVERY_PAYLOAD_BYTES = 700_000
MAX_TIMELINE_PAYLOAD_BYTES = 700_000
MAX_ACTIVITY_CHARS = 500
MAX_TOOL_MESSAGE_CHARS = 1200
MAX_CONVERSATION_MESSAGE_CHARS = 20_000
MAX_MESSAGE_CHARS = MAX_TOOL_MESSAGE_CHARS
MAX_RUNTIME_MESSAGES = 8
MAX_RUNTIME_TIMELINE_ITEMS = 300
TRUNCATION_MARKER = "\n\n[AgentHub truncated this item]"
CONVERSATION_TIMELINE_TYPES = {"user_message", "assistant_message", "reasoning"}
CONVERSATION_MESSAGE_ROLES = {"user", "assistant"}


class WorkerClient(Protocol):
    def heartbeat(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    def publish_sessions(self, sessions: list[dict[str, Any]]) -> None: ...

    def publish_provider_snapshots(self, providers: list[dict[str, Any]]) -> None: ...

    def publish_timeline(self, session_id: str, items: list[dict[str, Any]], *, replace: bool = False) -> None: ...

    def request_permission(self, permission: dict[str, Any]) -> dict[str, Any]: ...

    def get_permission(self, permission_id: str) -> dict[str, Any]: ...

    def resolve_secrets(self, refs: list[str], *, environment: str, namespace: str, job_id: str) -> dict[str, str]: ...

    def claim_job(self) -> dict[str, Any] | None: ...

    def complete_job(self, job_id: str, result_text: str) -> None: ...

    def fail_job(self, job_id: str, error_text: str) -> None: ...

    def upload_transfer(
        self,
        transfer_id: str,
        path: Path,
        *,
        content_type: str,
        filename: str,
        modified_at: str,
    ) -> dict[str, Any]: ...

    def download_transfer(self, transfer_id: str, destination: Path) -> dict[str, Any]: ...


@dataclass
class WorkerRuntime:
    client: WorkerClient
    worker_id: str
    workspace_roots: list[Path]
    discover_capabilities: Callable[[], dict[str, bool]]
    discover_sessions: Callable[[list[Path]], list[dict[str, Any]]]
    session_roots: list[Path] | None = None
    background_jobs: bool = False
    max_concurrent_jobs: int = 2
    job_poll_interval_seconds: float = 5.0
    heartbeat_interval_seconds: float = 30.0

    def __post_init__(self) -> None:
        self.max_concurrent_jobs = self._normalize_max_concurrent_jobs(self.max_concurrent_jobs)
        self.job_poll_interval_seconds = self._normalize_interval_seconds(self.job_poll_interval_seconds)
        self.heartbeat_interval_seconds = self._normalize_interval_seconds(self.heartbeat_interval_seconds)
        self._executor: ThreadPoolExecutor | None = self._build_executor() if self.background_jobs else None
        self._active_jobs: dict[Future[None], str] = {}
        self._active_jobs_lock = threading.Lock()
        self._job_poller_stop: threading.Event | None = None
        self._job_poller_thread: threading.Thread | None = None
        self._heartbeat_poller_stop: threading.Event | None = None
        self._heartbeat_poller_thread: threading.Thread | None = None
        self._published_timeline_digests: dict[str, str] = {}
        self._pending_max_concurrent_jobs: int | None = None

    @staticmethod
    def _normalize_max_concurrent_jobs(value: Any) -> int:
        return max(1, int(value or 1))

    @staticmethod
    def _normalize_interval_seconds(value: Any) -> float:
        return max(1.0, float(value or 1.0))

    def _build_executor(self) -> ThreadPoolExecutor:
        return ThreadPoolExecutor(max_workers=self.max_concurrent_jobs, thread_name_prefix="agenthub-job")

    def _rebuild_executor(self) -> None:
        previous = self._executor
        self._executor = self._build_executor()
        if previous is not None:
            previous.shutdown(wait=False)

    def _apply_runtime_settings(self, settings: dict[str, Any] | None) -> None:
        if not isinstance(settings, dict):
            return
        next_max = self._normalize_max_concurrent_jobs(settings.get("max_concurrent_jobs", self.max_concurrent_jobs))
        next_job_poll = self._normalize_interval_seconds(
            settings.get("job_poll_interval_seconds", self.job_poll_interval_seconds)
        )
        next_heartbeat = self._normalize_interval_seconds(
            settings.get("heartbeat_interval_seconds", self.heartbeat_interval_seconds)
        )
        if next_max != self.max_concurrent_jobs:
            self._set_max_concurrent_jobs(next_max)
        self.job_poll_interval_seconds = next_job_poll
        self.heartbeat_interval_seconds = next_heartbeat

    def _drain_jobs(self) -> None:
        if self.background_jobs:
            self._drain_jobs_background()
            return
        while True:
            job = self.client.claim_job()
            if job is None:
                break
            job_id = job["job_id"]
            try:
                self.client.complete_job(job_id, execute_job(job, client=self.client, worker_id=self.worker_id))
            except Exception as exc:  # noqa: BLE001 - job failure must be reported to the control plane
                self.client.fail_job(job_id, str(exc))

    def _run_job_and_report(self, job: dict[str, Any]) -> None:
        job_id = str(job["job_id"])
        try:
            result = execute_job(job, client=self.client, worker_id=self.worker_id)
        except Exception as exc:  # noqa: BLE001 - job failure must be reported to the control plane
            try:
                self.client.fail_job(job_id, str(exc))
            except Exception as report_exc:  # noqa: BLE001 - keep worker alive even if API reporting fails
                print(f"AgentHub worker failed to report job failure for {job_id}: {report_exc}", file=sys.stderr)
            return
        try:
            self.client.complete_job(job_id, result)
        except Exception as exc:  # noqa: BLE001 - stale recovery will make the running job visible again
            print(f"AgentHub worker failed to report job completion for {job_id}: {exc}", file=sys.stderr)

    def _collect_finished_jobs(self) -> None:
        finished = [future for future in self._active_jobs if future.done()]
        for future in finished:
            job_id = self._active_jobs.pop(future)
            try:
                future.result()
            except Exception as exc:  # noqa: BLE001 - _run_job_and_report should catch, this is defensive
                print(f"AgentHub worker job task crashed for {job_id}: {exc}", file=sys.stderr)
        if not self._active_jobs and self._pending_max_concurrent_jobs is not None:
            self._swap_executor_locked(self._pending_max_concurrent_jobs)

    def _active_job_ids_snapshot(self) -> list[str]:
        if not self.background_jobs:
            return []
        with self._active_jobs_lock:
            self._collect_finished_jobs()
            return sorted(self._active_jobs.values())

    def _drain_jobs_background(self) -> None:
        if self._executor is None:
            raise RuntimeError("background job executor is not initialized")
        with self._active_jobs_lock:
            self._collect_finished_jobs()
            while len(self._active_jobs) < self.max_concurrent_jobs:
                job = self.client.claim_job()
                if job is None:
                    break
                job_id = str(job["job_id"])
                future = self._executor.submit(self._run_job_and_report, job)
                self._active_jobs[future] = job_id
                self._collect_finished_jobs()

    def start_job_poller(self) -> None:
        if not self.background_jobs:
            return
        if self._job_poller_thread is not None and self._job_poller_thread.is_alive():
            return
        stop_event = threading.Event()
        self._job_poller_stop = stop_event

        def poll_loop() -> None:
            while not stop_event.wait(self.job_poll_interval_seconds):
                try:
                    self._drain_jobs_background()
                except Exception as exc:  # noqa: BLE001 - polling should not kill the worker
                    print(f"AgentHub worker job poll failed: {exc}", file=sys.stderr)

        self._job_poller_thread = threading.Thread(target=poll_loop, name="agenthub-job-poller", daemon=True)
        self._job_poller_thread.start()

    def stop_job_poller(self) -> None:
        if self._job_poller_stop is not None:
            self._job_poller_stop.set()
        if self._job_poller_thread is not None and self._job_poller_thread is not threading.current_thread():
            self._job_poller_thread.join(timeout=max(2.0, self.job_poll_interval_seconds + 1.0))

    def heartbeat_once(self) -> dict[str, bool]:
        capabilities = self.discover_capabilities()
        workspace_roots = [normalize_workspace_root(str(root)) for root in self.workspace_roots]
        reachable_backends = [name for name, available in capabilities.items() if available]
        response = self.client.heartbeat(
            {
                "status": "online" if reachable_backends else "degraded",
                "reachable_backends": reachable_backends,
                "workspace_roots": workspace_roots,
                "capabilities": capabilities,
                "active_job_ids": self._active_job_ids_snapshot(),
            }
        )
        runtime_settings = None
        if isinstance(response, dict):
            if isinstance(response.get("runtime_settings"), dict):
                runtime_settings = response.get("runtime_settings")
            else:
                worker_payload = response.get("worker")
                if isinstance(worker_payload, dict) and isinstance(worker_payload.get("runtime_settings"), dict):
                    runtime_settings = worker_payload.get("runtime_settings")
        self._apply_runtime_settings(runtime_settings)
        return capabilities

    def _set_max_concurrent_jobs(self, desired: int) -> None:
        if not self.background_jobs:
            self.max_concurrent_jobs = desired
            return
        with self._active_jobs_lock:
            self._collect_finished_jobs()
            if self._active_jobs:
                self._pending_max_concurrent_jobs = desired
                return
            self._swap_executor_locked(desired)

    def _swap_executor_locked(self, desired: int) -> None:
        previous = self._executor
        self._executor = ThreadPoolExecutor(
            max_workers=desired,
            thread_name_prefix="agenthub-job",
        )
        self.max_concurrent_jobs = desired
        self._pending_max_concurrent_jobs = None
        if previous is not None:
            previous.shutdown(wait=False)

    def start_heartbeat_poller(self) -> None:
        if self._heartbeat_poller_thread is not None and self._heartbeat_poller_thread.is_alive():
            return
        stop_event = threading.Event()
        self._heartbeat_poller_stop = stop_event

        def heartbeat_loop() -> None:
            while not stop_event.wait(self.heartbeat_interval_seconds):
                try:
                    self.heartbeat_once()
                except Exception as exc:  # noqa: BLE001 - heartbeat polling should not kill the worker
                    print(f"AgentHub worker heartbeat poll failed: {exc}", file=sys.stderr)

        self._heartbeat_poller_thread = threading.Thread(target=heartbeat_loop, name="agenthub-heartbeat-poller", daemon=True)
        self._heartbeat_poller_thread.start()

    def stop_heartbeat_poller(self) -> None:
        if self._heartbeat_poller_stop is not None:
            self._heartbeat_poller_stop.set()
        if self._heartbeat_poller_thread is not None and self._heartbeat_poller_thread is not threading.current_thread():
            self._heartbeat_poller_thread.join(timeout=max(2.0, self.heartbeat_interval_seconds + 1.0))

    def shutdown(self, *, wait: bool = True) -> None:
        self.stop_heartbeat_poller()
        self.stop_job_poller()
        if self._executor is not None:
            self._executor.shutdown(wait=wait)
            if wait:
                self._collect_finished_jobs()
        close_client = getattr(self.client, "close", None)
        if callable(close_client):
            close_client()

    def run_once(self) -> None:
        capabilities = self.heartbeat_once()
        self._drain_jobs()

        if hasattr(self.client, "publish_provider_snapshots"):
            try:
                self.client.publish_provider_snapshots(provider_snapshots_from_capabilities(capabilities))
            except Exception as exc:  # noqa: BLE001 - provider snapshots are auxiliary sync data
                print(f"AgentHub worker provider snapshot publish failed: {exc}", file=sys.stderr)

        discovery_roots = self.workspace_roots if self.session_roots is None else self.session_roots
        sessions = self.discover_sessions(discovery_roots)
        for batch in session_batches(sessions, self.worker_id):
            self.client.publish_sessions(batch)
        if hasattr(self.client, "publish_timeline"):
            batches_by_session: dict[str, list[TimelineBatch]] = {}
            for batch in timeline_batches(sessions, self.worker_id):
                batches_by_session.setdefault(batch.session_id, []).append(batch)
            for session_id, batches in batches_by_session.items():
                digest = timeline_batches_digest(batches)
                if self._published_timeline_digests.get(session_id) == digest:
                    continue
                published_all = True
                for batch in batches:
                    try:
                        self.client.publish_timeline(batch.session_id, batch.items, replace=batch.replace)
                    except Exception as exc:  # noqa: BLE001 - keep core session discovery alive
                        print(f"AgentHub worker timeline publish failed for {batch.session_id}: {exc}", file=sys.stderr)
                        published_all = False
                        break
                if published_all:
                    self._published_timeline_digests[session_id] = digest

        self._drain_jobs()


def run_forever(runtime: WorkerRuntime, interval_seconds: int) -> None:
    start_heartbeat_poller = getattr(runtime, "start_heartbeat_poller", None)
    if callable(start_heartbeat_poller):
        start_heartbeat_poller()
    start_job_poller = getattr(runtime, "start_job_poller", None)
    if callable(start_job_poller):
        start_job_poller()
    try:
        while True:
            try:
                runtime.run_once()
            except Exception as exc:  # noqa: BLE001 - workers should survive transient API/network failures
                print(f"AgentHub worker tick failed: {exc}", file=sys.stderr)
            time.sleep(interval_seconds)
    finally:
        shutdown = getattr(runtime, "shutdown", None)
        if callable(shutdown):
            shutdown(wait=True)


def _truncate_text(value: Any, limit: int, marker: str = "...") -> Any:
    if not isinstance(value, str):
        return value
    if len(value) <= limit:
        return value
    keep = max(0, limit - len(marker))
    return f"{value[:keep]}{marker}"


def _json_payload_bytes(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))


class _JsonArrayPayloadSizer:
    def __init__(self, base_payload: dict[str, Any], array_key: str) -> None:
        payload = dict(base_payload)
        payload[array_key] = []
        self._base_bytes = _json_payload_bytes(payload)
        self._content_bytes = 0
        self._count = 0

    @property
    def count(self) -> int:
        return self._count

    def candidate_bytes(self, item: dict[str, Any]) -> tuple[int, int]:
        item_bytes = _json_payload_bytes(item)
        separator_bytes = 1 if self._count else 0
        return self._base_bytes + self._content_bytes + separator_bytes + item_bytes, item_bytes

    def append(self, item_bytes: int) -> None:
        if self._count:
            self._content_bytes += 1
        self._content_bytes += item_bytes
        self._count += 1


def _trim_timeline_items(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    trimmed: list[dict[str, Any]] = []
    for item in value[-MAX_RUNTIME_TIMELINE_ITEMS:]:
        if not isinstance(item, dict):
            continue
        next_item = dict(item)
        item_type = str(next_item.get("item_type") or "")
        limit = MAX_CONVERSATION_MESSAGE_CHARS if item_type in CONVERSATION_TIMELINE_TYPES else MAX_TOOL_MESSAGE_CHARS
        next_item["text"] = _truncate_text(next_item.get("text"), limit, TRUNCATION_MARKER)
        trimmed.append(next_item)
    return trimmed


def _runtime_message_limit(message: dict[str, Any]) -> int:
    kind = str(message.get("kind") or message.get("item_type") or "")
    role = str(message.get("role") or "")
    if kind in CONVERSATION_TIMELINE_TYPES or role in CONVERSATION_MESSAGE_ROLES:
        return MAX_CONVERSATION_MESSAGE_CHARS
    return MAX_TOOL_MESSAGE_CHARS


def _trim_runtime_metadata(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    metadata = dict(value)
    messages = metadata.get("messages")
    if isinstance(messages, list):
        trimmed_messages = []
        for message in messages[-MAX_RUNTIME_MESSAGES:]:
            if isinstance(message, dict):
                next_message = dict(message)
                next_message["text"] = _truncate_text(
                    next_message.get("text"),
                    _runtime_message_limit(next_message),
                    TRUNCATION_MARKER,
                )
                trimmed_messages.append(next_message)
            else:
                trimmed_messages.append(message)
        metadata["messages"] = trimmed_messages
    timeline = metadata.get("timeline")
    if isinstance(timeline, list):
        metadata["timeline"] = _trim_timeline_items(timeline)
    return metadata


def trim_session_for_publish(session: dict[str, Any], worker_id: str) -> dict[str, Any]:
    trimmed = {**session, "worker_id": worker_id}
    trimmed.pop("timeline", None)
    trimmed["activity_summary"] = _truncate_text(trimmed.get("activity_summary"), MAX_ACTIVITY_CHARS)
    trimmed["last_message"] = _truncate_text(trimmed.get("last_message"), MAX_MESSAGE_CHARS)
    runtime_metadata = _trim_runtime_metadata(trimmed.get("runtime_metadata"))
    if isinstance(runtime_metadata, dict):
        runtime_metadata.pop("timeline", None)
    trimmed["runtime_metadata"] = runtime_metadata
    return trimmed


def session_batches(sessions: list[dict[str, Any]], worker_id: str) -> list[list[dict[str, Any]]]:
    trimmed_sessions = [trim_session_for_publish(session, worker_id) for session in sessions]
    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    current_sizer = _JsonArrayPayloadSizer({"worker_id": worker_id}, "sessions")
    for session in trimmed_sessions:
        candidate_bytes, session_bytes = current_sizer.candidate_bytes(session)
        too_many_sessions = current_sizer.count + 1 > SESSION_DISCOVERY_BATCH_SIZE
        too_large = candidate_bytes > MAX_DISCOVERY_PAYLOAD_BYTES
        if current and (too_many_sessions or too_large):
            batches.append(current)
            current = [session]
            current_sizer = _JsonArrayPayloadSizer({"worker_id": worker_id}, "sessions")
            _, session_bytes = current_sizer.candidate_bytes(session)
            current_sizer.append(session_bytes)
        else:
            current.append(session)
            current_sizer.append(session_bytes)
    if current:
        batches.append(current)
    return batches


@dataclass(frozen=True)
class TimelineBatch:
    session_id: str
    items: list[dict[str, Any]]
    replace: bool


def timeline_batches_digest(batches: list[TimelineBatch]) -> str:
    payload = [
        {
            "session_id": batch.session_id,
            "replace": batch.replace,
            "items": batch.items,
        }
        for batch in batches
    ]
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _timeline_items_for_publish(session: dict[str, Any]) -> list[dict[str, Any]]:
    timeline = session.get("timeline")
    if not isinstance(timeline, list):
        runtime_metadata = session.get("runtime_metadata")
        if isinstance(runtime_metadata, dict):
            timeline = runtime_metadata.get("timeline")
    return _trim_timeline_items(timeline)


def timeline_batches(sessions: list[dict[str, Any]], worker_id: str) -> list[TimelineBatch]:
    batches: list[TimelineBatch] = []
    for session in sessions:
        session_id = str(session.get("session_id") or "")
        if not session_id:
            continue
        current: list[dict[str, Any]] = []
        replace = True
        current_sizer = _JsonArrayPayloadSizer({"worker_id": worker_id, "replace": replace}, "items")
        for item in _timeline_items_for_publish(session):
            candidate_bytes, item_bytes = current_sizer.candidate_bytes(item)
            too_large = candidate_bytes > MAX_TIMELINE_PAYLOAD_BYTES
            if current and too_large:
                batches.append(TimelineBatch(session_id=session_id, items=current, replace=replace))
                current = [item]
                replace = False
                current_sizer = _JsonArrayPayloadSizer({"worker_id": worker_id, "replace": replace}, "items")
                _, item_bytes = current_sizer.candidate_bytes(item)
                current_sizer.append(item_bytes)
            else:
                current.append(item)
                current_sizer.append(item_bytes)
        if current:
            batches.append(TimelineBatch(session_id=session_id, items=current, replace=replace))
    return batches
