from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
COMMON_PATHS = (
    Path("packages/protocol/agenthub_protocol"),
    Path("workers/shared/agenthub_worker"),
    Path("workers/requirements.txt"),
    Path("scripts/worker_self_update.py"),
)
WINDOWS_PATHS = (
    Path("workers/local-windows/agenthub_windows_worker"),
    Path("scripts/install-windows-worker.ps1"),
    Path("scripts/windows-worker-loop.ps1"),
    Path("scripts/update-windows-worker.ps1"),
)
LINUX_PATHS = (
    Path("workers/local-linux/agenthub_linux_worker"),
    Path("scripts/install-linux-worker.sh"),
    Path("scripts/update-linux-worker.sh"),
)


def git_revision() -> str:
    try:
        completed = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "--short", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return "unknown"
    return completed.stdout.strip() or "unknown"


def copy_relative_path(relative_path: Path, bundle_root: Path) -> None:
    source_path = REPO_ROOT / relative_path
    if not source_path.exists():
        raise FileNotFoundError(f"Missing source path: {source_path}")

    target_path = bundle_root / relative_path
    target_path.parent.mkdir(parents=True, exist_ok=True)
    if source_path.is_dir():
        shutil.copytree(
            source_path,
            target_path,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
        )
        return
    shutil.copy2(source_path, target_path)


def stage_bundle(platform: str, version: str, staging_root: Path) -> tuple[Path, list[str]]:
    bundle_root = staging_root / "agenthub-worker"
    bundle_root.mkdir(parents=True, exist_ok=True)
    relative_paths = list(COMMON_PATHS)
    if platform == "windows":
        relative_paths.extend(WINDOWS_PATHS)
    elif platform == "linux":
        relative_paths.extend(LINUX_PATHS)
    else:
        raise ValueError(f"Unsupported platform: {platform}")

    for relative_path in relative_paths:
        copy_relative_path(relative_path, bundle_root)

    manifest = {
        "platform": platform,
        "bundle_version": version,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "paths": [str(path).replace("\\", "/") for path in relative_paths],
    }
    (bundle_root / "bundle-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return bundle_root, manifest["paths"]


def write_zip(bundle_root: Path, destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(bundle_root.rglob("*")):
            archive.write(path, path.relative_to(bundle_root.parent))


def _tar_filter(info: tarfile.TarInfo) -> tarfile.TarInfo:
    if info.isdir():
        info.mode = 0o755
    elif info.name.endswith(("scripts/install-linux-worker.sh", "scripts/update-linux-worker.sh")):
        info.mode = 0o755
    else:
        info.mode = 0o644
    return info


def write_tar(bundle_root: Path, destination: Path) -> None:
    with tarfile.open(destination, "w:gz") as archive:
        archive.add(bundle_root, arcname=bundle_root.name, filter=_tar_filter)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_platform_bundle(platform: str, version: str, output_root: Path) -> dict[str, str]:
    output_root.mkdir(parents=True, exist_ok=True)
    archive_name = "agenthub-worker-windows.zip" if platform == "windows" else "agenthub-worker-linux.tar.gz"

    with tempfile.TemporaryDirectory(prefix=f"agenthub-{platform}-bundle-") as temp_dir:
        staging_root = Path(temp_dir)
        bundle_root, paths = stage_bundle(platform, version, staging_root)
        archive_path = output_root / archive_name
        if archive_path.exists():
            archive_path.unlink()
        if platform == "windows":
            write_zip(bundle_root, archive_path)
        else:
            write_tar(bundle_root, archive_path)

    return {
        "platform": platform,
        "archive": archive_name,
        "sha256": sha256(output_root / archive_name),
        "bundle_version": version,
        "paths": json.dumps(paths),
    }


def build_manifest(version: str, output_root: Path, bundles: list[dict[str, str]]) -> None:
    manifest_path = output_root / "worker-bundles-manifest.json"
    manifest = {
        "bundle_version": version,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bundles": [
            {
                "platform": item["platform"],
                "archive": item["archive"],
                "sha256": item["sha256"],
                "paths": json.loads(item["paths"]),
            }
            for item in bundles
        ],
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build AgentHub worker bundle archives")
    parser.add_argument("--output-root", default=str(REPO_ROOT / ".runtime" / "worker-bundles"))
    parser.add_argument("--version", default="")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    version = args.version.strip() or git_revision()
    output_root = Path(args.output_root).expanduser().resolve()
    bundles = [
        build_platform_bundle("windows", version, output_root),
        build_platform_bundle("linux", version, output_root),
    ]
    build_manifest(version, output_root, bundles)


if __name__ == "__main__":
    main()
