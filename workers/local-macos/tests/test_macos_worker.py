from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
MAIN_PATH = REPO_ROOT / "workers" / "local-macos" / "agenthub_macos_worker" / "main.py"


def _load_main_module():
    assert MAIN_PATH.is_file(), "macOS worker entrypoint is missing"
    spec = importlib.util.spec_from_file_location("agenthub_macos_worker_main", MAIN_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_macos_worker_requires_explicit_workspace_roots(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_main_module()
    monkeypatch.delenv("AGENTHUB_WORKSPACE_ROOTS", raising=False)

    with pytest.raises(SystemExit, match="workspace root"):
        module._workspace_roots(None)


def test_macos_worker_accepts_cli_and_environment_workspace_roots(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_main_module()
    monkeypatch.setenv("AGENTHUB_WORKSPACE_ROOTS", "/Users/alice/Work:/Users/alice/Projects")

    assert [str(path).replace("\\", "/") for path in module._workspace_roots(None)] == [
        "/Users/alice/Work",
        "/Users/alice/Projects",
    ]
    assert [str(path).replace("\\", "/") for path in module._workspace_roots(["/Volumes/Code"])] == [
        "/Volumes/Code"
    ]
