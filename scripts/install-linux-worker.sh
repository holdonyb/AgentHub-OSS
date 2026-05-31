#!/usr/bin/env bash
set -Eeuo pipefail

api_url=""
enrollment_token=""
worker_id="$(hostname)"
connection_mode="private"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_root=""
service_name="${AGENTHUB_LINUX_WORKER_SERVICE:-agenthub-linux-worker.service}"
service_dir="${AGENTHUB_LINUX_WORKER_SERVICE_DIR:-/etc/systemd/system}"
job_poll_seconds="5"
heartbeat_seconds="30"
max_concurrent_jobs="2"
worker_bundle_url=""
worker_manifest_url=""
worker_auto_update="true"
workspace_roots=("/opt/agenthub")
session_roots=()
skip_bootstrap="0"
skip_systemd="0"

usage() {
  cat <<'EOF'
Usage: install-linux-worker.sh --api-url URL --enrollment-token TOKEN [options]

Options:
  --worker-id VALUE
  --connection-mode private|public_relay
  --repo-root PATH
  --install-root PATH
  --workspace-root PATH          repeatable
  --session-root PATH            repeatable
  --job-poll-seconds VALUE
  --heartbeat-seconds VALUE
  --max-concurrent-jobs VALUE
  --worker-bundle-url URL
  --worker-manifest-url URL
  --disable-auto-update
  --service-name VALUE
  --skip-systemd
  --skip-bootstrap
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
    --api-url)
      require_value "$1" "${2:-}"
      api_url="$2"
      shift 2
      ;;
    --enrollment-token)
      require_value "$1" "${2:-}"
      enrollment_token="$2"
      shift 2
      ;;
    --worker-id)
      require_value "$1" "${2:-}"
      worker_id="$2"
      shift 2
      ;;
    --connection-mode)
      require_value "$1" "${2:-}"
      connection_mode="$2"
      shift 2
      ;;
    --repo-root)
      require_value "$1" "${2:-}"
      repo_root="$2"
      shift 2
      ;;
    --install-root)
      require_value "$1" "${2:-}"
      install_root="$2"
      shift 2
      ;;
    --workspace-root)
      require_value "$1" "${2:-}"
      if [[ "${workspace_roots[*]}" == "/opt/agenthub" && ${#workspace_roots[@]} -eq 1 ]]; then
        workspace_roots=()
      fi
      workspace_roots+=("$2")
      shift 2
      ;;
    --session-root)
      require_value "$1" "${2:-}"
      session_roots+=("$2")
      shift 2
      ;;
    --job-poll-seconds)
      require_value "$1" "${2:-}"
      job_poll_seconds="$2"
      shift 2
      ;;
    --heartbeat-seconds)
      require_value "$1" "${2:-}"
      heartbeat_seconds="$2"
      shift 2
      ;;
    --max-concurrent-jobs)
      require_value "$1" "${2:-}"
      max_concurrent_jobs="$2"
      shift 2
      ;;
    --worker-bundle-url)
      require_value "$1" "${2:-}"
      worker_bundle_url="$2"
      shift 2
      ;;
    --worker-manifest-url)
      require_value "$1" "${2:-}"
      worker_manifest_url="$2"
      shift 2
      ;;
    --disable-auto-update)
      worker_auto_update="false"
      shift
      ;;
    --service-name)
      require_value "$1" "${2:-}"
      service_name="$2"
      shift 2
      ;;
    --skip-systemd)
      skip_systemd="1"
      shift
      ;;
    --skip-bootstrap)
      skip_bootstrap="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$api_url" || -z "$enrollment_token" ]]; then
  usage >&2
  exit 1
fi

join_by_colon() {
  local result=""
  local item=""
  for item in "$@"; do
    [[ -n "$item" ]] || continue
    if [[ -n "$result" ]]; then
      result="${result}:"
    fi
    result="${result}${item}"
  done
  printf '%s' "$result"
}

resolve_python_bootstrap() {
  if command -v python3 >/dev/null 2>&1; then
    printf 'python3'
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    printf 'python'
    return 0
  fi
  if command -v py >/dev/null 2>&1; then
    printf 'py -3'
    return 0
  fi
  if command -v uv >/dev/null 2>&1; then
    printf 'uv python'
    return 0
  fi
  echo "Python 3 launcher not found on PATH" >&2
  exit 1
}

