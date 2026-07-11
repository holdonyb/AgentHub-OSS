#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
once="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      [[ -n "${2:-}" ]] || { echo "Missing value for --repo-root" >&2; exit 1; }
      repo_root="$2"
      shift 2
      ;;
    --once)
      once="1"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

repo_root="$(cd "$repo_root" && pwd)"
runtime_root="$repo_root/.runtime"
env_path="$runtime_root/macos-worker.env"
python_path="$repo_root/.venv/bin/python"
worker_path="$repo_root/workers/local-macos/agenthub_macos_worker/main.py"
updater_path="$repo_root/scripts/worker_self_update.py"
update_log="$runtime_root/agenthub-macos-worker-update.log"
stable_path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$HOME/.npm-global/bin"

export PATH="$stable_path"
mkdir -p "$runtime_root"
lock_dir="$runtime_root/macos-worker.instance.lock"
worker_pid=""

release_lock() {
  rm -f -- "$lock_dir/pid"
  rmdir "$lock_dir" >/dev/null 2>&1 || true
}

acquire_lock() {
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$lock_dir/pid"
    trap release_lock EXIT
    return 0
  fi
  local owner_pid=""
  if [[ -f "$lock_dir/pid" ]]; then
    owner_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
  fi
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    echo "AgentHub macOS worker is already running (pid $owner_pid)" >&2
    exit 0
  fi
  rm -f -- "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || { echo "Cannot recover stale worker lock: $lock_dir" >&2; exit 1; }
  mkdir "$lock_dir"
  printf '%s\n' "$$" >"$lock_dir/pid"
  trap release_lock EXIT
}

acquire_lock

forward_signal() {
  local signal="$1"
  local exit_code="$2"
  if [[ "$worker_pid" =~ ^[0-9]+$ ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill -s "$signal" "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  exit "$exit_code"
}

trap 'forward_signal TERM 143' TERM
trap 'forward_signal INT 130' INT
trap 'forward_signal HUP 129' HUP

if [[ ! -f "$env_path" ]]; then
  echo "Missing worker environment file: $env_path" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$env_path"
unset AGENTHUB_ENROLLMENT_TOKEN
export PATH="${AGENTHUB_WORKER_PATH:-$stable_path}"

case "${AGENTHUB_WORKER_AUTO_UPDATE:-true}" in
  0|false|FALSE|False|no|NO|No|off|OFF|Off|disabled|DISABLED|Disabled)
    ;;
  *)
    if [[ -x "$python_path" && -f "$updater_path" ]]; then
      if ! "$python_path" "$updater_path" --platform macos --repo-root "$repo_root" >>"$update_log" 2>&1; then
        echo "Worker update failed; refusing to start a potentially mixed version. See $update_log" >&2
        exit 1
      fi
    fi
    ;;
esac

if [[ ! -x "$python_path" ]]; then
  echo "Missing worker Python runtime: $python_path" >&2
  exit 1
fi
if [[ ! -f "$worker_path" ]]; then
  echo "Missing macOS worker entrypoint: $worker_path" >&2
  exit 1
fi

export PYTHONPATH="$repo_root/workers/shared:$repo_root/workers/local-macos:$repo_root/packages/protocol"
args=("$worker_path")
if [[ "$once" == "1" ]]; then
  args+=(--once)
fi
"$python_path" "${args[@]}" &
worker_pid="$!"
if wait "$worker_pid"; then
  worker_status=0
else
  worker_status="$?"
fi
worker_pid=""
exit "$worker_status"
