#!/usr/bin/env bash
set -Eeuo pipefail

host=""
ssh_user="root"
ssh_key=""
ssh_port="22"
domain=""
base_url=""
repo_url="https://github.com/your-org/AgentHub.git"
branch="main"
install_root="/opt/agenthub-smoke"
admin_email=""
mode="public_relay"
skip_certbot="0"
skip_packages="0"
run_worker_smoke="0"
confirm=""
allow_production_domain="0"

usage() {
  cat <<'EOF'
Usage: smoke-selfhost-vm.sh --host HOST --domain DOMAIN --ssh-key KEY --confirm SELFHOST_SMOKE_OK [options]

Run a repeatable self-host smoke test on an explicitly supplied Ubuntu VM.
Use a disposable VM or a dedicated smoke domain. The script refuses known production domains by default.

Options:
  --host HOST                SSH host or IP of the smoke VM
  --ssh-user USER            SSH user, default root
  --ssh-key PATH             SSH private key path
  --ssh-port PORT            SSH port, default 22
  --domain DOMAIN            Domain or Tailscale DNS name served by the smoke VM
  --base-url URL             External URL, default https://DOMAIN
  --repo-url URL             Git repository URL, default https://github.com/your-org/AgentHub.git
  --branch BRANCH            Branch/ref to install, default main
  --install-root PATH        Remote install root, default /opt/agenthub-smoke
  --admin-email EMAIL        Email for Let's Encrypt when certbot is enabled
  --mode MODE                public_relay or tailscale_private, default public_relay
  --skip-certbot             Use temporary self-signed cert and curl -k checks
  --skip-packages            Skip apt/package installation on the remote VM
  --run-worker-smoke         Also run scripts/smoke-worker-onboarding.sh with AGENTHUB_SMOKE_ADMIN_TOKEN
  --allow-production-domain  Allow a protected domain such as agenthub.example.com; intended only for explicit emergency checks
  --confirm VALUE            Must be SELFHOST_SMOKE_OK
  -h, --help                 Show this help

Environment:
  AGENTHUB_SMOKE_ADMIN_TOKEN Optional PAT used when --run-worker-smoke is set.
EOF
}

log() {
  printf '[agenthub-selfhost-vm-smoke] %s\n' "$*"
}

fail() {
  printf '[agenthub-selfhost-vm-smoke] ERROR: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local key="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    fail "Missing value for $key"
  fi
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required tool: $1"
}

shell_quote() {
  printf '%q' "$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      require_value "$1" "${2:-}"
      host="$2"
      shift 2
      ;;
    --ssh-user)
      require_value "$1" "${2:-}"
      ssh_user="$2"
      shift 2
      ;;
    --ssh-key)
      require_value "$1" "${2:-}"
      ssh_key="$2"
      shift 2
      ;;
    --ssh-port)
      require_value "$1" "${2:-}"
      ssh_port="$2"
      shift 2
      ;;
    --domain)
      require_value "$1" "${2:-}"
      domain="$2"
      shift 2
      ;;
    --base-url)
      require_value "$1" "${2:-}"
      base_url="$2"
      shift 2
      ;;
    --repo-url)
      require_value "$1" "${2:-}"
      repo_url="$2"
      shift 2
      ;;
    --branch)
      require_value "$1" "${2:-}"
      branch="$2"
      shift 2
      ;;
    --install-root)
      require_value "$1" "${2:-}"
      install_root="$2"
      shift 2
      ;;
    --admin-email)
      require_value "$1" "${2:-}"
      admin_email="$2"
      shift 2
      ;;
    --mode)
      require_value "$1" "${2:-}"
      mode="$2"
      shift 2
      ;;
    --skip-certbot)
      skip_certbot="1"
      shift
      ;;
    --skip-packages)
      skip_packages="1"
      shift
      ;;
    --run-worker-smoke)
      run_worker_smoke="1"
      shift
      ;;
    --allow-production-domain)
      allow_production_domain="1"
      shift
      ;;
    --confirm)
      require_value "$1" "${2:-}"
      confirm="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$host" ]] || {
  usage
  fail "--host is required"
}
[[ -n "$domain" ]] || {
  usage
  fail "--domain is required"
}
[[ -n "$ssh_key" ]] || {
  usage
  fail "--ssh-key is required"
}
[[ "$confirm" == "SELFHOST_SMOKE_OK" ]] || fail "--confirm SELFHOST_SMOKE_OK is required"
[[ "$mode" == "public_relay" || "$mode" == "tailscale_private" ]] || fail "--mode must be public_relay or tailscale_private"
[[ -f "$ssh_key" ]] || fail "SSH key does not exist: $ssh_key"

if [[ -z "$base_url" ]]; then
  base_url="https://$domain"
fi

if [[ "$allow_production_domain" != "1" && "$domain" == "agenthub.example.com" ]]; then
  fail "Refusing to run self-host smoke against protected domain agenthub.example.com"
fi

if [[ "$install_root" == "/opt/agenthub" ]]; then
  fail "Refusing install root /opt/agenthub for smoke; use /opt/agenthub-smoke or a disposable VM"
fi

if [[ "$skip_certbot" != "1" && -z "$admin_email" ]]; then
  fail "--admin-email is required unless --skip-certbot is set"
