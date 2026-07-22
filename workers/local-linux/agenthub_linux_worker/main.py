from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
os.environ.setdefault("AGENTHUB_DISCOVERY_RUNTIME_DIR", str(REPO_ROOT / ".runtime"))
for extra_path in (
    REPO_ROOT / "workers" / "shared",
    REPO_ROOT / "workers" / "local-linux",
    REPO_ROOT / "packages" / "protocol",
):
    extra_path_str = str(extra_path)
    if extra_path_str not in sys.path:
        sys.path.insert(0, extra_path_str)

from agenthub_linux_worker.discovery import discover_capabilities, discover_sessions
from agenthub_worker.client import AgentHubClient
from agenthub_worker.codex_maintenance import promote_exec_sessions_for_desktop
from agenthub_worker.discovery import mark_session_publications, rebuild_recent_session_index
from agenthub_worker.paths import default_agent_session_roots
from agenthub_worker.runtime import WorkerRuntime, run_forever


def _dedupe_roots(values: list[Path]) -> list[Path]:
    roots: list[Path] = []
    seen: set[str] = set()
    for value in values:
        key = str(value).replace("\\", "/").rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        roots.append(value)
    return roots


def _workspace_roots(values: list[str] | None) -> list[Path]:
    if values:
        return _dedupe_roots([Path(value) for value in values])
    env_value = os.getenv("AGENTHUB_WORKSPACE_ROOTS", "")
    roots = [Path("/opt/agenthub")]
    if env_value:
        roots.extend(Path(value) for value in env_value.split(os.pathsep) if value)
    return _dedupe_roots(roots)


def _session_roots() -> list[Path]:
    env_value = os.getenv("AGENTHUB_SESSION_ROOTS", "")
    roots: list[Path] = []
    if env_value:
        roots.extend(Path(value) for value in env_value.split(os.pathsep) if value)
    roots.extend(default_agent_session_roots())
    return _dedupe_roots(roots)


def _default_worker_token_path(worker_id: str) -> Path:
    safe_worker_id = worker_id.replace("/", "_")
    return REPO_ROOT / ".runtime" / f"{safe_worker_id}.worker-token"


def _worker_token_path(worker_id: str, explicit_path: str | None) -> Path:
    configured = (explicit_path or "").strip() or os.getenv("AGENTHUB_WORKER_TOKEN_PATH", "").strip()
    return Path(configured) if configured else _default_worker_token_path(worker_id)


def _argv_has_flag(flag: str) -> bool:
    return flag in sys.argv[1:]


def _load_worker_token(path: Path) -> str | None:
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


