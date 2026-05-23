from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]


def test_selfhost_onboarding_assets_are_present_and_linked() -> None:
    required_files = [
        "docs/AI_DEPLOYMENT_RUNBOOK.md",
        "docs/DEPLOYMENT_BRIEF.example.json",
        "docs/OSS_RELEASE.md",
        "docs/CONFIGURATION_REFERENCE.md",
        "docs/LOCAL_SERVER_MODE.md",
        "docs/OPEN_SOURCE_LAUNCH.md",
        "docs/SELF_HOST_QUICKSTART.md",
        "docs/TAILSCALE_PRIVATE_MODE.md",
        "docs/SELF_HOST_TROUBLESHOOTING.md",
        "scripts/export-oss.ps1",
        "scripts/audit-public-export.py",
        "scripts/install-selfhost-linux.sh",
        "scripts/check-selfhost.sh",
        "scripts/check-selfhost.ps1",
        "scripts/render-deployment-brief.py",
        "scripts/smoke-selfhost-vm.sh",
        "scripts/smoke-worker-onboarding.sh",
        "deploy/nginx/agenthub-selfhost.conf.template",
        ".github/workflows/selfhost-smoke.yml",
    ]

    for relative_path in required_files:
        assert (REPO_ROOT / relative_path).is_file(), relative_path

    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    assert "Personal Agent Control Plane" in readme
    assert "Codex, Claude, Kimi, OpenCode" in readme
    assert "No VM: run AgentHub on your own machine" in readme
    assert "Tailscale-first" in readme
    assert "Local server mode" in readme
    assert "docs/CONFIGURATION_REFERENCE.md" in readme
    assert "docs/LOCAL_SERVER_MODE.md" in readme
    assert "docs/AI_DEPLOYMENT_RUNBOOK.md" in readme
    assert "docs/DEPLOYMENT_BRIEF.example.json" in readme
    assert "docs/OSS_RELEASE.md" in readme
    assert "docs/OPEN_SOURCE_LAUNCH.md" in readme
    assert "docs/SELF_HOST_QUICKSTART.md" in readme
    assert "docs/TAILSCALE_PRIVATE_MODE.md" in readme
    assert "Android APK" in readme
    assert "Windows desktop" in readme
    assert "iOS client" in readme
    assert "macOS desktop" in readme
    assert "Community welcome" in readme
    assert "CONTRIBUTING.md" in readme

    assert (REPO_ROOT / ".github" / "CODEOWNERS").is_file()
    assert (REPO_ROOT / ".github" / "pull_request_template.md").is_file()


