#!/usr/bin/env bash
set -Eeuo pipefail

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

join_by_colon() {
  local result=""
  local item=""
  for item in "$@"; do
    [[ -n "$item" ]] || continue
    [[ -z "$result" ]] || result="${result}:"
    result="${result}${item}"
  done
  printf '%s' "$result"
}

write_env() {
  local key="$1"
  local value="$2"
  printf 'export %s=%q\n' "$key" "$value"
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
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
    uv venv "$venv_root" --python 3
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
launch_agent_label="${launch_agent_label:-dev.myagenthub.worker.$safe_worker_id}"
if [[ "$launch_agent_label" == "." || "$launch_agent_label" == ".." || ! "$launch_agent_label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "Invalid --launch-agent-label: $launch_agent_label" >&2
  exit 1
fi
launch_agents_dir="$HOME/Library/LaunchAgents"
logs_dir="$HOME/Library/Logs/AgentHub"
plist_path="$launch_agents_dir/$launch_agent_label.plist"
stable_path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$HOME/.npm-global/bin:${PATH:-}"

resolved_source_root="$(cd "$repo_root" && pwd)"
mkdir -p "$install_root" "$launch_agents_dir" "$logs_dir"
resolved_repo_root="$(cd "$install_root" && pwd)"

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
if [[ "$resolved_source_root" != "$resolved_repo_root" ]]; then
  for relative_path in "${bundle_paths[@]}"; do
    copy_bundle_path "$resolved_source_root" "$resolved_repo_root" "$relative_path"
  done
fi

runtime_root="$resolved_repo_root/.runtime"
venv_root="$resolved_repo_root/.venv"
python_path="$venv_root/bin/python"
worker_path="$resolved_repo_root/workers/local-macos/agenthub_macos_worker/main.py"
start_path="$resolved_repo_root/scripts/start-macos-worker.sh"
env_path="$runtime_root/macos-worker.env"
token_path="$runtime_root/$safe_worker_id.worker-token"
mkdir -p "$runtime_root"
chmod +x "$resolved_repo_root/scripts/"*"macos-worker.sh"

if [[ ! -x "$python_path" ]]; then
  create_virtualenv
fi
"$python_path" -m pip install -r "$resolved_repo_root/workers/requirements.txt"

workspace_root_value="$(join_by_colon "${workspace_roots[@]}")"
session_root_value="$(join_by_colon "${session_roots[@]}")"
{
  write_env AGENTHUB_API_URL "$api_url"
  write_env AGENTHUB_CONNECTION_MODE "$connection_mode"
  write_env AGENTHUB_ENROLLMENT_TOKEN "$enrollment_token"
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
} >"$env_path"
chmod 600 "$env_path"

if [[ "$skip_bootstrap" != "1" ]]; then
  export PATH="$stable_path"
  # shellcheck disable=SC1090
  source "$env_path"
  export PYTHONPATH="$resolved_repo_root/workers/shared:$resolved_repo_root/workers/local-macos:$resolved_repo_root/packages/protocol"
  "$python_path" "$worker_path" --once
fi

escaped_label="$(xml_escape "$launch_agent_label")"
escaped_root="$(xml_escape "$resolved_repo_root")"
escaped_start="$(xml_escape "$start_path")"
escaped_stdout="$(xml_escape "$logs_dir/$safe_worker_id.stdout.log")"
escaped_stderr="$(xml_escape "$logs_dir/$safe_worker_id.stderr.log")"
escaped_path="$(xml_escape "$stable_path")"
cat >"$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$escaped_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$escaped_start</string>
    <string>--repo-root</string>
    <string>$escaped_root</string>
  </array>
  <key>WorkingDirectory</key><string>$escaped_root</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$escaped_path</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$escaped_stdout</string>
  <key>StandardErrorPath</key><string>$escaped_stderr</string>
</dict>
</plist>
EOF

if [[ "$skip_launchctl" != "1" ]]; then
  launch_domain="gui/$(id -u)"
  launchctl bootout "$launch_domain" "$plist_path" >/dev/null 2>&1 || true
  launchctl bootstrap "$launch_domain" "$plist_path"
  launchctl enable "$launch_domain/$launch_agent_label"
  launchctl kickstart -k "$launch_domain/$launch_agent_label"
fi

echo "Installed macOS worker root: $resolved_repo_root"
echo "Rendered LaunchAgent: $plist_path"
echo "Worker logs: $logs_dir"
echo "Token cache path: $token_path"
