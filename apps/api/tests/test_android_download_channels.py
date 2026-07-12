from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
NGINX_TEMPLATE = REPO_ROOT / "deploy" / "nginx" / "agenthub-selfhost.conf.template"
SYNC_SCRIPT = REPO_ROOT / "scripts" / "sync-android-release-assets.sh"
ASSETS = (
    "agenthub-android-release.apk",
    "agenthub-native-android-release.apk",
    "SHA256SUMS",
)


def _exact_location(config: str, public_path: str) -> str:
    match = re.search(
        rf"location\s*=\s*{re.escape(public_path)}\s*\{{(?P<body>.*?)\n\s*\}}",
        config,
        flags=re.DOTALL,
    )
    assert match is not None, f"missing exact Nginx location for {public_path}"
    return match.group("body")


def test_nginx_serves_android_release_assets_from_fail_closed_exact_locations() -> None:
    config = NGINX_TEMPLATE.read_text(encoding="utf-8")

    for filename in ASSETS:
        body = _exact_location(config, f"/downloads/{filename}")
        assert "root /opt/agenthub/data;" in body
        assert f"try_files /downloads/{filename} =404;" in body
        assert "Cache-Control" in body
        assert "no-store" in body
        assert "Content-Disposition" in body
        assert f'filename="{filename}"' in body

    for filename in ASSETS[:2]:
        body = _exact_location(config, f"/downloads/{filename}")
        assert "application/vnd.android.package-archive" in body

    checksum_body = _exact_location(config, "/downloads/SHA256SUMS")
    assert "text/plain" in checksum_body


def test_android_release_sync_script_has_versioned_verified_atomic_contract() -> None:
    assert SYNC_SCRIPT.is_file()
    script = SYNC_SCRIPT.read_text(encoding="utf-8")

    assert "holdonyb/AgentHub-OSS" in script
    assert "v1.0.0" in script
    assert "/opt/agenthub/data/downloads" in script
    for filename in ASSETS:
        assert filename in script
    assert "mktemp -d" in script
    assert "sha256sum -c" in script
    assert "mv -f" in script
    assert 'rm -rf "$DESTINATION"' not in script


@pytest.mark.skipif(os.name == "nt", reason="shell behavior runs in Linux CI")
def test_android_release_sync_is_idempotent_and_preserves_existing_files(tmp_path: Path) -> None:
    release_dir = tmp_path / "release"
    destination = tmp_path / "downloads"
    fake_bin = tmp_path / "bin"
    release_dir.mkdir()
    destination.mkdir()
    fake_bin.mkdir()

    payloads = {
        ASSETS[0]: b"webview-apk-v1",
        ASSETS[1]: b"native-apk-v1",
    }
    for filename, payload in payloads.items():
        (release_dir / filename).write_bytes(payload)
    checksum_lines = [
        f"{hashlib.sha256(payload).hexdigest()}  {filename}"
        for filename, payload in payloads.items()
    ]
    (release_dir / "SHA256SUMS").write_text("\r\n".join(checksum_lines) + "\r\n", encoding="utf-8")
    (destination / "keep.txt").write_text("preserve me\n", encoding="utf-8")

    fake_curl = fake_bin / "curl"
    fake_curl.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while (($#)); do
  case "$1" in
    -o|--output)
      output="$2"
      shift 2
      ;;
    http://*|https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
cp "$FAKE_RELEASE_DIR/${url##*/}" "$output"
""",
        encoding="utf-8",
    )
    fake_curl.chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "FAKE_RELEASE_DIR": str(release_dir),
    }
    command = [
        "bash",
        str(SYNC_SCRIPT),
        "--repository",
        "example/AgentHub",
        "--tag",
        "v1.0.0",
        "--destination",
        str(destination),
    ]

    for _ in range(2):
        subprocess.run(command, cwd=REPO_ROOT, env=env, check=True, capture_output=True, text=True)

    for filename, payload in payloads.items():
        assert (destination / filename).read_bytes() == payload
    assert (destination / "keep.txt").read_text(encoding="utf-8") == "preserve me\n"

    (release_dir / ASSETS[1]).write_bytes(b"corrupt-native-apk")
    failed = subprocess.run(command, cwd=REPO_ROOT, env=env, check=False, capture_output=True, text=True)
    assert failed.returncode != 0
    for filename, payload in payloads.items():
        assert (destination / filename).read_bytes() == payload
    assert (destination / "keep.txt").read_text(encoding="utf-8") == "preserve me\n"

    staging_entries = [path for path in destination.iterdir() if path.name.startswith(".agenthub-android-release.")]
    assert staging_entries == []
