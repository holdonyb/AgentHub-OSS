from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
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
    _diagnostic_cache: dict[str, Any] | None = field(default=None, init=False, repr=False)
    _diagnostic_cache_at: float = field(default=0.0, init=False, repr=False)
    _diagnostic_cache_ttl_seconds: float = field(default=30.0, init=False, repr=False)

    def is_available(self) -> bool:
        return shutil.which(self.executable) is not None

    def get_diagnostic(self) -> dict[str, Any]:
        now = time.monotonic()
        if self._diagnostic_cache and (now - self._diagnostic_cache_at) < self._diagnostic_cache_ttl_seconds:
            return dict(self._diagnostic_cache)
        path = shutil.which(self.executable)
        if path is None:
            return {"available": False, "error": f"{self.executable} not found"}
        version = ""
        try:
            completed = subprocess.run(
                [self.executable, "--version"],
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=5,
                check=False,
                executable=path,
            )
            version = (completed.stdout or completed.stderr or "").strip()[:240]
        except Exception as exc:  # noqa: BLE001 - diagnostics must not break worker heartbeats
            version = f"version probe failed: {exc}"
        auth_status = self.auth_status()
        feature_overrides = self._probe_feature_overrides()
        diagnostics = {
            "available": True,
            "path": path,
            "version": version,
            "auth_status": auth_status,
            "feature_overrides": feature_overrides,
        }
        self._diagnostic_cache = dict(diagnostics)
        self._diagnostic_cache_at = now
        return diagnostics

    def auth_status(self) -> str:
        home_value = os.getenv("USERPROFILE") or os.getenv("HOME") or str(Path.home())
        home = Path(home_value)
        probed_status = self._probe_auth_status()
        if probed_status:
            return probed_status
        if self.backend == "opencode":
            return "ready" if (home / ".local" / "share" / "opencode" / "auth.json").exists() else "auth_required"
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

    def _probe_auth_status(self) -> str | None:
        if not self.is_available():
            return None
        if self.backend == "claude":
            return self._probe_claude_auth_status()
        if self.backend == "codex":
            return self._probe_codex_auth_status()
        if self.backend == "opencode":
            return self._probe_opencode_auth_status()
        return None

    def _run_auth_probe(self, args: list[str]) -> subprocess.CompletedProcess[str] | None:
        executable_path = shutil.which(args[0]) if args else None
        try:
            return subprocess.run(
                args,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=5,
                check=False,
                executable=executable_path or None,
            )
        except Exception:
            return None

    def _probe_claude_auth_status(self) -> str | None:
        completed = self._run_auth_probe(["claude", "auth", "status"])
        if completed is None:
            return None
        text = f"{completed.stdout}\n{completed.stderr}".lower()
        if '"loggedin": true' in text or '"loggedin":true' in text:
            return "ready"
        if '"loggedin": false' in text or '"loggedin":false' in text or "not logged in" in text:
            return "auth_required"
        return None

    def _probe_codex_auth_status(self) -> str | None:
        completed = self._run_auth_probe(["codex", "login", "status"])
        if completed is None:
            return None
        text = f"{completed.stdout}\n{completed.stderr}".lower()
        if "logged in" in text:
            return "ready"
        if "not logged in" in text or "logged out" in text:
            return "auth_required"
        return None

    def _probe_opencode_auth_status(self) -> str | None:
        completed = self._run_auth_probe(["opencode", "providers", "list"])
        if completed is not None:
            text = f"{completed.stdout}\n{completed.stderr}".lower()
            match = re.search(r"(\d+)\s+credentials?", text)
            if match and int(match.group(1)) > 0:
                return "ready"
            if self._opencode_config_is_ready():
                return "ready"
            if match:
                return "auth_required"
            if "credentials" in text and "0 credentials" in text:
                return "auth_required"
        elif self._opencode_config_is_ready():
            return "ready"
        return None

    def _opencode_config_is_ready(self) -> bool:
        completed = self._run_auth_probe(["opencode", "debug", "config"])
        if completed is None:
            return False
        try:
            config = json.loads(completed.stdout or "{}")
        except json.JSONDecodeError:
            return False
        if not isinstance(config, dict):
            return False
        provider_config = config.get("provider")
        if isinstance(provider_config, dict):
            for value in provider_config.values():
                if not isinstance(value, dict):
                    continue
                options = value.get("options")
                if isinstance(options, dict) and str(options.get("apiKey") or "").strip():
                    return True
                if str(value.get("apiKey") or "").strip():
                    return True
        enabled = {
            str(item).strip().lower()
            for item in (config.get("enabled_providers") or [])
            if str(item).strip()
        }
        disabled = {
            str(item).strip().lower()
            for item in (config.get("disabled_providers") or [])
            if str(item).strip()
        }
        provider_env = {
            "anthropic": "ANTHROPIC_API_KEY",
            "openai": "OPENAI_API_KEY",
            "xai": "XAI_API_KEY",
            "groq": "GROQ_API_KEY",
            "deepseek": "DEEPSEEK_API_KEY",
            "together": "TOGETHER_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
            "moonshotai": "MOONSHOT_API_KEY",
            "zai": "ZAI_API_KEY",
        }
        for provider_name, env_name in provider_env.items():
            if enabled and provider_name not in enabled:
                continue
            if provider_name in disabled:
                continue
            if str(os.getenv(env_name) or "").strip():
                return True
        return False

    def snapshot(self, available: bool | None = None) -> dict[str, Any]:
        is_available = self.is_available() if available is None else available
        diagnostics = self.get_diagnostic() if is_available else {"available": False}
        auth_status = str(diagnostics.get("auth_status") or "unknown")
        features = dict(self.features)
        feature_overrides = diagnostics.get("feature_overrides")
        if isinstance(feature_overrides, dict):
            features.update(feature_overrides)
        return {
            "backend": self.backend,
            "status": "ready" if is_available else "unavailable",
            "auth_status": auth_status,
            "models": self.default_models,
            "modes": self.modes,
            "features": features,
            "diagnostics": diagnostics,
        }

    def _probe_feature_overrides(self) -> dict[str, Any]:
        if not self.is_available():
            return {}
        if self.backend == "codex":
            return self._probe_codex_feature_overrides()
        if self.backend == "claude":
            return self._probe_claude_feature_overrides()
        if self.backend == "opencode":
            return self._probe_opencode_feature_overrides()
        if self.backend == "kimi":
            return self._probe_kimi_feature_overrides()
        return {}

    @staticmethod
    def _bool_env_override(name: str) -> bool | None:
        raw = str(os.getenv(name) or "").strip().lower()
        if not raw:
            return None
        if raw in {"1", "true", "yes", "on", "enabled"}:
            return True
        if raw in {"0", "false", "no", "off", "disabled"}:
            return False
        return None

    def _probe_codex_feature_overrides(self) -> dict[str, Any]:
        env_override = self._bool_env_override("AGENTHUB_CODEX_NATIVE_GOAL_COMMAND")
        if env_override is not None:
            return {"native_goal_command": env_override}
        completed = self._run_auth_probe(["codex", "features", "list"])
        if completed is None:
            return {}
        text = f"{completed.stdout}\n{completed.stderr}".lower()
        match = re.search(r"^\s*goals\s+\S+\s+(true|false)\b", text, re.MULTILINE)
        if not match:
            return {}
        return {"native_goal_command": match.group(1) == "true"}

    def _probe_claude_feature_overrides(self) -> dict[str, Any]:
        overrides: dict[str, Any] = {
            "native_goal_command": False,
            "native_plan_command": False,
        }
        agents = self._run_auth_probe(["claude", "agents"])
        if agents is not None:
            text = f"{agents.stdout}\n{agents.stderr}"
            overrides["plan_agent"] = bool(re.search(r"^\s*Plan\b", text, re.MULTILINE))
        return overrides

    def _probe_opencode_feature_overrides(self) -> dict[str, Any]:
        overrides: dict[str, Any] = {
            "native_goal_command": False,
            "native_plan_command": False,
        }
        agents = self._run_auth_probe(["opencode", "agent", "list"])
        if agents is not None:
            text = f"{agents.stdout}\n{agents.stderr}".lower()
            overrides["plan_agent"] = re.search(r"^\s*plan\b", text, re.MULTILINE) is not None
            overrides["plan_exit"] = "plan_exit" in text
        return overrides

    def _probe_kimi_feature_overrides(self) -> dict[str, Any]:
        return {
            "native_goal_command": False,
            "native_plan_command": False,
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
            "native_goal_command": True,
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
    "opencode": AgentProvider(
        backend="opencode",
        executable="opencode",
        default_models=_models_from_env(
            "AGENTHUB_OPENCODE_MODELS",
            ["openai/gpt-5", "anthropic/claude-sonnet-4", "moonshotai/kimi-k2"],
        ),
        modes=[
            {"id": "plan", "label": "Plan", "kind": "reply_mode"},
            {"id": "direct", "label": "Direct", "kind": "reply_mode"},
            {"id": "plan", "label": "plan", "kind": "agent"},
            {"id": "build", "label": "build", "kind": "agent"},
        ],
        features={
            "agent": True,
            "attach": True,
            "share": True,
            "stream_json": True,
            "yolo": True,
            "interaction_bridge": "compatibility",
            "plan_result_choices": True,
            "plan_exit": True,
            "goal": True,
            "native_runtime_prompts": False,
            "attachments": True,
        },
    ),
}


def provider_snapshots_from_capabilities(capabilities: dict[str, bool]) -> list[dict[str, Any]]:
    snapshots = []
    for backend, provider in PROVIDERS.items():
        snapshots.append(provider.snapshot(bool(capabilities.get(backend))))
    return snapshots
