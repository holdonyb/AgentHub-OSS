from __future__ import annotations

import sys
from pathlib import Path

import pytest

import agenthub_linux_worker.main as linux_main
import agenthub_windows_worker.main as windows_main


@pytest.fixture(autouse=True)
def _clear_worker_token_path_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENTHUB_WORKER_TOKEN_PATH", raising=False)


class _FakeClient:
    instances: list["_FakeClient"] = []
    enroll_payloads: list[dict[str, object]] = []

    def __init__(self, base_url: str, worker_id: str, worker_token: str, *, mode: str = "private") -> None:
        self.base_url = base_url
        self.worker_id = worker_id
        self.worker_token = worker_token
        self.mode = mode
        _FakeClient.instances.append(self)

    def enroll(self, payload: dict[str, object]) -> dict[str, object]:
        _FakeClient.enroll_payloads.append(payload)
        return {"worker": {"worker_id": payload["worker_id"]}}

    def register(self, payload: dict[str, object], registration_token: str) -> dict[str, object]:
        raise AssertionError(f"register() should not be called, payload={payload}, token={registration_token}")


class _FakeRuntime:
    instances: list["_FakeRuntime"] = []

    def __init__(self, **kwargs) -> None:
        self.client = kwargs["client"]
        self.worker_id = kwargs["worker_id"]
        self.workspace_roots = kwargs["workspace_roots"]
        self.session_roots = kwargs["session_roots"]
        _FakeRuntime.instances.append(self)

    def run_once(self) -> None:
        return None

    def shutdown(self, wait: bool = True) -> None:
        return None


def _reset_fakes() -> None:
    _FakeClient.instances.clear()
    _FakeClient.enroll_payloads.clear()
    _FakeRuntime.instances.clear()


def test_windows_worker_private_mode_bootstraps_with_enrollment_and_persists_token(
    tmp_path: Path, monkeypatch
) -> None:
    _reset_fakes()
    monkeypatch.setattr(windows_main, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(windows_main, "AgentHubClient", _FakeClient)
    monkeypatch.setattr(windows_main, "WorkerRuntime", _FakeRuntime)
    monkeypatch.setattr(windows_main, "discover_capabilities", lambda: {"codex": True, "claude": False, "kimi": True})
    monkeypatch.setattr(windows_main, "discover_sessions", lambda roots: [])
    monkeypatch.setenv("AGENTHUB_WORKSPACE_ROOTS", str(tmp_path / "work"))
    monkeypatch.setenv("AGENTHUB_WORKER_TOKEN", "ahw_host_env_token_should_not_override_bootstrap")
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "worker",
            "--api-url",
            "https://agenthub.example.com",
            "--worker-id",
            "win-office-01",
            "--connection-mode",
            "private",
            "--enrollment-token",
            "ahe_test_token",
            "--once",
        ],
    )

    windows_main.main()

    token_path = tmp_path / ".runtime" / "win-office-01.worker-token"
    assert token_path.is_file()
    persisted_token = token_path.read_text(encoding="utf-8").strip()
    assert persisted_token.startswith("ahw_")
    assert _FakeClient.enroll_payloads[0]["connection_mode"] == "private"
    assert _FakeClient.enroll_payloads[0]["worker_token"] == persisted_token
    assert _FakeRuntime.instances[0].client.worker_token == persisted_token


def test_windows_worker_uses_cached_token_before_attempting_enrollment(tmp_path: Path, monkeypatch) -> None:
    _reset_fakes()
    token_path = tmp_path / ".runtime" / "win-office-01.worker-token"
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text("ahw_cached_token\n", encoding="utf-8")

    monkeypatch.setattr(windows_main, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(windows_main, "AgentHubClient", _FakeClient)
    monkeypatch.setattr(windows_main, "WorkerRuntime", _FakeRuntime)
    monkeypatch.setattr(windows_main, "discover_capabilities", lambda: {"codex": True})
    monkeypatch.setattr(windows_main, "discover_sessions", lambda roots: [])
    monkeypatch.setenv("AGENTHUB_WORKER_TOKEN", "ahw_host_env_token_should_not_override_cache")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "worker",
            "--api-url",
            "https://agenthub.example.com",
            "--worker-id",
            "win-office-01",
            "--connection-mode",
            "private",
            "--once",
        ],
    )

    windows_main.main()

    assert _FakeClient.enroll_payloads == []
    assert _FakeRuntime.instances[0].client.worker_token == "ahw_cached_token"


def test_linux_worker_private_mode_bootstraps_with_enrollment_and_persists_token(tmp_path: Path, monkeypatch) -> None:
    _reset_fakes()
    monkeypatch.setattr(linux_main, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(linux_main, "AgentHubClient", _FakeClient)
    monkeypatch.setattr(linux_main, "WorkerRuntime", _FakeRuntime)
    monkeypatch.setattr(linux_main, "discover_capabilities", lambda: {"codex": True, "claude": False, "kimi": True})
    monkeypatch.setattr(linux_main, "discover_sessions", lambda roots: [])
    monkeypatch.setenv("AGENTHUB_WORKSPACE_ROOTS", str(tmp_path / "work"))
    monkeypatch.setenv("AGENTHUB_WORKER_TOKEN", "ahw_host_env_token_should_not_override_bootstrap")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "worker",
            "--api-url",
            "https://agenthub.example.com",
            "--worker-id",
            "linux-office-01",
            "--connection-mode",
            "private",
            "--enrollment-token",
            "ahe_test_token",
            "--once",
        ],
    )

    linux_main.main()

    token_path = tmp_path / ".runtime" / "linux-office-01.worker-token"
    assert token_path.is_file()
    persisted_token = token_path.read_text(encoding="utf-8").strip()
    assert persisted_token.startswith("ahw_")
    assert _FakeClient.enroll_payloads[0]["connection_mode"] == "private"
    assert _FakeClient.enroll_payloads[0]["worker_token"] == persisted_token
    assert _FakeRuntime.instances[0].client.worker_token == persisted_token


def test_linux_worker_uses_cached_token_before_attempting_enrollment(tmp_path: Path, monkeypatch) -> None:
    _reset_fakes()
    token_path = tmp_path / ".runtime" / "linux-office-01.worker-token"
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text("ahw_cached_linux_token\n", encoding="utf-8")

    monkeypatch.setattr(linux_main, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(linux_main, "AgentHubClient", _FakeClient)
    monkeypatch.setattr(linux_main, "WorkerRuntime", _FakeRuntime)
    monkeypatch.setattr(linux_main, "discover_capabilities", lambda: {"codex": True})
    monkeypatch.setattr(linux_main, "discover_sessions", lambda roots: [])
    monkeypatch.setenv("AGENTHUB_WORKER_TOKEN", "ahw_host_env_token_should_not_override_cache")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "worker",
            "--api-url",
            "https://agenthub.example.com",
            "--worker-id",
            "linux-office-01",
            "--connection-mode",
            "private",
            "--once",
        ],
    )

    linux_main.main()

    assert _FakeClient.enroll_payloads == []
    assert _FakeRuntime.instances[0].client.worker_token == "ahw_cached_linux_token"
