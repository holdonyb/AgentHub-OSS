from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]


def load_audit_module():
    script = REPO_ROOT / "scripts" / "audit-public-export.py"
    spec = importlib.util.spec_from_file_location("agenthub_public_export_audit", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_excluded_runtime_paths_are_rejected_before_stat(monkeypatch, tmp_path: Path) -> None:
    audit = load_audit_module()
    inaccessible = tmp_path / ".runtime" / "broken-link"

    monkeypatch.setattr(Path, "rglob", lambda _self, _pattern: iter([inaccessible]))

    def fail_if_stat_called(_self: Path) -> bool:
        raise AssertionError("excluded paths must not be stat'ed")

    monkeypatch.setattr(Path, "is_file", fail_if_stat_called)

    assert list(audit.iter_candidate_files(tmp_path, set())) == []
