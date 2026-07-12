from __future__ import annotations

import json
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
        "docs/DOCKER_SELFHOST_MODE.md",
        "docs/OSS_RELEASE.md",
        "docs/CONFIGURATION_REFERENCE.md",
        "docs/LOCAL_SERVER_MODE.md",
        "docs/OPEN_SOURCE_LAUNCH.md",
        "docs/RELIABILITY_SLO.md",
        "docs/SELF_HOST_QUICKSTART.md",
        "docs/TAILSCALE_PRIVATE_MODE.md",
        "docs/SELF_HOST_TROUBLESHOOTING.md",
        "scripts/audit-public-export.py",
        "scripts/check-worker-package-version.mjs",
        "scripts/install-hooks.ps1",
        "scripts/install.sh",
        "scripts/install-selfhost-linux.sh",
        "scripts/run-local-dev.mjs",
        "scripts/check-selfhost.sh",
        "scripts/check-selfhost.ps1",
        "scripts/render-deployment-brief.py",
        "scripts/smoke-selfhost-vm.sh",
        "scripts/smoke-worker-onboarding.sh",
        "deploy/docker-compose.selfhost.yml",
        "deploy/docker/Dockerfile.api",
        "deploy/docker/Dockerfile.web",
        "deploy/docker/nginx-selfhost.conf",
        "deploy/nginx/agenthub-selfhost.conf.template",
        "website/download/index.html",
        "website/install/index.html",
        "website/press/index.html",
        "website/release/index.html",
        "docs/LAUNCH_COPY.md",
        ".github/workflows/selfhost-smoke.yml",
        ".github/workflows/npm-worker-publish.yml",
        "docs/WORKER_PACKAGE_RELEASE.md",
    ]

    for relative_path in required_files:
        assert (REPO_ROOT / relative_path).is_file(), relative_path

    assert (REPO_ROOT / "docs" / "assets" / "agenthub-release-showcase.svg").is_file()

    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    readme_en = (REPO_ROOT / "README.en.md").read_text(encoding="utf-8")
    assert "[简体中文](README.md) | [English](README.en.md)" in readme
    assert "个人 AI Agent 控制台" in readme
    assert "Codex、Claude、Kimi、OpenCode" in readme
    assert "推荐方式：直接给另一个 agent 一份部署提示词" in readme
    assert "docs/AI_DEPLOYMENT_RUNBOOK.md" in readme
    assert "docs/DEPLOYMENT_BRIEF.example.json" in readme
    assert "先选一种 server 安装模式，再抄对应命令" in readme
    assert "本机模式：一条命令拉起本地控制台" in readme
    assert "https://myagenthub.dev/install.sh" in readme
    assert "https://myagenthub.dev/install/" in readme
    assert "https://myagenthub.dev/release/" in readme
    assert "https://myagenthub.dev/press/" in readme
    assert "npx agenthub-worker" in readme
    assert "Docker 模式" in readme
    assert "VM 模式" in readme
    assert "npm run local:dev" in readme
    assert "http://localhost:43073" in readme
    assert "Tailscale-first 私有模式" in readme
    assert "Local server mode" in readme
    assert "Android APK" in readme
    assert "Windows desktop" in readme
    assert "iOS client" in readme
    assert "macOS desktop" in readme
    assert "源码与 CI 支持" in readme
    assert "签名 IPA/真机分发尚未完成" in readme
    assert "English README" in readme

    testing_doc = (REPO_ROOT / "docs" / "TESTING.md").read_text(encoding="utf-8")
    slo_doc = (REPO_ROOT / "docs" / "RELIABILITY_SLO.md").read_text(encoding="utf-8")
    assert "RELIABILITY_SLO.md" in testing_doc
    for output_field in [
        "message_delivery_success_rate_7d",
        "notification_latency_p95_seconds",
        "worker_recovery_success_rate",
        "weekly_codex_exec_fallback_count",
    ]:
        assert output_field in slo_doc

    assert "[简体中文](README.md) | [English](README.en.md)" in readme_en
    assert "Personal Agent Control Plane" in readme_en
    assert "Codex, Claude, Kimi, OpenCode" in readme_en
    assert "Recommended: deploy from an agent-friendly prompt" in readme_en
    assert "Choose one server install mode first, then copy the matching command" in readme_en
    assert "Local mode: one command for the local control plane" in readme_en
    assert "https://myagenthub.dev/install.sh" in readme_en
    assert "https://myagenthub.dev/install/" in readme_en
    assert "https://myagenthub.dev/release/" in readme_en
    assert "https://myagenthub.dev/press/" in readme_en
    assert "npx agenthub-worker" in readme_en
    assert "Docker mode" in readme_en
    assert "VM mode" in readme_en
    assert "npm run local:dev" in readme_en
    assert "http://localhost:43073" in readme_en
    assert "Tailscale-first private mode" in readme_en
    assert "Source and CI supported" in readme_en
    assert "signed IPA/device distribution is not complete" in readme_en
    assert "中文 README" in readme_en

    website_index = (REPO_ROOT / "website" / "index.html").read_text(encoding="utf-8")
    website_download = (REPO_ROOT / "website" / "download" / "index.html").read_text(encoding="utf-8")
    website_install = (REPO_ROOT / "website" / "install" / "index.html").read_text(encoding="utf-8")
    website_press = (REPO_ROOT / "website" / "press" / "index.html").read_text(encoding="utf-8")
    website_release = (REPO_ROOT / "website" / "release" / "index.html").read_text(encoding="utf-8")
    web_favicon = (REPO_ROOT / "apps" / "web" / "public" / "favicon.svg").read_text(encoding="utf-8")
    assert 'href="/download/"' in website_index
    assert 'href="/install/"' in website_index
    assert 'href="/press/"' in website_index
    assert 'href="/release/"' in website_index
    assert 'href="/assets/agenthub-mark.svg"' in website_index
    assert '<title>AgentHub</title>' in web_favicon
    assert '#79D1FF' in web_favicon
    assert '#3EA5FF' in web_favicon
    assert 'agenthub-icon-mask' not in web_favicon
    assert "先选安装模式" in website_index
    assert "下载 release 资产" in website_download
    for android_page in [website_download, website_release]:
        assert "v1.0.0" in android_page
        assert "agenthub-android-release.apk" in android_page
        assert "agenthub-native-android-release.apk" in android_page
        assert "xin.ifix.agenthub" in android_page
        assert "dev.myagenthub.mobile" in android_page
        assert "可与当前版共存" in android_page
        assert "bd77640e9cffc38cf5ce4728c0ddbe74b06c65d4c6155c793abfe4638137dc50" in android_page
        assert "4ff07d1e2172c1589b610238669e67216efb9cfdfc0ed0adad328b154b3495f7" in android_page
        assert "v0.1.1" not in android_page
    assert "更新当前版" in website_download
    assert "安装原生版" in website_download
    assert "agenthub-worker-windows.zip" in website_download
    assert "SHA256SUMS" in website_download
    assert "Claude / Codex / Kimi" in website_download
    assert "AgentHub v1.0.0" in website_release
    assert "Claude / Codex / Kimi" in website_release
    assert "Launch copy, links, and assets" in website_press
    assert "docs/LAUNCH_COPY.md" in website_press
    assert "中文长版" in website_press
    assert "本机模式" in website_install
    assert "Docker 模式" in website_install
    assert "VM 模式" in website_install
    assert "npm run local:dev" in website_install
    assert "http://localhost:43073" in website_install

    assert (REPO_ROOT / ".github" / "CODEOWNERS").is_file()
    assert (REPO_ROOT / ".github" / "pull_request_template.md").is_file()