def test_selfhost_docs_cover_from_empty_vm_to_worker_smoke() -> None:
    ai_runbook = (REPO_ROOT / "docs" / "AI_DEPLOYMENT_RUNBOOK.md").read_text(encoding="utf-8")
    deployment_brief = (REPO_ROOT / "docs" / "DEPLOYMENT_BRIEF.example.json").read_text(encoding="utf-8")
    config_reference = (REPO_ROOT / "docs" / "CONFIGURATION_REFERENCE.md").read_text(encoding="utf-8")
    local_server = (REPO_ROOT / "docs" / "LOCAL_SERVER_MODE.md").read_text(encoding="utf-8")
    open_source_launch = (REPO_ROOT / "docs" / "OPEN_SOURCE_LAUNCH.md").read_text(encoding="utf-8")
    quickstart = (REPO_ROOT / "docs" / "SELF_HOST_QUICKSTART.md").read_text(encoding="utf-8")
    tailscale = (REPO_ROOT / "docs" / "TAILSCALE_PRIVATE_MODE.md").read_text(encoding="utf-8")
    troubleshooting = (REPO_ROOT / "docs" / "SELF_HOST_TROUBLESHOOTING.md").read_text(encoding="utf-8")

    for expected in [
        '"mode": "public_relay"',
        '"voice"',
        '"provider": "none"',
        '"workers"',
        '"host": "agenthub.example.com"',
    ]:
        assert expected in deployment_brief

    for expected in [
        "render-deployment-brief.py",
        "public_relay",
        "tailscale_private",
        "local_laptop",
        "voice provider",
        "missing fields",
    ]:
        assert expected in ai_runbook

    for expected in [
        "AGENTHUB_VOICE_ASR_PROVIDER",
        "doubao",
        "openai",
        "whisper-1",
        "OPENAI_API_KEY",
        "AGENTHUB_OPENAI_ASR_BASE_URL",
        "AGENTHUB_OPENAI_ASR_MODEL",
    ]:
        assert expected in config_reference

    for expected in [
        "You do not need a VM",
        "Windows",
        "macOS",
        "Linux",
        "Tailscale",
        "CONFIGURATION_REFERENCE.md",
    ]:
        assert expected in local_server

    for expected in [
        "self-hosted",
        "Tailscale-first",
        "local machine can be the server",
        "Android APK",
        "Windows desktop",
        "Hacker News",
    ]:
        assert expected in open_source_launch

    for expected in [
        "Ubuntu 22.04",
        "DNS A record",
        "certbot",
        "AGENTHUB_BOOTSTRAP_TOKEN",
        "Create the owner",
        "Add Worker",
        "public_relay",
        "agenthub-worker-windows.zip",
        "agenthub-worker-linux.tar.gz",
        "scripts/check-selfhost.sh",
    ]:
        assert expected in quickstart

    for expected in [
        "curl -fsSL https://tailscale.com/install.sh | sh",
        "tailscale up",
        "Tailscale DNS",
        "Android",
        "ConnectionMode private",
        "--connection-mode private",
        "/api/internal/",
    ]:
        assert expected in tailscale

    for expected in [
        "nginx 502",
        "cookie",
        "CORS",
        "worker enroll",
        "queued",
        "Android",
    ]:
        assert expected in troubleshooting


def test_contributing_covers_platform_scope_and_prompts() -> None:
    contributing = (REPO_ROOT / "CONTRIBUTING.md").read_text(encoding="utf-8")

    for expected in [
        "Android APK client",
        "Windows desktop client",
        "iOS",
        "macOS",
        "community contributions",
        "Suggested prompt for an iOS contribution",
        "Suggested prompt for a macOS contribution",
        "server URL must stay configurable",
        "Do not hardcode",
        "Configuration-first rule",
    ]:
        assert expected in contributing


