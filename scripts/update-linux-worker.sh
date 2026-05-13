#!/usr/bin/env bash
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dry_run="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      if [[ -z "${2:-}" ]]; then
        echo "Missing value for --repo-root" >&2
        exit 0
      fi
      repo_root="$2"
      shift 2
      ;;
    --dry-run)
      dry_run="1"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 0
      ;;
  esac
done

repo_root="$(cd "$repo_root" && pwd)"
runtime_root="$repo_root/.runtime"
env_path="$runtime_root/linux-worker.env"
python_path="$repo_root/.venv/bin/python"
updater_path="$repo_root/scripts/worker_self_update.py"
log_path="$runtime_root/agenthub-linux-worker-update.log"

mkdir -p "$runtime_root"

log_update() {
  local message="$1"
  printf '%s %s\n' "$(date -Is)" "$message" >>"$log_path" 2>/dev/null || true
}

if [[ -f "$env_path" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_path"
  set +a
fi

case "${AGENTHUB_WORKER_AUTO_UPDATE:-true}" in
  0|false|FALSE|False|no|NO|No|off|OFF|Off|disabled|DISABLED|Disabled)
    log_update "worker auto-update disabled"
    exit 0
    ;;
esac

if [[ ! -x "$python_path" ]]; then
  log_update "worker auto-update skipped; missing python: $python_path"
  exit 0
fi

if [[ ! -f "$updater_path" ]]; then
  log_update "worker auto-update skipped; missing updater: $updater_path"
  exit 0
fi

args=(--platform linux --repo-root "$repo_root")
if [[ "$dry_run" == "1" ]]; then
  args+=(--dry-run)
fi

if ! "$python_path" "$updater_path" "${args[@]}" >>"$log_path" 2>&1; then
  log_update "worker auto-update failed; worker startup will continue"
fi

exit 0
