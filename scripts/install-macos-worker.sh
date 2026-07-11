#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

api_url=""
enrollment_token=""
worker_id="$(hostname)"
connection_mode="private"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_root=""
launch_agent_label=""
job_poll_seconds="5"
heartbeat_seconds="30"
max_concurrent_jobs="2"
worker_bundle_url=""
worker_manifest_url=""
worker_auto_update="true"
workspace_roots=()
session_roots=()
skip_bootstrap="0"
skip_launchctl="0"

usage() {
  cat <<'EOF'
Usage: install-macos-worker.sh --api-url URL --enrollment-token TOKEN --workspace-root PATH [options]

Options:
  --worker-id VALUE
  --connection-mode private|public_relay
  --repo-root PATH
  --install-root PATH
  --workspace-root PATH          repeatable, at least one required
  --session-root PATH            repeatable
  --job-poll-seconds VALUE
  --heartbeat-seconds VALUE
  --max-concurrent-jobs VALUE
  --worker-bundle-url URL
  --worker-manifest-url URL
  --launch-agent-label VALUE
  --disable-auto-update
  --skip-bootstrap
  --skip-launchctl
EOF
}

require_value() {
  local key="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "Missing value for $key" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) require_value "$1" "${2:-}"; api_url="$2"; shift 2 ;;
    --enrollment-token) require_value "$1" "${2:-}"; enrollment_token="$2"; shift 2 ;;
    --worker-id) require_value "$1" "${2:-}"; worker_id="$2"; shift 2 ;;
    --connection-mode) require_value "$1" "${2:-}"; connection_mode="$2"; shift 2 ;;
    --repo-root) require_value "$1" "${2:-}"; repo_root="$2"; shift 2 ;;
    --install-root) require_value "$1" "${2:-}"; install_root="$2"; shift 2 ;;
    --workspace-root) require_value "$1" "${2:-}"; workspace_roots+=("$2"); shift 2 ;;
    --session-root) require_value "$1" "${2:-}"; session_roots+=("$2"); shift 2 ;;
    --job-poll-seconds) require_value "$1" "${2:-}"; job_poll_seconds="$2"; shift 2 ;;
    --heartbeat-seconds) require_value "$1" "${2:-}"; heartbeat_seconds="$2"; shift 2 ;;
    --max-concurrent-jobs) require_value "$1" "${2:-}"; max_concurrent_jobs="$2"; shift 2 ;;
    --worker-bundle-url) require_value "$1" "${2:-}"; worker_bundle_url="$2"; shift 2 ;;
    --worker-manifest-url) require_value "$1" "${2:-}"; worker_manifest_url="$2"; shift 2 ;;
    --launch-agent-label) require_value "$1" "${2:-}"; launch_agent_label="$2"; shift 2 ;;
    --disable-auto-update) worker_auto_update="false"; shift ;;
    --skip-bootstrap) skip_bootstrap="1"; shift ;;
    --skip-launchctl) skip_launchctl="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -z "$api_url" || -z "$enrollment_token" ]]; then
  usage >&2
  exit 1
