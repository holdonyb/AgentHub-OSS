from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


ARCHIVE_NAMES = {
    "windows": "agenthub-worker-windows.zip",
    "linux": "agenthub-worker-linux.tar.gz",
}
MANIFEST_NAME = "worker-bundles-manifest.json"
VERSION_FILE = Path(".runtime/worker-bundle-version.txt")
DENIED_TOP_LEVEL_PATHS = {".runtime", ".venv"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update an installed AgentHub worker from a published bundle")
    parser.add_argument("--platform", choices=sorted(ARCHIVE_NAMES), required=True)
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def env_flag(name: str, default: bool = True) -> bool:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    return value.strip().lower() not in {"0", "false", "no", "off", "disabled"}


def api_base_url() -> str:
    value = os.environ.get("AGENTHUB_API_URL", "").strip()
    if not value:
        raise RuntimeError("AGENTHUB_API_URL is required when update URLs are not configured")
    return value.rstrip("/")


def default_manifest_url() -> str:
    configured = os.environ.get("AGENTHUB_WORKER_MANIFEST_URL", "").strip()
    if configured:
        return configured
    return f"{api_base_url()}/downloads/workers/{MANIFEST_NAME}"


def default_bundle_url(platform: str, manifest_url: str, archive_name: str) -> str:
    configured = os.environ.get("AGENTHUB_WORKER_BUNDLE_URL", "").strip()
    if configured:
        return configured
    return urllib.parse.urljoin(manifest_url, archive_name)


def read_url(url: str) -> bytes:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme in {"", "file"}:
        if parsed.scheme == "file":
            path = Path(urllib.request.url2pathname(parsed.path))
        else:
            path = Path(url)
        return path.read_bytes()

    request = urllib.request.Request(url, headers={"User-Agent": "AgentHubWorkerUpdater/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def load_manifest(manifest_url: str) -> dict[str, Any]:
    payload = read_url(manifest_url)
    return json.loads(payload.decode("utf-8"))


def find_bundle(manifest: dict[str, Any], platform: str) -> dict[str, Any]:
    for bundle in manifest.get("bundles", []):
        if bundle.get("platform") == platform:
            return bundle
    raise RuntimeError(f"Manifest does not contain a {platform} worker bundle")


def current_version(repo_root: Path) -> str:
    version_path = repo_root / VERSION_FILE
    if not version_path.exists():
        return ""
    return version_path.read_text(encoding="utf-8").strip()


def write_current_version(repo_root: Path, version: str) -> None:
    version_path = repo_root / VERSION_FILE
    version_path.parent.mkdir(parents=True, exist_ok=True)
    version_path.write_text(version.strip() + "\n", encoding="utf-8")


def safe_relative_path(value: str) -> PurePosixPath:
    normalized = value.replace("\\", "/").strip("/")
    path = PurePosixPath(normalized)
    if not normalized or path.is_absolute() or ".." in path.parts:
        raise RuntimeError(f"Unsafe bundle path: {value}")
    if path.parts[0] in DENIED_TOP_LEVEL_PATHS:
        raise RuntimeError(f"Refusing to update protected path: {value}")
    return path


def safe_destination(root: Path, member_name: str) -> Path:
    relative = safe_relative_path(member_name)
    destination = root.joinpath(*relative.parts)
    resolved_root = root.resolve()
    resolved_destination = destination.resolve()
    if resolved_root != resolved_destination and resolved_root not in resolved_destination.parents:
        raise RuntimeError(f"Unsafe archive member: {member_name}")
    return destination


def extract_zip(archive_path: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive_path) as archive:
        for member in archive.infolist():
            if member.is_dir():
                safe_destination(destination, member.filename).mkdir(parents=True, exist_ok=True)
                continue
            target = safe_destination(destination, member.filename)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)


def extract_tar(archive_path: Path, destination: Path) -> None:
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive.getmembers():
            if not (member.isfile() or member.isdir()):
                continue
            target = safe_destination(destination, member.name)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                continue
            with source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(member.mode & 0o777)


def extract_archive(platform: str, archive_path: Path, destination: Path) -> Path:
    if platform == "windows":
        extract_zip(archive_path, destination)
    else:
        extract_tar(archive_path, destination)

    bundle_root = destination / "agenthub-worker"
    if not bundle_root.is_dir():
        raise RuntimeError("Worker archive did not contain agenthub-worker root")
    return bundle_root


def copy_tree_contents(source: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for child in source.iterdir():
        copy_path(child, target / child.name)


def copy_path(source: Path, target: Path) -> None:
    if source.is_dir():
        if target.exists() and not target.is_dir():
            target.unlink()
        copy_tree_contents(source, target)
        return

    if target.exists() and target.is_dir():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def apply_bundle_paths(bundle_root: Path, repo_root: Path, paths: list[str]) -> None:
    for raw_path in paths:
        relative = safe_relative_path(raw_path)
        source = bundle_root.joinpath(*relative.parts)
        if not source.exists():
            raise RuntimeError(f"Bundle path is missing from archive: {raw_path}")
        target = repo_root.joinpath(*relative.parts)
        copy_path(source, target)


def install_requirements(repo_root: Path) -> None:
    if env_flag("AGENTHUB_WORKER_UPDATE_SKIP_PIP", default=False):
        return
    requirements = repo_root / "workers" / "requirements.txt"
    if not requirements.exists():
        return
    subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(requirements)], check=True)


def update_worker(platform: str, repo_root: Path, dry_run: bool = False, force: bool = False) -> str:
    if not env_flag("AGENTHUB_WORKER_AUTO_UPDATE", default=True):
        return "worker auto-update disabled"

    manifest_url = default_manifest_url()
    manifest = load_manifest(manifest_url)
    bundle = find_bundle(manifest, platform)
    bundle_version = str(manifest.get("bundle_version") or bundle.get("bundle_version") or "").strip()
    if not bundle_version:
        raise RuntimeError("Worker manifest is missing bundle_version")

    installed_version = current_version(repo_root)
    if installed_version == bundle_version and not force:
        return f"worker bundle already at {bundle_version}"

    archive_name = str(bundle.get("archive") or ARCHIVE_NAMES[platform])
    bundle_url = default_bundle_url(platform, manifest_url, archive_name)
    archive_payload = read_url(bundle_url)
    expected_sha = str(bundle.get("sha256") or "").strip().lower()
    actual_sha = sha256_bytes(archive_payload)
    if expected_sha and expected_sha != actual_sha:
        raise RuntimeError(f"Worker bundle sha256 mismatch: expected {expected_sha}, got {actual_sha}")

    paths = [str(path) for path in bundle.get("paths", [])]
    if not paths:
        raise RuntimeError("Worker manifest bundle has no paths")

    if dry_run:
        return f"would update worker bundle from {installed_version or '<none>'} to {bundle_version}"

    with tempfile.TemporaryDirectory(prefix=f"agenthub-worker-update-{platform}-") as temp_dir:
        temp_root = Path(temp_dir)
        archive_path = temp_root / archive_name
        archive_path.write_bytes(archive_payload)
        bundle_root = extract_archive(platform, archive_path, temp_root / "extract")
        apply_bundle_paths(bundle_root, repo_root, paths)

    install_requirements(repo_root)
    write_current_version(repo_root, bundle_version)
    return f"updated worker bundle to {bundle_version}"


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo_root).expanduser().resolve()
    try:
        message = update_worker(args.platform, repo_root, dry_run=args.dry_run, force=args.force)
    except Exception as exc:
        print(f"worker auto-update failed: {exc}", file=sys.stderr)
        return 1

    print(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