def test_selfhost_scripts_expose_safe_help_and_required_checks() -> None:
    export_ps1 = (REPO_ROOT / "scripts" / "export-oss.ps1").read_text(encoding="utf-8")
    export_audit = (REPO_ROOT / "scripts" / "audit-public-export.py").read_text(encoding="utf-8")
    install_script = (REPO_ROOT / "scripts" / "install-selfhost-linux.sh").read_text(encoding="utf-8")
    check_sh = (REPO_ROOT / "scripts" / "check-selfhost.sh").read_text(encoding="utf-8")
    check_ps1 = (REPO_ROOT / "scripts" / "check-selfhost.ps1").read_text(encoding="utf-8")
    render_brief = (REPO_ROOT / "scripts" / "render-deployment-brief.py").read_text(encoding="utf-8")
    smoke_vm = (REPO_ROOT / "scripts" / "smoke-selfhost-vm.sh").read_text(encoding="utf-8")
    smoke_worker = (REPO_ROOT / "scripts" / "smoke-worker-onboarding.sh").read_text(encoding="utf-8")
    workflow = (REPO_ROOT / ".github" / "workflows" / "selfhost-smoke.yml").read_text(encoding="utf-8")
    nginx_template = (REPO_ROOT / "deploy" / "nginx" / "agenthub-selfhost.conf.template").read_text(encoding="utf-8")

    assert "param(" in export_ps1
    assert "AgentHub-OSS" in export_ps1
    assert ".git" in export_ps1
    assert "audit-public-export.py" in export_ps1
    assert "robocopy" in export_ps1

    assert "private-domain" in export_audit
    assert ("agenthub" + ".ifix.xin") in export_audit
    assert ("publish" + "-apk.ps1") in export_audit

    assert "Usage: install-selfhost-linux.sh" in install_script
    assert "--domain" in install_script
    assert "--install-root" in install_script
    assert "AGENTHUB_SECRET_ENCRYPTION_KEY" in install_script
    assert "agenthub-api.service" in install_script
    assert "npm run web:build" in install_script
    assert "--render-only" in install_script
    assert "AGENTHUB_SELFHOST_SYSTEMD_DIR" in install_script
    assert "AGENTHUB_SELFHOST_NGINX_CONF_DIR" in install_script

    assert "Usage: check-selfhost.sh" in check_sh
    assert "/healthz" in check_sh
    assert "/api/worker/enroll" in check_sh
    assert "/api/internal/jobs/claim" in check_sh
    assert "--expect-worker-bundles" in check_sh
    assert "--json" in check_sh
    assert "worker-bundles-manifest.json" in check_sh
    assert "agenthub-worker-windows.zip" in check_sh
    assert "agenthub-worker-linux.tar.gz" in check_sh
    assert "AGENTHUB_CHECKS" in check_sh
    assert "403" in check_sh

    assert "param(" in check_ps1
    assert "/healthz" in check_ps1
    assert "/api/worker/enroll" in check_ps1
    assert "/api/internal/jobs/claim" in check_ps1

    assert "usage:" in render_brief.lower()
    assert "public_relay" in render_brief
    assert "tailscale_private" in render_brief
    assert "local_laptop" in render_brief
    assert "--json" in render_brief
    assert "OpenAI-compatible" in render_brief

    assert "client_max_body_size" in nginx_template
    assert "location ^~ /api/internal/" in nginx_template
    assert "location ^~ /api/worker/" in nginx_template
    assert "try_files $uri /index.html" in nginx_template

    assert "SELFHOST_SMOKE_OK" in smoke_vm
    assert "agenthub.example.com" in smoke_vm
    assert "scripts/install-selfhost-linux.sh" in smoke_vm
    assert "scripts/check-selfhost.sh" in smoke_vm
    assert "scripts/smoke-worker-onboarding.sh" in smoke_vm

    assert "/api/worker-enrollments" in smoke_worker
    assert "/api/worker/enroll" in smoke_worker
    assert "/api/worker/heartbeat" in smoke_worker
    assert "/api/jobs" in smoke_worker
    assert "/api/worker/jobs/claim" in smoke_worker
    assert "health_check" in smoke_worker
    assert "AGENTHUB_JSON_PAYLOAD" in smoke_worker

    assert "workflow_dispatch" in workflow
    assert "AGENTHUB_SELFHOST_SMOKE_HOST" in workflow
    assert "AGENTHUB_SELFHOST_SMOKE_SSH_KEY" in workflow
    assert "SELFHOST_SMOKE_OK" in workflow
    assert "smoke-selfhost-vm.sh" in workflow
    assert "run_worker_smoke" in workflow


def test_selfhost_shell_scripts_parse_with_bash_help() -> None:
    if os.name == "nt" or shutil.which("bash") is None:
        for script_name in ["install-selfhost-linux.sh", "check-selfhost.sh", "smoke-selfhost-vm.sh", "smoke-worker-onboarding.sh"]:
            content = (REPO_ROOT / "scripts" / script_name).read_text(encoding="utf-8")
            assert "set -Eeuo pipefail" in content
            assert "-h|--help" in content
        pytest.skip("bash shell execution is not reliable in this environment")

    for script_name in ["install-selfhost-linux.sh", "check-selfhost.sh", "smoke-selfhost-vm.sh", "smoke-worker-onboarding.sh"]:
        result = subprocess.run(
            ["bash", f"scripts/{script_name}", "--help"],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        assert "Usage:" in result.stdout


def test_selfhost_powershell_checker_parses_on_windows() -> None:
    if os.name != "nt":
        pytest.skip("PowerShell parser is only available on Windows")

    script_path = REPO_ROOT / "scripts" / "check-selfhost.ps1"
    escaped_script_path = str(script_path).replace("'", "''")
    command = "\n".join(
        [
            "$ErrorActionPreference = 'Stop'",
            "$tokens = $null",
            "$errors = $null",
            f"[System.Management.Automation.Language.Parser]::ParseFile('{escaped_script_path}', [ref]$tokens, [ref]$errors) | Out-Null",
            "if ($errors.Count) {",
            "  $message = ($errors | ForEach-Object { \"$($_.Extent.StartLineNumber):$($_.Message)\" }) -join '; '",
            "  throw $message",
            "}",
        ]
    )

    subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        check=True,
        capture_output=True,
        text=True,
    )


