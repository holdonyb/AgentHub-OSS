#!/usr/bin/env bash
set -Eeuo pipefail

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

if [[ ! -f "$env_path" ]]; then
  echo "Missing worker environment file: $env_path" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$env_path"
export PATH="${AGENTHUB_WORKER_PATH:-$stable_path}"

case "${AGENTHUB_WORKER_AUTO_UPDATE:-true}" in
  0|false|FALSE|False|no|NO|No|off|OFF|Off|disabled|DISABLED|Disabled)
    ;;
  *)
    if [[ -x "$python_path" && -f "$updater_path" ]]; then
      "$python_path" "$updater_path" --platform macos --repo-root "$repo_root" >>"$update_log" 2>&1 || true
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
exec "$python_path" "${args[@]}"