copy_bundle_path() {
  local source_root="$1"
  local target_root="$2"
  local relative_path="$3"
  local source_path="$source_root/$relative_path"
  local target_path="$target_root/$relative_path"

  if [[ ! -e "$source_path" ]]; then
    echo "Missing required bundle path: $source_path" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$target_path")"
  if [[ -d "$source_path" ]]; then
    mkdir -p "$target_path"
    cp -a "$source_path"/. "$target_path"/
  else
    cp -f "$source_path" "$target_path"
  fi
}

resolved_source_root="$(cd "$repo_root" && pwd)"
if [[ -z "$install_root" ]]; then
  install_root="$resolved_source_root"
fi
mkdir -p "$install_root"
resolved_repo_root="$(cd "$install_root" && pwd)"

bundle_paths=(
  "packages/protocol/agenthub_protocol"
  "workers/local-linux/agenthub_linux_worker"
  "workers/shared/agenthub_worker"
  "workers/requirements.txt"
  "scripts/install-linux-worker.sh"
  "scripts/update-linux-worker.sh"
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
worker_path="$resolved_repo_root/workers/local-linux/agenthub_linux_worker/main.py"
updater_path="$resolved_repo_root/scripts/update-linux-worker.sh"
env_path="$runtime_root/linux-worker.env"
safe_worker_id="${worker_id//\//_}"
safe_worker_id="${safe_worker_id//\\/_}"
token_path="$runtime_root/${safe_worker_id}.worker-token"
service_path="$service_dir/$service_name"

mkdir -p "$runtime_root"
mkdir -p "$service_dir"
chmod +x "$resolved_repo_root/scripts/install-linux-worker.sh" "$updater_path" 2>/dev/null || true

if [[ ! -x "$python_path" ]]; then
  bootstrap_python="$(resolve_python_bootstrap)"
  # shellcheck disable=SC2086
  $bootstrap_python -m venv "$venv_root"
fi

if [[ ! -x "$python_path" && -x "$venv_root/Scripts/python.exe" ]]; then
  python_path="$venv_root/Scripts/python.exe"
fi

"$python_path" -m pip install -r "$resolved_repo_root/workers/requirements.txt"

workspace_root_value="$(join_by_colon "${workspace_roots[@]}")"
session_root_value="$(join_by_colon "${session_roots[@]}")"

cat >"$env_path" <<EOF
AGENTHUB_API_URL=$api_url
AGENTHUB_CONNECTION_MODE=$connection_mode
AGENTHUB_ENROLLMENT_TOKEN=$enrollment_token
AGENTHUB_WORKER_ID=$worker_id
AGENTHUB_WORKER_JOB_POLL_SECONDS=$job_poll_seconds
AGENTHUB_WORKER_MAX_CONCURRENT_JOBS=$max_concurrent_jobs
AGENTHUB_WORKER_HEARTBEAT_SECONDS=$heartbeat_seconds
AGENTHUB_WORKER_AUTO_UPDATE=$worker_auto_update
AGENTHUB_WORKER_BUNDLE_URL=$worker_bundle_url
AGENTHUB_WORKER_MANIFEST_URL=$worker_manifest_url
AGENTHUB_WORKER_TOKEN_PATH=$token_path
AGENTHUB_WORKSPACE_ROOTS=$workspace_root_value
AGENTHUB_SESSION_ROOTS=$session_root_value
EOF

if [[ "$skip_bootstrap" != "1" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_path"
  set +a
  "$python_path" "$worker_path" --once
fi

cat >"$service_path" <<EOF
[Unit]
Description=AgentHub Linux Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$resolved_repo_root
EnvironmentFile=$env_path
ExecStartPre=$updater_path --repo-root $resolved_repo_root
ExecStart=$python_path $worker_path
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

if [[ "$skip_systemd" != "1" ]]; then
  systemctl daemon-reload
  systemctl enable --now "$service_name"
fi

echo "Worker env written to $env_path"
echo "Installed worker root: $resolved_repo_root"
echo "Rendered systemd service: $service_path"
if [[ "$skip_systemd" != "1" ]]; then
  echo "Registered systemd service: $service_name"
fi
echo "Token cache path: $token_path"
