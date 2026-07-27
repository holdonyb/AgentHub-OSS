from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
MAIN_PATH = REPO_ROOT / "workers" / "local-macos" / "agenthub_macos_worker" / "main.py"
INSTALL_SCRIPT_PATH = REPO_ROOT / "scripts" / "install-macos-worker.sh"


def _load_main_module():
    assert MAIN_PATH.is_file(), "macOS worker entrypoint is missing"
    spec = importlib.util.spec_from_file_location("agenthub_macos_worker_main", MAIN_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_macos_installer_accepts_an_empty_session_root_list_under_nounset() -> None:
    source = INSTALL_SCRIPT_PATH.read_text(encoding="utf-8")

    assert 'if [[ -n "${session_roots[0]+set}" ]]; then' in source
    assert 'if [[ -n "${normalized_session_roots[0]+set}" ]]; then' in source
    assert 'if [[ -n "${session_roots[0]+set}" ]]; then\n  session_root_value=' in source


def test_macos_worker_requires_explicit_workspace_roots(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_main_module()
    monkeypatch.delenv("AGENTHUB_WORKSPACE_ROOTS", raising=False)

    with pytest.raises(SystemExit, match="workspace root"):
        module._workspace_roots(None)


def test_macos_worker_maintenance_can_rebuild_discovery_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    module = _load_main_module()
    roots = [tmp_path / "sessions"]
    roots[0].mkdir()
    monkeypatch.setattr(module, "_session_roots", lambda: roots)
    monkeypatch.setattr(
        module,
        "rebuild_recent_session_index",
        lambda values: {"roots": len(values), "files": 3, "backends": {"claude": 3}},
    )

    result = module._run_maintenance(SimpleNamespace(maintenance_command="rebuild-discovery-index"))

    assert result == 0
    assert '"files": 3' in capsys.readouterr().out


def test_macos_worker_accepts_cli_and_environment_workspace_roots(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_main_module()
    work = tmp_path / "Work"
    projects = tmp_path / "Projects"
    volume = tmp_path / "Code"
    for root in (work, projects, volume):
        root.mkdir()
    monkeypatch.setenv("AGENTHUB_WORKSPACE_ROOTS", os.pathsep.join((str(work), str(projects))))

    assert [str(path).replace("\\", "/") for path in module._workspace_roots(None)] == [
        str(work.resolve()).replace("\\", "/"),
        str(projects.resolve()).replace("\\", "/"),
    ]
    assert [str(path).replace("\\", "/") for path in module._workspace_roots([str(volume)])] == [
        str(volume.resolve()).replace("\\", "/")
    ]


def test_macos_worker_rejects_relative_or_missing_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_main_module()
    monkeypatch.chdir(tmp_path)

    with pytest.raises(SystemExit, match="absolute"):
        module._workspace_roots(["relative-work"])
    with pytest.raises(SystemExit, match="does not exist"):
        module._workspace_roots([str(tmp_path / "missing")])


def test_macos_worker_only_advertises_agent_backends() -> None:
    module = _load_main_module()

    assert module._reachable_backends(
        {"codex": True, "claude": False, "kimi": True, "opencode": True, "tmux": True}
    ) == ["codex", "kimi", "opencode"]


def test_macos_worker_advertises_streamed_file_transfer_capability() -> None:
    module = _load_main_module()

    assert module.discover_capabilities()["file_transfer_v2"] is True


def test_macos_heartbeat_keeps_tmux_as_capability_only() -> None:
    module = _load_main_module()
    payloads: list[dict] = []

    class Client:
        def heartbeat(self, payload: dict) -> dict:
            payloads.append(payload)
            return {"worker": {}}

    client = module._MacOSClientProxy(Client())
    client.heartbeat(
        {
            "reachable_backends": ["codex", "tmux"],
            "capabilities": {"codex": True, "tmux": True},
        }
    )

    assert payloads[0]["reachable_backends"] == ["codex"]
    assert payloads[0]["capabilities"]["tmux"] is True


def test_macos_worker_persists_token_atomically_and_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_main_module()
    token_path = tmp_path / "worker-token"

    module._persist_worker_token(token_path, "ahw_secret")
    assert token_path.read_text(encoding="utf-8") == "ahw_secret\n"
    if os.name != "nt":
        assert token_path.stat().st_mode & 0o777 == 0o600

    failed_path = tmp_path / "failed-token"
    monkeypatch.setattr(module.os, "chmod", lambda *_args: (_ for _ in ()).throw(OSError("chmod failed")))
    with pytest.raises(OSError, match="chmod failed"):
        module._persist_worker_token(failed_path, "ahw_never_written")
    assert not failed_path.exists()


def test_macos_bootstrap_only_enrolls_without_starting_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_main_module()
    workspace = tmp_path / "Work"
    workspace.mkdir()
    token_path = tmp_path / "runtime" / "mac.worker-token"
    enroll_payloads: list[dict] = []

    class FakeClient:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def enroll(self, payload: dict) -> dict:
            enroll_payloads.append(payload)
            return {"worker": {"worker_id": payload["worker_id"]}}

    monkeypatch.setattr(module, "AgentHubClient", FakeClient)
    monkeypatch.setattr(module, "WorkerRuntime", lambda **_kwargs: (_ for _ in ()).throw(AssertionError("runtime started")))
    monkeypatch.setattr(
        module,
        "discover_capabilities",
        lambda: {"codex": True, "claude": False, "kimi": False, "opencode": False, "tmux": True},
    )
    monkeypatch.setattr(
        module.sys,
        "argv",
        [
            "worker",
            "--api-url",
            "https://agenthub.example.com",
            "--worker-id",
            "macbook",
            "--connection-mode",
            "public_relay",
            "--enrollment-token",
            "ahe_once",
            "--worker-token-path",
            str(token_path),
            "--workspace-root",
            str(workspace),
            "--bootstrap-only",
        ],
    )

    module.main()

    assert token_path.is_file()
    assert enroll_payloads[0]["reachable_backends"] == ["codex"]


def test_macos_explicit_enrollment_consumes_token_when_cached_worker_token_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_main_module()
    workspace = tmp_path / "Work"
    workspace.mkdir()
    token_path = tmp_path / "runtime" / "mac.worker-token"
    module._persist_worker_token(token_path, "ahw_cached")
    enroll_payloads: list[dict] = []

    class FakeClient:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def enroll(self, payload: dict) -> dict:
            enroll_payloads.append(payload)
            return {"worker": {"worker_id": payload["worker_id"]}}

    monkeypatch.setattr(module, "AgentHubClient", FakeClient)
    monkeypatch.setattr(module, "WorkerRuntime", lambda **_kwargs: (_ for _ in ()).throw(AssertionError("runtime started")))
    monkeypatch.setattr(
        module,
        "discover_capabilities",
        lambda: {"codex": True, "claude": False, "kimi": False, "opencode": False, "tmux": True},
    )
    monkeypatch.setattr(
        module.sys,
        "argv",
        [
            "worker",
            "--api-url",
            "https://agenthub.example.com",
            "--worker-id",
            "macbook",
            "--connection-mode",
            "public_relay",
            "--enrollment-token",
            "ahe_once",
            "--worker-token-path",
            str(token_path),
            "--workspace-root",
            str(workspace),
            "--bootstrap-only",
        ],
    )

    module.main()

    assert enroll_payloads == [
        {
            "worker_id": "macbook",
            "machine_name": module.socket.gethostname(),
            "os": "macos",
            "connection_mode": "public_relay",
            "transport_state": "polling",
            "reachable_backends": ["codex"],
            "workspace_roots": [str(workspace).replace("\\", "/")],
            "capabilities": {
                "codex": True,
                "claude": False,
                "kimi": False,
                "opencode": False,
                "tmux": True,
            },
            "worker_token": "ahw_cached",
            "enrollment_token": "ahe_once",
        }
    ]
    assert token_path.read_text(encoding="utf-8") == "ahw_cached\n"