def test_selfhost_docs_cover_from_empty_vm_to_worker_smoke() -> None:
    ai_runbook = (REPO_ROOT / "docs" / "AI_DEPLOYMENT_RUNBOOK.md").read_text(encoding="utf-8")
    deployment_brief = (REPO_ROOT / "docs" / "DEPLOYMENT_BRIEF.example.json").read_text(encoding="utf-8")
    config_reference = (REPO_ROOT / "docs" / "CONFIGURATION_REFERENCE.md").read_text(encoding="utf-8")
    docker_mode = (REPO_ROOT / "docs" / "DOCKER_SELFHOST_MODE.md").read_text(encoding="utf-8")
    local_server = (REPO_ROOT / "docs" / "LOCAL_SERVER_MODE.md").read_text(encoding="utf-8")
    open_source_launch = (REPO_ROOT / "docs" / "OPEN_SOURCE_LAUNCH.md").read_text(encoding="utf-8")
    launch_copy = (REPO_ROOT / "docs" / "LAUNCH_COPY.md").read_text(encoding="utf-8")
    quickstart = (REPO_ROOT / "docs" / "SELF_HOST_QUICKSTART.md").read_text(encoding="utf-8")
    tailscale = (REPO_ROOT / "docs" / "TAILSCALE_PRIVATE_MODE.md").read_text(encoding="utf-8")
    troubleshooting = (REPO_ROOT / "docs" / "SELF_HOST_TROUBLESHOOTING.md").read_text(encoding="utf-8")
    worker_release = (REPO_ROOT / "docs" / "WORKER_PACKAGE_RELEASE.md").read_text(encoding="utf-8")
    windows_worker = (REPO_ROOT / "workers" / "local-windows" / "agenthub_windows_worker" / "main.py").read_text(encoding="utf-8")
    linux_worker = (REPO_ROOT / "workers" / "local-linux" / "agenthub_linux_worker" / "main.py").read_text(encoding="utf-8")

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
        "http://localhost:43073",
    ]:
        assert expected in config_reference

    for expected in [
        "You do not need a VM",
        "Docker is a separate install mode",
        "Windows",
        "macOS",
        "Linux",
        "Tailscale",
        "CONFIGURATION_REFERENCE.md",
        "npm run local:dev",
        "http://localhost:43073",
        "http://127.0.0.1:43080",
    ]:
        assert expected in local_server

    for expected in [
        "Docker self-host mode",
        "docker compose -f deploy/docker-compose.selfhost.yml up -d --build",
        "http://localhost:8080",
        "reverse proxy",
        "AGENTHUB_COOKIE_SECURE=false",
    ]:
        assert expected in docker_mode

    for expected in [
        "self-hosted",
        "Tailscale-first",
        "local machine can be the server",
        "Docker mode",
        "Android APK",
        "Windows desktop",
        "Hacker News",
        "docs/LAUNCH_COPY.md",
    ]:
        assert expected in open_source_launch

    for expected in [
        "Chinese Launch Post",
        "English Launch Post",
        "X Post",
        "Hacker News",
        "https://myagenthub.dev/release/",
        "Claude / Codex / Kimi",
    ]:
        assert expected in launch_copy

    for expected in [
        "Docker self-host mode",
        "docker compose",
        "LOCAL_SERVER_MODE.md",
        "SELF_HOST_QUICKSTART.md",
    ]:
        assert expected in config_reference

    for expected in [
        "Ubuntu 22.04",
        "DNS A record",
        "certbot",
        "This guide is for the VM path",
        "AGENTHUB_BOOTSTRAP_TOKEN",
        "Create the owner",
        "Add Worker",
        "public_relay",
        "install.sh | bash",
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

    for expected in [
        "agenthub-worker",
        "worker-v",
        "Trusted Publishing",
        "NPM_TOKEN",
        "same version as the repo",
        "npm-worker-publish.yml",
        "id-token: write",
    ]:
        assert expected in worker_release

    assert "http://127.0.0.1:43080" in windows_worker
    assert "http://127.0.0.1:43080" in linux_worker


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
    export_audit = (REPO_ROOT / "scripts" / "audit-public-export.py").read_text(encoding="utf-8")
    install_hooks = (REPO_ROOT / "scripts" / "install-hooks.ps1").read_text(encoding="utf-8")
    wrapper_script = (REPO_ROOT / "scripts" / "install.sh").read_text(encoding="utf-8")
    install_script = (REPO_ROOT / "scripts" / "install-selfhost-linux.sh").read_text(encoding="utf-8")
    check_sh = (REPO_ROOT / "scripts" / "check-selfhost.sh").read_text(encoding="utf-8")
    check_ps1 = (REPO_ROOT / "scripts" / "check-selfhost.ps1").read_text(encoding="utf-8")
    render_brief = (REPO_ROOT / "scripts" / "render-deployment-brief.py").read_text(encoding="utf-8")
    worker_version_script = (REPO_ROOT / "scripts" / "check-worker-package-version.mjs").read_text(encoding="utf-8")
    smoke_vm = (REPO_ROOT / "scripts" / "smoke-selfhost-vm.sh").read_text(encoding="utf-8")
    smoke_worker = (REPO_ROOT / "scripts" / "smoke-worker-onboarding.sh").read_text(encoding="utf-8")
    docker_compose = (REPO_ROOT / "deploy" / "docker-compose.selfhost.yml").read_text(encoding="utf-8")
    docker_api = (REPO_ROOT / "deploy" / "docker" / "Dockerfile.api").read_text(encoding="utf-8")
    docker_web = (REPO_ROOT / "deploy" / "docker" / "Dockerfile.web").read_text(encoding="utf-8")
    docker_nginx = (REPO_ROOT / "deploy" / "docker" / "nginx-selfhost.conf").read_text(encoding="utf-8")
    workflow = (REPO_ROOT / ".github" / "workflows" / "selfhost-smoke.yml").read_text(encoding="utf-8")
    publish_workflow = (REPO_ROOT / ".github" / "workflows" / "npm-worker-publish.yml").read_text(encoding="utf-8")
    nginx_template = (REPO_ROOT / "deploy" / "nginx" / "agenthub-selfhost.conf.template").read_text(encoding="utf-8")

    assert "private-domain" in export_audit
    assert ("agenthub" + ".ifix.xin") in export_audit
    assert ("publish" + "-apk.ps1") in export_audit
    assert "OWNER_HANDLE_ALLOWLIST" in export_audit
    assert "AgentHub-OSS" in export_audit

    assert "pre-commit" in install_hooks
    assert "audit-public-export.py" in install_hooks

    assert "set -Eeuo pipefail" in wrapper_script
    assert "install-selfhost-linux.sh" in wrapper_script

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

    assert "worker-v" in worker_version_script
    assert "packages/worker-cli/package.json" in worker_version_script
    assert "package.json" in worker_version_script

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

    assert "services:" in docker_compose
    assert "api:" in docker_compose
    assert "web:" in docker_compose
    assert "8080:80" in docker_compose
    assert "docker/Dockerfile.api" in docker_compose
    assert "docker/Dockerfile.web" in docker_compose
    assert "AGENTHUB_DATABASE_URL=sqlite+pysqlite:////var/lib/agenthub/agenthub.db" in docker_compose

    assert "FROM python:" in docker_api
    assert "uvicorn" in docker_api
    assert "apps/api/requirements.txt" in docker_api

    assert "FROM node:" in docker_web
    assert "FROM nginx:" in docker_web
    assert "build-worker-bundle.py" in docker_web
    assert "npm run web:build" in docker_web

    assert "location /api/" in docker_nginx
    assert "proxy_pass http://api:8019" in docker_nginx
    assert "try_files $uri /index.html" in docker_nginx

    assert "workflow_dispatch" in workflow
    assert "AGENTHUB_SELFHOST_SMOKE_HOST" in workflow
    assert "AGENTHUB_SELFHOST_SMOKE_SSH_KEY" in workflow
    assert "SELFHOST_SMOKE_OK" in workflow
    assert "smoke-selfhost-vm.sh" in workflow
    assert "run_worker_smoke" in workflow

    assert "workflow_dispatch" in publish_workflow
    assert "id-token: write" in publish_workflow
    assert 'node-version: "24"' in publish_workflow
    assert "agenthub-worker" in publish_workflow
    assert "packages/worker-cli" in publish_workflow
    assert "check-worker-package-version.mjs" in publish_workflow
    assert "NODE_AUTH_TOKEN" in publish_workflow
    assert "Trusted Publishing" in publish_workflow
    assert "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}" in publish_workflow
    assert "env.NODE_AUTH_TOKEN == ''" in publish_workflow
    assert "env.NODE_AUTH_TOKEN != ''" in publish_workflow


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

    with tempfile.TemporaryDirectory(prefix="agenthub-local-brief-") as temp_dir:
        local_brief = Path(temp_dir) / "local-brief.json"
        local_brief.write_text(
            json.dumps(
                {
                    "mode": "local_laptop",
                    "voice": {"provider": "none"},
                    "workers": {"windows": True, "workspace_roots": ["E:/Work"]},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        local_result = subprocess.run(
            ["python", str(script_path), "--brief", str(local_brief)],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        assert "npm run local:dev" in local_result.stdout
        assert "http://localhost:43073" in local_result.stdout
        assert "http://127.0.0.1:43080/healthz" in local_result.stdout

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