def _persist_worker_token(path: Path, token: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{token.strip()}\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _generate_worker_token() -> str:
    return f"ahw_{secrets.token_hex(24)}"


def _run_maintenance(args: argparse.Namespace) -> int:
    if args.maintenance_command == "rebuild-discovery-index":
        print(json.dumps(rebuild_recent_session_index(_session_roots()), ensure_ascii=False, indent=2))
        return 0
    if args.maintenance_command != "promote-codex-exec":
        raise SystemExit(f"Unsupported maintenance command: {args.maintenance_command}")
    result = promote_exec_sessions_for_desktop(
        target_cwd=args.target_cwd or "",
        codex_home=args.codex_home,
        source_cwd_prefix=args.source_cwd_prefix,
        thread_ids=args.thread_id,
        all_exec=args.all_exec,
        dry_run=args.dry_run,
    )
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="AgentHub Linux worker")
    parser.add_argument("--api-url", default=os.getenv("AGENTHUB_API_URL", "http://127.0.0.1:43080"))
    parser.add_argument("--connection-mode", default=os.getenv("AGENTHUB_CONNECTION_MODE", "private"))
    parser.add_argument("--worker-id", default=os.getenv("AGENTHUB_WORKER_ID", socket.gethostname()))
    parser.add_argument("--worker-token")
    parser.add_argument("--worker-token-path")
    parser.add_argument("--worker-registration-token", default=os.getenv("AGENTHUB_WORKER_REGISTRATION_TOKEN"))
    parser.add_argument("--enrollment-token", default=os.getenv("AGENTHUB_ENROLLMENT_TOKEN"))
    parser.add_argument("--workspace-root", action="append", dest="workspace_roots")
    parser.add_argument("--interval-seconds", type=int, default=int(os.getenv("AGENTHUB_WORKER_INTERVAL_SECONDS", "30")))
    parser.add_argument(
        "--max-concurrent-jobs",
        type=int,
        default=int(os.getenv("AGENTHUB_WORKER_MAX_CONCURRENT_JOBS", "2")),
    )
    parser.add_argument(
        "--job-poll-interval-seconds",
        type=float,
        default=float(os.getenv("AGENTHUB_WORKER_JOB_POLL_SECONDS", "5")),
    )
    parser.add_argument(
        "--heartbeat-interval-seconds",
        type=float,
        default=float(os.getenv("AGENTHUB_WORKER_HEARTBEAT_SECONDS", "30")),
    )
    parser.add_argument("--maintenance-command")
    parser.add_argument("--target-cwd")
    parser.add_argument("--source-cwd-prefix")
    parser.add_argument("--thread-id", action="append")
    parser.add_argument("--codex-home")
    parser.add_argument("--all-exec", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if args.maintenance_command:
        raise SystemExit(_run_maintenance(args))
    workspace_roots = _workspace_roots(args.workspace_roots)
    capabilities = discover_capabilities()
    reachable_backends = [name for name, available in capabilities.items() if available]
    worker_token_path_arg = args.worker_token_path if _argv_has_flag("--worker-token-path") else None
    token_path = _worker_token_path(args.worker_id, worker_token_path_arg)
    cli_worker_token = args.worker_token if _argv_has_flag("--worker-token") else None
    env_worker_token = os.getenv("AGENTHUB_WORKER_TOKEN", "").strip() or None
    # Cached or explicit tokens must win before any inherited process-level token.
    worker_token = cli_worker_token or _load_worker_token(token_path)
    if not worker_token and not (args.enrollment_token or args.worker_registration_token):
        worker_token = env_worker_token
    if not worker_token:
        bootstrap_client = AgentHubClient(args.api_url, args.worker_id, "", mode=args.connection_mode)
        bootstrap_token = _generate_worker_token()
        registration_payload = {
            "worker_id": args.worker_id,
            "machine_name": socket.gethostname(),
            "os": "linux",
            "connection_mode": args.connection_mode,
            "transport_state": "polling",
            "reachable_backends": reachable_backends,
            "workspace_roots": [str(root).replace("\\", "/") for root in workspace_roots],
            "capabilities": capabilities,
            "worker_token": bootstrap_token,
        }
        if args.enrollment_token:
            registration_payload["enrollment_token"] = args.enrollment_token
            enrolled = bootstrap_client.enroll(registration_payload)
            worker_token = enrolled.get("worker_token") or bootstrap_token
        elif args.connection_mode == "public_relay":
            raise SystemExit("AGENTHUB_ENROLLMENT_TOKEN is required for public relay enrollment")
        else:
            if not args.worker_registration_token:
                raise SystemExit("AGENTHUB_WORKER_REGISTRATION_TOKEN is required for private registration")
            registered = bootstrap_client.register(registration_payload, args.worker_registration_token)
            worker_token = registered.get("worker_token") or bootstrap_token
        _persist_worker_token(token_path, worker_token)
    if not worker_token:
        raise SystemExit("AGENTHUB_WORKER_TOKEN is required after registration or enrollment")
    os.environ["AGENTHUB_DISCOVERY_PUBLICATION_SCOPE"] = (
        f"{args.connection_mode}|{args.api_url.rstrip('/')}|{args.worker_id}"
    )
    client = AgentHubClient(args.api_url, args.worker_id, worker_token, mode=args.connection_mode)
    def discover_worker_sessions(search_roots: list[Path]) -> list[dict]:
        return discover_sessions(search_roots, opencode_roots=workspace_roots)

    runtime = WorkerRuntime(
        client=client,
        worker_id=args.worker_id,
        workspace_roots=workspace_roots,
        session_roots=_session_roots(),
        discover_capabilities=discover_capabilities,
        discover_sessions=discover_worker_sessions,
        mark_sessions_published=mark_session_publications,
        background_jobs=not args.once,
        max_concurrent_jobs=args.max_concurrent_jobs,
        job_poll_interval_seconds=args.job_poll_interval_seconds,
        heartbeat_interval_seconds=args.heartbeat_interval_seconds,
    )
    if args.once:
        runtime.run_once()
        runtime.shutdown(wait=True)
    else:
        run_forever(runtime, args.interval_seconds)


if __name__ == "__main__":
    main()
