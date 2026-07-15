from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from hashlib import sha256
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]


def _load_bundle_builder():
    script_path = REPO_ROOT / "scripts" / "build-worker-bundle.py"
    spec = importlib.util.spec_from_file_location("build_worker_bundle", script_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_worker_updater():
    script_path = REPO_ROOT / "scripts" / "worker_self_update.py"
    spec = importlib.util.spec_from_file_location("worker_self_update", script_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_worker_bundle_builder_emits_windows_and_linux_archives() -> None:
    module = _load_bundle_builder()
    with tempfile.TemporaryDirectory(prefix="agenthub-worker-bundle-test-") as temp_dir:
        output_root = Path(temp_dir)
        bundles = [
            module.build_platform_bundle("windows", "test-build", output_root),
            module.build_platform_bundle("linux", "test-build", output_root),
        ]
        module.build_manifest("test-build", output_root, bundles)

        windows_bundle = output_root / "agenthub-worker-windows.zip"
        linux_bundle = output_root / "agenthub-worker-linux.tar.gz"
        manifest_path = output_root / "worker-bundles-manifest.json"

        assert windows_bundle.is_file()
        assert linux_bundle.is_file()
        assert manifest_path.is_file()

        with zipfile.ZipFile(windows_bundle) as archive:
            names = archive.namelist()
            assert "agenthub-worker/scripts/install-windows-worker.ps1" in names
            assert "agenthub-worker/scripts/update-windows-worker.ps1" in names
            assert "agenthub-worker/scripts/worker_self_update.py" in names
            assert "agenthub-worker/workers/local-windows/agenthub_windows_worker/main.py" in names

        with tarfile.open(linux_bundle, "r:gz") as archive:
            names = archive.getnames()
            assert "agenthub-worker/scripts/install-linux-worker.sh" in names
            assert "agenthub-worker/scripts/update-linux-worker.sh" in names
            assert "agenthub-worker/scripts/worker_self_update.py" in names
            assert "agenthub-worker/workers/local-linux/agenthub_linux_worker/main.py" in names


def test_worker_bundle_manifest_records_bundle_metadata() -> None:
    module = _load_bundle_builder()
    with tempfile.TemporaryDirectory(prefix="agenthub-worker-bundle-manifest-") as temp_dir:
        output_root = Path(temp_dir)
        bundles = [
            module.build_platform_bundle("windows", "test-build", output_root),
            module.build_platform_bundle("linux", "test-build", output_root),
        ]
        module.build_manifest("test-build", output_root, bundles)

        payload = json.loads((output_root / "worker-bundles-manifest.json").read_text(encoding="utf-8"))
        assert payload["bundle_version"] == "test-build"
        assert {item["platform"] for item in payload["bundles"]} == {"windows", "linux"}
        archives = {item["archive"] for item in payload["bundles"]}
        assert archives == {"agenthub-worker-windows.zip", "agenthub-worker-linux.tar.gz"}


def test_worker_self_update_applies_bundle_without_nested_directories() -> None:
    script_path = REPO_ROOT / "scripts" / "worker_self_update.py"
    with tempfile.TemporaryDirectory(prefix="agenthub-worker-self-update-") as temp_dir:
        temp_root = Path(temp_dir)
        repo_root = temp_root / "installed-worker"
        source_root = temp_root / "bundle-source" / "agenthub-worker"
        archive_path = temp_root / "agenthub-worker-windows.zip"
        manifest_path = temp_root / "worker-bundles-manifest.json"

        installed_package = repo_root / "workers" / "shared" / "agenthub_worker"
        bundled_package = source_root / "workers" / "shared" / "agenthub_worker"
        bundled_requirements = source_root / "workers" / "requirements.txt"
        installed_package.mkdir(parents=True)
        bundled_package.mkdir(parents=True)
        bundled_requirements.parent.mkdir(parents=True, exist_ok=True)

        (installed_package / "runtime.py").write_text("old-runtime\n", encoding="utf-8")
        (bundled_package / "runtime.py").write_text("new-runtime\n", encoding="utf-8")
        bundled_requirements.write_text("", encoding="utf-8")

        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(source_root.rglob("*")):
                archive.write(path, path.relative_to(source_root.parent))

        digest = sha256(archive_path.read_bytes()).hexdigest()
        manifest_path.write_text(
            json.dumps(
                {
                    "bundle_version": "test-version",
                    "bundles": [
                        {
                            "platform": "windows",
                            "archive": archive_path.name,
                            "sha256": digest,
                            "paths": [
                                "workers/shared/agenthub_worker",
                                "workers/requirements.txt",
                            ],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

        result = subprocess.run(
            [
                sys.executable,
                str(script_path),
                "--platform",
                "windows",
                "--repo-root",
                str(repo_root),
            ],
            check=True,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "AGENTHUB_WORKER_AUTO_UPDATE": "true",
                "AGENTHUB_WORKER_MANIFEST_URL": manifest_path.as_uri(),
                "AGENTHUB_WORKER_BUNDLE_URL": archive_path.as_uri(),
            },
        )

        assert (installed_package / "runtime.py").read_text(encoding="utf-8") == "new-runtime\n"
        assert not (installed_package / "agenthub_worker").exists()
        assert (repo_root / ".runtime" / "worker-bundle-version.txt").read_text(encoding="utf-8").strip() == "test-version"
        assert "updated worker bundle to test-version" in result.stdout


def test_worker_self_update_rejects_manifest_archive_aliases() -> None:
    module = _load_worker_updater()

    with pytest.raises(RuntimeError, match="archive"):
        module.validate_archive_name("macos", "../agenthub-worker-macos.tar.gz")
    with pytest.raises(RuntimeError, match="archive"):
        module.validate_archive_name("macos", "/tmp/agenthub-worker-macos.tar.gz")


def test_worker_self_update_prepares_dependencies_before_replacing_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_worker_updater()
    repo_root = tmp_path / "installed-worker"
    source_root = tmp_path / "bundle-source" / "agenthub-worker"
    archive_path = tmp_path / "agenthub-worker-macos.tar.gz"
    manifest_path = tmp_path / "worker-bundles-manifest.json"
    installed = repo_root / "workers" / "shared" / "agenthub_worker" / "runtime.py"
    bundled = source_root / "workers" / "shared" / "agenthub_worker" / "runtime.py"
    requirements = source_root / "workers" / "requirements.txt"
    installed.parent.mkdir(parents=True)
    bundled.parent.mkdir(parents=True)
    requirements.parent.mkdir(parents=True, exist_ok=True)
    installed.write_text("old-runtime\n", encoding="utf-8")
    bundled.write_text("new-runtime\n", encoding="utf-8")
    requirements.write_text("broken-dependency==0\n", encoding="utf-8")
    with tarfile.open(archive_path, "w:gz") as archive:
        archive.add(source_root, arcname="agenthub-worker")
    manifest_path.write_text(
        json.dumps(
            {
                "bundle_version": "failed-dependencies",
                "bundles": [
                    {
                        "platform": "macos",
                        "archive": archive_path.name,
                        "sha256": sha256(archive_path.read_bytes()).hexdigest(),
                        "paths": ["workers/shared/agenthub_worker", "workers/requirements.txt"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("AGENTHUB_WORKER_AUTO_UPDATE", "true")
    monkeypatch.setenv("AGENTHUB_WORKER_MANIFEST_URL", manifest_path.as_uri())
    monkeypatch.setenv("AGENTHUB_WORKER_BUNDLE_URL", archive_path.as_uri())
    monkeypatch.setattr(
        module,
        "install_requirements",
        lambda _root, *_args: (_ for _ in ()).throw(RuntimeError("pip failed")),
    )

    with pytest.raises(RuntimeError, match="pip failed"):
        module.update_worker("macos", repo_root)

    assert installed.read_text(encoding="utf-8") == "old-runtime\n"
    assert not (repo_root / ".runtime" / "worker-bundle-version.txt").exists()


def test_worker_self_update_rolls_back_all_paths_when_switching_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_worker_updater()
    repo_root = tmp_path / "installed"
    staging_root = tmp_path / "staged"
    backup_root = tmp_path / "backup"
    paths = ["scripts/first.sh", "scripts/second.sh"]
    for relative_path in paths:
        installed = repo_root / relative_path
        staged = staging_root / relative_path
        installed.parent.mkdir(parents=True, exist_ok=True)
        staged.parent.mkdir(parents=True, exist_ok=True)
        installed.write_text(f"old-{installed.name}\n", encoding="utf-8")
        staged.write_text(f"new-{staged.name}\n", encoding="utf-8")

    original_replace = module.os.replace
    failing_source = staging_root / "scripts" / "second.sh"

    def fail_second_switch(source, target):
        if Path(source) == failing_source:
            raise OSError("simulated switch failure")
        return original_replace(source, target)

    monkeypatch.setattr(module.os, "replace", fail_second_switch)

    with pytest.raises(OSError, match="simulated switch failure"):
        module.apply_staged_paths_atomically(staging_root, repo_root, backup_root, paths)

    assert (repo_root / "scripts" / "first.sh").read_text(encoding="utf-8") == "old-first.sh\n"
    assert (repo_root / "scripts" / "second.sh").read_text(encoding="utf-8") == "old-second.sh\n"


def test_worker_scripts_wire_auto_update_configuration() -> None:
    build_script = (REPO_ROOT / "scripts" / "build-worker-bundle.py").read_text(encoding="utf-8")
    install_windows = (REPO_ROOT / "scripts" / "install-windows-worker.ps1").read_text(encoding="utf-8")
    loop_windows = (REPO_ROOT / "scripts" / "windows-worker-loop.ps1").read_text(encoding="utf-8")
    update_windows = (REPO_ROOT / "scripts" / "update-windows-worker.ps1").read_text(encoding="utf-8")
    install_linux = (REPO_ROOT / "scripts" / "install-linux-worker.sh").read_text(encoding="utf-8")

    assert "scripts/update-windows-worker.ps1" in build_script
    assert "scripts/update-linux-worker.sh" in build_script
    assert "scripts/worker_self_update.py" in build_script
    assert "AGENTHUB_WORKER_AUTO_UPDATE" in install_windows
    assert "AGENTHUB_WORKER_BUNDLE_URL" in install_windows
    assert "AGENTHUB_WORKER_MANIFEST_URL" in install_windows
    assert "Get-Command uv" in install_windows
    assert "-RestartCount 999" in install_windows
    assert "-RestartInterval (New-TimeSpan -Minutes 1)" in install_windows
    assert "-ExecutionTimeLimit (New-TimeSpan -Days 30)" in install_windows
    assert "-MultipleInstances IgnoreNew" in install_windows
    assert "New-ScheduledTaskTrigger -Once" in install_windows
    assert "-RepetitionInterval (New-TimeSpan -Minutes 1)" in install_windows
    assert "update-windows-worker.ps1" in loop_windows
    assert "GetEnvironmentVariable('Path', 'User')" in loop_windows
    assert "GetEnvironmentVariable('Path', 'Machine')" in loop_windows
    assert '$ErrorActionPreference = "Continue"' in update_windows
    assert "$updateExitCode = $LASTEXITCODE" in update_windows
    assert 'worker auto-update exited code=$updateExitCode' in update_windows
    assert "AGENTHUB_WORKER_AUTO_UPDATE" in install_linux
    assert "command -v uv" in install_linux
    assert "ExecStartPre=" in install_linux
    assert "update-linux-worker.sh" in install_linux


def test_windows_worker_scripts_parse_on_windows() -> None:
    if os.name != "nt":
        pytest.skip("PowerShell parser is only available on Windows")

    scripts = [
        REPO_ROOT / "scripts" / "install-windows-worker.ps1",
        REPO_ROOT / "scripts" / "windows-worker-loop.ps1",
        REPO_ROOT / "scripts" / "update-windows-worker.ps1",
    ]
    command = "\n".join(
        [
            "$ErrorActionPreference = 'Stop'",
            "foreach ($path in @(" + ",".join("'" + str(path).replace("'", "''") + "'" for path in scripts) + ")) {",
            "  $tokens = $null",
            "  $errors = $null",
            "  [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null",
            "  if ($errors.Count) {",
            "    $message = ($errors | ForEach-Object { \"$($_.Extent.StartLineNumber):$($_.Message)\" }) -join '; '",
            "    throw \"$path $message\"",
            "  }",
            "}",
        ]
    )

    subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        check=True,
        capture_output=True,
        text=True,
    )


def test_linux_worker_installer_supports_dry_run_service_rendering() -> None:
    script_path = REPO_ROOT / "scripts" / "install-linux-worker.sh"
    if os.name == "nt" or shutil.which("bash") is None:
        content = script_path.read_text(encoding="utf-8")
        assert "--skip-systemd" in content
        assert "AGENTHUB_LINUX_WORKER_SERVICE_DIR" in content
        assert "Rendered systemd service" in content
        pytest.skip("Linux shell execution is not available in this environment")

    with tempfile.TemporaryDirectory(prefix="agenthub-linux-worker-install-") as temp_dir:
        temp_root = Path(temp_dir)
        install_root = temp_root / "worker-root"
        service_dir = temp_root / "systemd"
        runtime_dir = install_root / ".runtime"
        runtime_dir.mkdir(parents=True, exist_ok=True)

        result = subprocess.run(
            [
                "bash",
                str(script_path),
                "--api-url",
                "https://agenthub.example.com",
                "--enrollment-token",
                "ahe_test_token",
                "--worker-id",
                "linux-test-01",
                "--install-root",
                str(install_root),
                "--service-name",
                "agenthub-linux-worker-linux-test-01.service",
                "--skip-bootstrap",
                "--skip-systemd",
            ],
            cwd=str(REPO_ROOT),
            env={
                **os.environ,
                "AGENTHUB_LINUX_WORKER_SERVICE_DIR": str(service_dir),
            },
            check=True,
            capture_output=True,
            text=True,
        )

        env_path = runtime_dir / "linux-worker.env"
        service_path = service_dir / "agenthub-linux-worker-linux-test-01.service"
        assert env_path.is_file()
        assert service_path.is_file()
        assert "AGENTHUB_API_URL=https://agenthub.example.com" in env_path.read_text(encoding="utf-8")
        assert f"WorkingDirectory={install_root}" in service_path.read_text(encoding="utf-8")
        assert "Rendered systemd service" in result.stdout