fi
if [[ ${#workspace_roots[@]} -eq 0 ]]; then
  echo "At least one --workspace-root is required" >&2
  exit 1
fi

join_by_pathsep() {
  local result=""
  local item=""
  for item in "$@"; do
    [[ -n "$item" ]] || continue
    [[ -z "$result" ]] || result="${result}:"
    result="${result}${item}"
  done
  printf '%s' "$result"
}

normalize_existing_root() {
  local label="$1"
  local value="$2"
  case "$value" in
    /*) ;;
    *) echo "$label must be an absolute path: $value" >&2; exit 1 ;;
  esac
  if [[ ! -d "$value" ]]; then
    echo "$label does not exist or is not a directory: $value" >&2
    exit 1
  fi
  (cd -- "$value" && pwd -P)
}

write_env() {
  local key="$1"
  local value="$2"
  printf 'export %s=%q\n' "$key" "$value"
}

copy_bundle_path() {
  local source_root="$1"
  local target_root="$2"
  local relative_path="$3"
  local source_path="$source_root/$relative_path"
  local target_path="$target_root/$relative_path"
  [[ -e "$source_path" ]] || { echo "Missing required bundle path: $source_path" >&2; exit 1; }
  mkdir -p "$(dirname "$target_path")"
  if [[ -d "$source_path" ]]; then
    mkdir -p "$target_path"
    cp -a "$source_path"/. "$target_path"/
  else
    cp -f "$source_path" "$target_path"
  fi
}

create_virtualenv() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -m venv "$venv_root"
  elif command -v python >/dev/null 2>&1; then
    python -m venv "$venv_root"
  elif command -v uv >/dev/null 2>&1; then
    uv venv "$venv_root" --python 3 --seed
  else
    echo "Python 3 or uv is required to install the macOS worker" >&2
    exit 1
  fi
}

safe_worker_id="$(printf '%s' "$worker_id" | tr -c 'A-Za-z0-9._-' '_')"
if [[ -z "$safe_worker_id" || "$safe_worker_id" == "." || "$safe_worker_id" == ".." ]]; then
  safe_worker_id="worker"
fi
install_root="${install_root:-$HOME/Library/Application Support/AgentHub/workers/$safe_worker_id}"
case "$install_root" in
  /*) ;;
  *) echo "--install-root must be an absolute path: $install_root" >&2; exit 1 ;;
esac
launch_agent_label="${launch_agent_label:-dev.myagenthub.worker.$safe_worker_id}"
if [[ "$launch_agent_label" == "." || "$launch_agent_label" == ".." || ! "$launch_agent_label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "Invalid --launch-agent-label: $launch_agent_label" >&2
  exit 1
fi
launch_agents_dir="$HOME/Library/LaunchAgents"
logs_dir="$HOME/Library/Logs/AgentHub"
plist_path="$launch_agents_dir/$launch_agent_label.plist"
stable_path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$HOME/.npm-global/bin:${PATH:-}"
launch_domain="gui/$(id -u)"

launch_agent_loaded() {
  launchctl print "$launch_domain/$launch_agent_label" >/dev/null 2>&1
}

stop_launch_agent() {
  if ! launch_agent_loaded; then
    return 0
  fi
  launchctl bootout "$launch_domain/$launch_agent_label"
  local attempt
  for attempt in {1..50}; do
    if ! launch_agent_loaded; then
      return 0
    fi
    sleep 0.1
  done
  echo "LaunchAgent did not stop: $launch_agent_label" >&2
  exit 1
}

normalized_workspace_roots=()
for root in "${workspace_roots[@]}"; do
  normalized_workspace_roots+=("$(normalize_existing_root "Workspace root" "$root")")
done
workspace_roots=("${normalized_workspace_roots[@]}")
normalized_session_roots=()
for root in "${session_roots[@]}"; do
  normalized_session_roots+=("$(normalize_existing_root "Session root" "$root")")
done
session_roots=("${normalized_session_roots[@]}")

bundle_paths=(
  "packages/protocol/agenthub_protocol"
  "workers/local-macos/agenthub_macos_worker"
  "workers/shared/agenthub_worker"
  "workers/requirements.txt"
  "scripts/install-macos-worker.sh"
  "scripts/uninstall-macos-worker.sh"
  "scripts/start-macos-worker.sh"
  "scripts/worker_self_update.py"
)
resolved_source_root="$(cd "$repo_root" && pwd -P)"
install_parent="$(dirname "$install_root")"
install_name="$(basename "$install_root")"
mkdir -p "$install_parent" "$launch_agents_dir" "$logs_dir"
resolved_install_parent="$(cd "$install_parent" && pwd -P)"
resolved_repo_root="$resolved_install_parent/$install_name"
staging_root="$(mktemp -d "$resolved_install_parent/.${install_name}.staging.XXXXXX")"
backup_root="$(mktemp -d "$resolved_install_parent/.${install_name}.backup.XXXXXX")"
switch_state_path="$backup_root/switch-state.json"
install_complete="0"
rollback_in_progress="0"
service_was_loaded="0"

cleanup_install_artifacts() {
  rm -rf -- "$staging_root" "$backup_root"
}
trap cleanup_install_artifacts EXIT

for relative_path in "${bundle_paths[@]}"; do
  copy_bundle_path "$resolved_source_root" "$staging_root" "$relative_path"
done

venv_root="$staging_root/.venv"
python_path="$venv_root/bin/python"
create_virtualenv
"$python_path" -m pip install -r "$staging_root/workers/requirements.txt"

if [[ "$skip_launchctl" != "1" ]] && launch_agent_loaded; then
  service_was_loaded="1"
fi
runtime_root="$resolved_repo_root/.runtime"
env_path="$runtime_root/macos-worker.env"
token_path="$runtime_root/$safe_worker_id.worker-token"
if [[ -f "$env_path" ]]; then
  cp -p -- "$env_path" "$backup_root/macos-worker.env"
fi
if [[ -f "$plist_path" ]]; then
  cp -p -- "$plist_path" "$backup_root/launch-agent.plist"
fi

rollback_install() {
  local status="${1:-1}"
  if [[ "$install_complete" == "1" || "$rollback_in_progress" == "1" ]]; then
    exit "$status"
  fi
  rollback_in_progress="1"
  trap - ERR
  set +e
  if [[ "$skip_launchctl" != "1" ]] && launch_agent_loaded; then
    launchctl bootout "$launch_domain/$launch_agent_label" >/dev/null 2>&1
    for attempt in {1..50}; do
      launch_agent_loaded || break
      sleep 0.1
    done
  fi
  local restore_python=""
  if [[ -x "$resolved_repo_root/.venv/bin/python" ]]; then
    restore_python="$resolved_repo_root/.venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    restore_python="$(command -v python3)"
  fi
  if [[ -n "$restore_python" && -f "$switch_state_path" ]]; then
    "$restore_python" - "$resolved_repo_root" "$backup_root" "$switch_state_path" <<'PY'
import json
import os
import shutil
import sys
from pathlib import Path

repo_root = Path(sys.argv[1])
backup_root = Path(sys.argv[2])
state = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
for item in reversed(state):
    relative = Path(item["path"])
    target = repo_root / relative
    backup = backup_root / relative
    if target.is_dir() and not target.is_symlink():
        shutil.rmtree(target)
    else:
        target.unlink(missing_ok=True)
    if item["had_original"] and (backup.exists() or backup.is_symlink()):
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(backup, target)
PY
  fi
  if [[ -f "$backup_root/macos-worker.env" ]]; then
    cp -p -- "$backup_root/macos-worker.env" "$env_path"
  else
    rm -f -- "$env_path"
  fi
  if [[ -f "$backup_root/launch-agent.plist" ]]; then
    cp -p -- "$backup_root/launch-agent.plist" "$plist_path"
  else
    rm -f -- "$plist_path"
  fi
  if [[ "$service_was_loaded" == "1" && -f "$plist_path" ]]; then
    launchctl bootstrap "$launch_domain" "$plist_path" >/dev/null 2>&1
    launchctl kickstart -k "$launch_domain/$launch_agent_label" >/dev/null 2>&1
  fi
  exit "$status"
}
trap 'rollback_install $?' ERR

if [[ "$skip_launchctl" != "1" ]]; then
  stop_launch_agent
fi
mkdir -p "$runtime_root"

"$python_path" - "$staging_root" "$resolved_repo_root" "$backup_root" "$switch_state_path" "${bundle_paths[@]}" <<'PY'
import json
import os
import shutil
import sys
from pathlib import Path

staging_root = Path(sys.argv[1])
repo_root = Path(sys.argv[2])
backup_root = Path(sys.argv[3])
state_path = Path(sys.argv[4])
paths = [Path(value) for value in sys.argv[5:]] + [Path(".venv")]
state = []

def remove(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)

try:
    for relative in paths:
        staged = staging_root / relative
        target = repo_root / relative
        backup = backup_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        backup.parent.mkdir(parents=True, exist_ok=True)
        had_original = target.exists() or target.is_symlink()
        if had_original:
            os.replace(target, backup)
        try:
            os.replace(staged, target)
        except BaseException:
            if had_original and (backup.exists() or backup.is_symlink()):
                os.replace(backup, target)
            raise
        state.append({"path": relative.as_posix(), "had_original": had_original})
    state_path.write_text(json.dumps(state), encoding="utf-8")
except BaseException:
    for item in reversed(state):
        relative = Path(item["path"])
        target = repo_root / relative
        backup = backup_root / relative
        remove(target)
        if item["had_original"] and (backup.exists() or backup.is_symlink()):
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(backup, target)
    raise
PY

venv_root="$resolved_repo_root/.venv"
python_path="$venv_root/bin/python"
worker_path="$resolved_repo_root/workers/local-macos/agenthub_macos_worker/main.py"
start_path="$resolved_repo_root/scripts/start-macos-worker.sh"
chmod +x "$resolved_repo_root/scripts/"*"macos-worker.sh"

workspace_root_value="$(join_by_pathsep "${workspace_roots[@]}")"
session_root_value="$(join_by_pathsep "${session_roots[@]}")"
env_temp_path="$runtime_root/.macos-worker.env.$$"
{
  write_env AGENTHUB_API_URL "$api_url"
  write_env AGENTHUB_CONNECTION_MODE "$connection_mode"
  write_env AGENTHUB_WORKER_ID "$worker_id"
  write_env AGENTHUB_WORKER_JOB_POLL_SECONDS "$job_poll_seconds"
  write_env AGENTHUB_WORKER_MAX_CONCURRENT_JOBS "$max_concurrent_jobs"
  write_env AGENTHUB_WORKER_HEARTBEAT_SECONDS "$heartbeat_seconds"
  write_env AGENTHUB_WORKER_AUTO_UPDATE "$worker_auto_update"
  write_env AGENTHUB_WORKER_BUNDLE_URL "$worker_bundle_url"
  write_env AGENTHUB_WORKER_MANIFEST_URL "$worker_manifest_url"
  write_env AGENTHUB_WORKER_TOKEN_PATH "$token_path"
  write_env AGENTHUB_WORKER_PATH "$stable_path"
  write_env AGENTHUB_WORKSPACE_ROOTS "$workspace_root_value"
  write_env AGENTHUB_SESSION_ROOTS "$session_root_value"
} >"$env_temp_path"
chmod 600 "$env_temp_path"
mv -f -- "$env_temp_path" "$env_path"
chmod 600 "$env_path"

if [[ "$skip_bootstrap" != "1" ]]; then
  export PATH="$stable_path"
  # shellcheck disable=SC1090
  source "$env_path"
  export PYTHONPATH="$resolved_repo_root/workers/shared:$resolved_repo_root/workers/local-macos:$resolved_repo_root/packages/protocol"
  "$python_path" "$worker_path" --enrollment-token "$enrollment_token" --bootstrap-only
fi

"$python_path" - "$plist_path" "$launch_agent_label" "$start_path" "$resolved_repo_root" "$stable_path" "$logs_dir/$safe_worker_id.stdout.log" "$logs_dir/$safe_worker_id.stderr.log" <<'PY'
import os
import plistlib
import sys
from pathlib import Path

plist_path, label, start_path, repo_root, stable_path, stdout_path, stderr_path = sys.argv[1:]
payload = {
    "Label": label,
    "ProgramArguments": [start_path, "--repo-root", repo_root],
    "WorkingDirectory": repo_root,
    "EnvironmentVariables": {"PATH": stable_path},
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "ProcessType": "Background",
    "StandardOutPath": stdout_path,
    "StandardErrorPath": stderr_path,
}
target = Path(plist_path)
temporary = target.with_name(f".{target.name}.{os.getpid()}")
with temporary.open("wb") as handle:
    plistlib.dump(payload, handle, fmt=plistlib.FMT_XML, sort_keys=False)
os.chmod(temporary, 0o600)
os.replace(temporary, target)
PY
chmod 600 "$plist_path"

if [[ "$skip_launchctl" != "1" ]]; then
  launchctl bootstrap "$launch_domain" "$plist_path"
  launchctl enable "$launch_domain/$launch_agent_label"
  launchctl kickstart -k "$launch_domain/$launch_agent_label"
fi

install_complete="1"
trap - ERR

echo "Installed macOS worker root: $resolved_repo_root"
echo "Rendered LaunchAgent: $plist_path"
echo "Worker logs: $logs_dir"
echo "Token cache path: $token_path"
