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
    "macos": "agenthub-worker-macos.tar.gz",
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
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{version_path.name}.", dir=version_path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = -1
            handle.write(version.strip() + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, version_path)
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        temporary_path.unlink(missing_ok=True)
        raise


def validate_archive_name(platform: str, archive_name: str) -> str:
    expected = ARCHIVE_NAMES[platform]
    if archive_name != expected or Path(archive_name).name != archive_name or "/" in archive_name or "\\" in archive_name:
        raise RuntimeError(f"Worker manifest archive mismatch: expected {expected}, got {archive_name or '<missing>'}")
    return archive_name


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


def stage_bundle_paths(bundle_root: Path, staging_root: Path, paths: list[str]) -> None:
    for raw_path in paths:
        relative = safe_relative_path(raw_path)
        source = bundle_root.joinpath(*relative.parts)
        if not source.exists():
            raise RuntimeError(f"Bundle path is missing from archive: {raw_path}")
        copy_path(source, staging_root.joinpath(*relative.parts))


def _remove_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _apply_switch_operations(operations: list[tuple[Path, Path, Path]]) -> None:
    switched: list[tuple[Path, Path, bool]] = []
    try:
        for staged, target, backup in operations:
            target.parent.mkdir(parents=True, exist_ok=True)
            backup.parent.mkdir(parents=True, exist_ok=True)
            had_original = target.exists() or target.is_symlink()
            if had_original:
                os.replace(target, backup)
            try:
                os.replace(staged, target)
            except BaseException:
                if had_original and backup.exists():
                    os.replace(backup, target)
                raise
            switched.append((target, backup, had_original))
    except BaseException:
        for target, backup, had_original in reversed(switched):
            if target.exists() or target.is_symlink():
                _remove_path(target)
            if had_original and (backup.exists() or backup.is_symlink()):
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(backup, target)
        raise


def apply_staged_paths_atomically(
    staging_root: Path,
    repo_root: Path,
    backup_root: Path,
    paths: list[str],
    *,
    staged_venv: Path | None = None,
) -> None:
    operations: list[tuple[Path, Path, Path]] = []
    for raw_path in paths:
        relative = safe_relative_path(raw_path)
        operations.append(
            (
                staging_root.joinpath(*relative.parts),
                repo_root.joinpath(*relative.parts),
                backup_root.joinpath(*relative.parts),
            )
        )
    if staged_venv is not None:
        operations.append((staged_venv, repo_root / ".venv", backup_root / ".venv"))
    _apply_switch_operations(operations)


def install_requirements(repo_root: Path, python_executable: Path | None = None) -> None:
    if env_flag("AGENTHUB_WORKER_UPDATE_SKIP_PIP", default=False):
        return
    requirements = repo_root / "workers" / "requirements.txt"
    if not requirements.exists():
        return
    subprocess.run([str(python_executable or sys.executable), "-m", "pip", "install", "-r", str(requirements)], check=True)


def prepare_staged_venv(staging_root: Path, target_venv: Path) -> Path | None:
    if env_flag("AGENTHUB_WORKER_UPDATE_SKIP_PIP", default=False):
        return None
    subprocess.run([sys.executable, "-m", "venv", str(target_venv)], check=True)
    python_name = "python.exe" if os.name == "nt" else "python"
    python_path = target_venv / ("Scripts" if os.name == "nt" else "bin") / python_name
    install_requirements(staging_root, python_path)
    return target_venv


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

    archive_name = validate_archive_name(platform, str(bundle.get("archive") or ""))
    bundle_url = default_bundle_url(platform, manifest_url, archive_name)
    archive_payload = read_url(bundle_url)
    expected_sha = str(bundle.get("sha256") or "").strip().lower()
    if len(expected_sha) != 64 or any(character not in "0123456789abcdef" for character in expected_sha):
        raise RuntimeError(f"Worker manifest is missing a valid sha256 for {platform}")
    actual_sha = sha256_bytes(archive_payload)
    if expected_sha != actual_sha:
        raise RuntimeError(f"Worker bundle sha256 mismatch: expected {expected_sha}, got {actual_sha}")

    paths = [str(path) for path in bundle.get("paths", [])]
    if not paths:
        raise RuntimeError("Worker manifest bundle has no paths")

    if dry_run:
        return f"would update worker bundle from {installed_version or '<none>'} to {bundle_version}"

    repo_root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{repo_root.name}.worker-update-{platform}-",
        dir=repo_root.parent,
    ) as temp_dir:
        temp_root = Path(temp_dir)
        archive_path = temp_root / archive_name
        archive_path.write_bytes(archive_payload)
        bundle_root = extract_archive(platform, archive_path, temp_root / "extract")
        staging_root = temp_root / "staged"
        backup_root = temp_root / "backup"
        stage_bundle_paths(bundle_root, staging_root, paths)
        staged_venv = prepare_staged_venv(staging_root, temp_root / "staged-venv") if platform == "macos" else None
        if platform != "macos":
            install_requirements(staging_root)
        apply_staged_paths_atomically(
            staging_root,
            repo_root,
            backup_root,
            paths,
            staged_venv=staged_venv,
        )

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