def test_selfhost_installer_supports_render_only_config_generation() -> None:
    script_path = REPO_ROOT / "scripts" / "install-selfhost-linux.sh"
    if os.name == "nt" or shutil.which("bash") is None:
        content = script_path.read_text(encoding="utf-8")
        assert "--render-only" in content
        assert "AGENTHUB_SELFHOST_SYSTEMD_DIR" in content
        assert "AGENTHUB_SELFHOST_NGINX_CONF_DIR" in content
        assert "render-only complete" in content
        pytest.skip("Linux shell execution is not available in this environment")

    with tempfile.TemporaryDirectory(prefix="agenthub-selfhost-render-") as temp_dir:
        temp_root = Path(temp_dir)
        install_root = temp_root / "install"
        systemd_dir = temp_root / "systemd"
        nginx_dir = temp_root / "nginx"
        data_dir = temp_root / "data"
        cert_dir = temp_root / "certs"

        result = subprocess.run(
            [
                "bash",
                "scripts/install-selfhost-linux.sh",
                "--domain",
                "agenthub-smoke.example.test",
                "--install-root",
                str(install_root),
                "--render-only",
            ],
            cwd=REPO_ROOT,
            env={
                **os.environ,
                "AGENTHUB_SELFHOST_SYSTEMD_DIR": str(systemd_dir),
                "AGENTHUB_SELFHOST_NGINX_CONF_DIR": str(nginx_dir),
                "AGENTHUB_SELFHOST_DATA_DIR": str(data_dir),
                "AGENTHUB_SELFHOST_CERT_DIR": str(cert_dir),
            },
            check=True,
            capture_output=True,
            text=True,
        )

        env_path = install_root / ".env"
        service_path = systemd_dir / "agenthub-api.service"
        nginx_path = nginx_dir / "agenthub.conf"

        assert env_path.is_file()
        assert service_path.is_file()
        assert nginx_path.is_file()
        assert "AGENTHUB_PUBLIC_BASE_URL=https://agenthub-smoke.example.test" in env_path.read_text(encoding="utf-8")
        assert f"AGENTHUB_DATABASE_URL=sqlite+pysqlite:///{data_dir}/agenthub.db" in env_path.read_text(encoding="utf-8")
        assert f"WorkingDirectory={install_root}" in service_path.read_text(encoding="utf-8")
        assert "server_name agenthub-smoke.example.test;" in nginx_path.read_text(encoding="utf-8")
        assert f"ssl_certificate {cert_dir}/fullchain.pem;" in nginx_path.read_text(encoding="utf-8")
        assert "render-only complete" in result.stdout


def test_render_deployment_brief_renders_example_and_reports_missing_fields() -> None:
    script_path = REPO_ROOT / "scripts" / "render-deployment-brief.py"
    brief_path = REPO_ROOT / "docs" / "DEPLOYMENT_BRIEF.example.json"

    example = subprocess.run(
        ["python", str(script_path), "--brief", str(brief_path)],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    assert "Mode: public_relay" in example.stdout
    assert "Voice provider: none" in example.stdout
    assert "install-selfhost-linux.sh" in example.stdout
    assert "check-selfhost.sh" in example.stdout
    assert "Add Worker" in example.stdout

    with tempfile.TemporaryDirectory(prefix="agenthub-brief-") as temp_dir:
        broken_brief = Path(temp_dir) / "brief.json"
        broken_brief.write_text(
            '{"mode":"public_relay","server":{"host":"agenthub.example.com"}}',
            encoding="utf-8",
        )
        broken = subprocess.run(
            ["python", str(script_path), "--brief", str(broken_brief)],
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        assert broken.returncode == 2
        assert "missing fields" in broken.stderr.lower()
        assert "server.domain" in broken.stderr
