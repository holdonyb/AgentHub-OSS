from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class AgentProvider:
    backend: str
    executable: str
    default_models: list[dict[str, str]] = field(default_factory=list)
    modes: list[dict[str, str]] = field(default_factory=list)
    features: dict[str, Any] = field(default_factory=dict)

    def is_available(self) -> bool:
        return shutil.which(self.executable) is not None

    def get_diagnostic(self) -> dict[str, Any]:
        path = shutil.which(self.executable)
        if path is None:
            return {"available": False, "error": f"{self.executable} not found"}
        version = ""
        try:
            completed = subprocess.run(
                [self.executable, "--version"],
                text=True,
                capture_output=True,
                timeout=5,
                check=False,
            )
            version = (completed.stdout or completed.stderr or "").strip()[:240]
        except Exception as exc:  # noqa: BLE001 - diagnostics must not break worker heartbeats
            version = f"version probe failed: {exc}"
        return {"available": True, "path": path, "version": version, "auth_status": self.auth_status()}

    def auth_status(self) -> str:
        home_value = os.getenv("USERPROFILE") or os.getenv("HOME") or str(Path.home())
        home = Path(home_value)
        if self.backend == "kimi":
            credential_dir = home / ".kimi" / "credentials"
            try:
                has_credentials = any(path.is_file() and path.stat().st_size >= 0 for path in credential_dir.glob("*.json"))
            except OSError:
                has_credentials = False
            return "ready" if has_credentials else "auth_required"
        if self.backend == "codex":
            return "ready" if (home / ".codex" / "auth.json").exists() else "auth_required"
        return "unknown"

    def snapshot(self, available: bool | None = None) -> dict[str, Any]:
        is_available = self.is_available() if available is None else available
        diagnostics = self.get_diagnostic() if is_available else {"available": False}
        auth_status = str(diagnostics.get("auth_status") or "unknown")
        return {
            "backend": self.backend,
            "status": "ready" if is_available else "unavailable",
            "auth_status": auth_status,
            "models": self.default_models,
            "modes": self.modes,
            "features": self.features,
            "diagnostics": diagnostics,
        }


def _models_from_env(name: str, fallback: list[str]) -> list[dict[str, str]]:
    value = os.getenv(name, "")
    model_ids = [item.strip() for item in value.split(",") if item.strip()] or fallback
    return [{"id": model_id, "label": model_id} for model_id in model_ids]


PROVIDERS = {
    "codex": AgentProvider(
        backend="codex",
        executable="codex",
        default_models=_models_from_env("AGENTHUB_CODEX_MODELS", ["gpt-5.4", "gpt-5.4-mini", "gpt-5.2"]),
        modes=[
            {"id": "plan", "label": "Plan", "kind": "reply_mode"},
            {"id": "direct", "label": "Direct", "kind": "reply_mode"},
            {"id": "read-only", "label": "read-only", "kind": "sandbox_mode"},
            {"id": "workspace-write", "label": "workspace-write", "kind": "sandbox_mode"},
            {"id": "danger-full-access", "label": "danger-full-access", "kind": "sandbox_mode"},
            {"id": "never", "label": "never", "kind": "approval_mode"},
            {"id": "on-request", "label": "on-request", "kind": "approval_mode"},
            {"id": "on-failure", "label": "on-failure", "kind": "approval_mode"},
            {"id": "untrusted", "label": "untrusted", "kind": "approval_mode"},
        ],
        features={
            "yolo": True,
            "app_server_target": True,
            "native_plan_mode": True,
            "interaction_bridge": "native",
            "request_user_input": True,
            "approvals": True,
            "plan_exit": True,
            "goal": True,
        },
    ),
    "claude": AgentProvider(
        backend="claude",
        executable="claude",
        default_models=_models_from_env("AGENTHUB_CLAUDE_MODELS", ["sonnet", "opus"]),
        modes=[
            {"id": "default", "label": "default", "kind": "permission_mode"},
            {"id": "auto", "label": "auto", "kind": "permission_mode"},
            {"id": "plan", "label": "plan", "kind": "permission_mode"},
            {"id": "dontAsk", "label": "dontAsk", "kind": "permission_mode"},
            {"id": "bypassPermissions", "label": "bypassPermissions", "kind": "permission_mode"},
        ],
        features={
            "permission_mode": True,
            "stream_json": True,
            "interaction_bridge": "compatibility",
            "plan_result_choices": True,
            "goal": True,
            "native_runtime_prompts": False,
        },
    ),
    "kimi": AgentProvider(
        backend="kimi",
        executable="kimi",
        default_models=_models_from_env("AGENTHUB_KIMI_MODELS", ["kimi-k2.5"]),
        modes=[
            {"id": "thinking", "label": "thinking", "kind": "thinking"},
            {"id": "no-thinking", "label": "no-thinking", "kind": "thinking"},
        ],
        features={
            "yolo": True,
            "thinking": True,
            "agent": True,
            "wire": True,
            "acp": True,
            "interaction_bridge": "compatibility",
            "plan_result_choices": True,
            "native_runtime_prompts": False,
            "structured_protocols": ["acp", "wire"],
        },
    ),
}


def provider_snapshots_from_capabilities(capabilities: dict[str, bool]) -> list[dict[str, Any]]:
    snapshots = []
    for backend, provider in PROVIDERS.items():
        snapshots.append(provider.snapshot(bool(capabilities.get(backend))))
    return snapshots
