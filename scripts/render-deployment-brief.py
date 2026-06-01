from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


VALID_MODES = {"public_relay", "tailscale_private", "local_laptop"}
VALID_VOICE_PROVIDERS = {"none", "doubao", "openai"}


def usage() -> str:
    return (
        "Usage: render-deployment-brief.py --brief PATH [--json]\n"
        "Supported modes: public_relay, tailscale_private, local_laptop\n"
        "Voice provider options: none, doubao, openai, plus any OpenAI-compatible base URL."
    )


def load_brief(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def get_nested(data: dict[str, Any], dotted_key: str) -> Any:
    current: Any = data
    for part in dotted_key.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def validate_brief(brief: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    mode = str(brief.get("mode") or "").strip()
    if mode not in VALID_MODES:
        missing.append("mode")

    voice_provider = str(get_nested(brief, "voice.provider") or "none").strip()
    if voice_provider not in VALID_VOICE_PROVIDERS:
        missing.append("voice.provider")

    if mode in {"public_relay", "tailscale_private"}:
        for field in ("server.domain", "server.install_root"):
            if not str(get_nested(brief, field) or "").strip():
                missing.append(field)
    if mode == "public_relay" and not str(get_nested(brief, "server.admin_email") or "").strip():
        missing.append("server.admin_email")
    return missing


def install_command(brief: dict[str, Any]) -> str:
    mode = str(brief["mode"]).strip()
    repo_url = str(brief.get("repo_url") or "https://github.com/YOUR_ORG/AgentHub.git").strip()
    branch = str(brief.get("branch") or "main").strip()
    domain = str(get_nested(brief, "server.domain") or "").strip()
    install_root = str(get_nested(brief, "server.install_root") or "/opt/agenthub").strip()
    admin_email = str(get_nested(brief, "server.admin_email") or "").strip()

    if mode == "local_laptop":
        return "\n".join(
            [
                "copy .env.example .env",
                "python -m venv .venv",
                ".\\.venv\\Scripts\\python -m pip install -r apps/api/requirements.txt",
                "npm install",
                "npm run local:dev",
            ]
        )

    lines = [
        "sudo apt-get update",
        "sudo apt-get install -y git curl",
        f"git clone {repo_url} /tmp/agenthub-src",
        "cd /tmp/agenthub-src",
    ]
    install = [
        "sudo bash scripts/install-selfhost-linux.sh",
        f"  --domain {domain}",
        f"  --install-root {install_root}",
    ]
    if branch and branch != "main":
        lines.append(f"git checkout {branch}")
    if mode == "public_relay":
        install.append(f"  --admin-email {admin_email}")
    else:
        install.extend(
            [
                f"  --public-base-url https://{domain}",
                "  --skip-certbot",
            ]
        )
    lines.append(" \\\n".join(install))
    return "\n".join(lines)


def smoke_command(brief: dict[str, Any]) -> str:
    mode = str(brief["mode"]).strip()
    if mode == "local_laptop":
        return (
            "Open http://localhost:43073, create the owner with AGENTHUB_BOOTSTRAP_TOKEN, "
            "and use http://127.0.0.1:43080/healthz for the backend check."
        )
    domain = str(get_nested(brief, "server.domain") or "").strip()
    insecure = " --insecure" if mode == "tailscale_private" else ""
    return (
        f"bash scripts/check-selfhost.sh --base-url https://{domain} "
        f"--expect-worker-bundles{' --expect-public-relay' if mode == 'public_relay' else ''}{insecure}"
    ).strip()


def worker_summary(brief: dict[str, Any]) -> str:
    windows = bool(get_nested(brief, "workers.windows"))
    linux = bool(get_nested(brief, "workers.linux"))
    workspace_roots = get_nested(brief, "workers.workspace_roots") or []
    roots = ", ".join(str(item) for item in workspace_roots) if workspace_roots else "use defaults"
    targets: list[str] = []
    if windows:
        targets.append("Windows worker via Add Worker bundle command")
    if linux:
        targets.append("Linux worker via Add Worker bundle command")
    if not targets:
        targets.append("No worker requested yet")
    return f"{'; '.join(targets)}; workspace roots: {roots}"


def render_text(brief: dict[str, Any]) -> str:
    mode = str(brief["mode"]).strip()
    voice_provider = str(get_nested(brief, "voice.provider") or "none").strip()
    lines = [
        f"Mode: {mode}",
        f"Voice provider: {voice_provider}",
        "",
        "Install command:",
        install_command(brief),
        "",
        "Smoke command:",
        smoke_command(brief),
        "",
        "Worker onboarding:",
        worker_summary(brief),
        "",
        "Next step:",
        "Open AgentHub, create the owner, then use Add Worker to generate the install command.",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=usage())
    parser.add_argument("--brief", type=Path, required=True, help="Path to a deployment brief JSON file.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    args = parser.parse_args()

    brief = load_brief(args.brief.resolve())
    missing = validate_brief(brief)
    if missing:
        sys.stderr.write("Missing fields in deployment brief:\n")
        for field in missing:
            sys.stderr.write(f"- {field}\n")
        sys.stderr.write("Please fill the missing fields and run again.\n")
        return 2

    if args.json:
        payload = {
            "mode": brief["mode"],
            "voice_provider": get_nested(brief, "voice.provider") or "none",
            "install_command": install_command(brief),
            "smoke_command": smoke_command(brief),
            "worker_summary": worker_summary(brief),
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        return 0

    sys.stdout.write(render_text(brief) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