fi

if [[ "$run_worker_smoke" == "1" && -z "${AGENTHUB_SMOKE_ADMIN_TOKEN:-}" ]]; then
  fail "--run-worker-smoke requires AGENTHUB_SMOKE_ADMIN_TOKEN"
fi

require_tool ssh

ssh_args=(-i "$ssh_key" -p "$ssh_port" -o StrictHostKeyChecking=accept-new)
remote_src="/tmp/agenthub-selfhost-smoke-src"

remote_env=(
  "AGENTHUB_SMOKE_REPO=$(shell_quote "$repo_url")"
  "AGENTHUB_SMOKE_BRANCH=$(shell_quote "$branch")"
  "AGENTHUB_SMOKE_DOMAIN=$(shell_quote "$domain")"
  "AGENTHUB_SMOKE_BASE_URL=$(shell_quote "$base_url")"
  "AGENTHUB_SMOKE_INSTALL_ROOT=$(shell_quote "$install_root")"
  "AGENTHUB_SMOKE_ADMIN_EMAIL=$(shell_quote "$admin_email")"
  "AGENTHUB_SMOKE_MODE=$(shell_quote "$mode")"
  "AGENTHUB_SMOKE_SKIP_CERTBOT=$(shell_quote "$skip_certbot")"
  "AGENTHUB_SMOKE_SKIP_PACKAGES=$(shell_quote "$skip_packages")"
  "AGENTHUB_SMOKE_REMOTE_SRC=$(shell_quote "$remote_src")"
)

log "installing $branch on $host for $base_url"
ssh "${ssh_args[@]}" "$ssh_user@$host" "${remote_env[*]} bash -s" <<'REMOTE'
set -Eeuo pipefail

log() {
  printf '[agenthub-selfhost-remote] %s\n' "$*"
}

install_args=(
  --domain "$AGENTHUB_SMOKE_DOMAIN"
  --public-base-url "$AGENTHUB_SMOKE_BASE_URL"
  --install-root "$AGENTHUB_SMOKE_INSTALL_ROOT"
  --source-root "$AGENTHUB_SMOKE_REMOTE_SRC"
)

if [[ "$AGENTHUB_SMOKE_SKIP_PACKAGES" == "1" ]]; then
  install_args+=(--skip-packages)
else
  apt-get update
  apt-get install -y git curl ca-certificates
fi

if [[ "$AGENTHUB_SMOKE_SKIP_CERTBOT" == "1" || "$AGENTHUB_SMOKE_MODE" == "tailscale_private" ]]; then
  install_args+=(--skip-certbot)
else
  install_args+=(--admin-email "$AGENTHUB_SMOKE_ADMIN_EMAIL")
fi

if [[ -d "$AGENTHUB_SMOKE_REMOTE_SRC/.git" ]]; then
  log "updating source checkout"
  git -C "$AGENTHUB_SMOKE_REMOTE_SRC" fetch origin "$AGENTHUB_SMOKE_BRANCH"
else
  log "cloning source checkout"
  rm -rf "$AGENTHUB_SMOKE_REMOTE_SRC"
  git clone "$AGENTHUB_SMOKE_REPO" "$AGENTHUB_SMOKE_REMOTE_SRC"
  git -C "$AGENTHUB_SMOKE_REMOTE_SRC" fetch origin "$AGENTHUB_SMOKE_BRANCH"
fi
git -C "$AGENTHUB_SMOKE_REMOTE_SRC" checkout -B agenthub-selfhost-smoke FETCH_HEAD

log "running installer"
bash "$AGENTHUB_SMOKE_REMOTE_SRC/scripts/install-selfhost-linux.sh" "${install_args[@]}"

log "checking services"
systemctl is-active --quiet agenthub-api.service
nginx -t
if [[ "$AGENTHUB_SMOKE_SKIP_CERTBOT" != "1" && "$AGENTHUB_SMOKE_MODE" != "tailscale_private" ]]; then
  systemctl list-timers --all | grep -q 'certbot'
fi
REMOTE

check_args=(--base-url "$base_url" --expect-worker-bundles --json)
if [[ "$mode" == "public_relay" ]]; then
  check_args+=(--expect-public-relay)
fi
if [[ "$skip_certbot" == "1" || "$mode" == "tailscale_private" ]]; then
  check_args+=(--insecure)
fi

log "checking HTTP surface"
bash scripts/check-selfhost.sh "${check_args[@]}"

if [[ "$run_worker_smoke" == "1" ]]; then
  worker_args=(
    --base-url "$base_url"
    --admin-token "$AGENTHUB_SMOKE_ADMIN_TOKEN"
    --worker-id "agenthub-smoke-${GITHUB_RUN_ID:-$(date +%s)}"
    --connection-mode "$([[ "$mode" == "tailscale_private" ]] && printf private || printf public_relay)"
    --json
  )
  if [[ "$skip_certbot" == "1" || "$mode" == "tailscale_private" ]]; then
    worker_args+=(--insecure)
  fi
  log "checking worker onboarding"
  bash scripts/smoke-worker-onboarding.sh "${worker_args[@]}"
fi

log "self-host VM smoke passed"
