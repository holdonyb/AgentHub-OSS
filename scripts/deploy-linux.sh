#!/usr/bin/env bash
set -Eeuo pipefail

project_root="${AGENTHUB_PROJECT_ROOT:-/opt/agenthub}"
branch="${AGENTHUB_DEPLOY_BRANCH:-main}"
api_service="${AGENTHUB_API_SERVICE:-agenthub-api.service}"
worker_service="${AGENTHUB_LINUX_WORKER_SERVICE:-agenthub-linux-worker.service}"
skip_npm_ci="${AGENTHUB_SKIP_NPM_CI:-0}"
skip_pip="${AGENTHUB_SKIP_PIP:-0}"
health_url="${AGENTHUB_HEALTH_URL:-http://127.0.0.1:8019/healthz}"
downloads_dir="${AGENTHUB_DOWNLOADS_DIR:-$project_root/data/downloads}"
worker_downloads_dir="${AGENTHUB_WORKER_DOWNLOADS_DIR:-$downloads_dir/workers}"
npm_cache_dir="${AGENTHUB_NPM_CACHE_DIR:-$project_root/.runtime/npm-cache}"
deploy_lock="${AGENTHUB_DEPLOY_LOCK:-$project_root/.runtime/deploy.lock}"

log() {
  printf '[agenthub-deploy] %s\n' "$*"
}

archive_root_backups() {
  mkdir -p .runtime/config-backups
  shopt -s nullglob
  local backup moved=0
  for backup in .env.backup-*; do
    mv -f -- "$backup" ".runtime/config-backups/"
    moved=1
  done
  shopt -u nullglob

  if [[ "$moved" == "1" ]]; then
    log "archived root config backups into .runtime/config-backups"
  fi
}

prepare_git_checkout() {
  local target_branch="$1"
  local remote_ref="origin/$target_branch"

  git rev-parse --is-inside-work-tree >/dev/null

  log "fetching $remote_ref"
  git fetch --prune origin "$target_branch"
  git show-ref --verify --quiet "refs/remotes/$remote_ref"

  if [[ -n "$(git status --short --untracked-files=no)" ]]; then
    log "discarding tracked working tree drift before deploy checkout"
    git reset --hard HEAD
  fi

  log "checking out canonical local branch $target_branch"
  git checkout -B "$target_branch" "$remote_ref"
  git branch --set-upstream-to "$remote_ref" "$target_branch" >/dev/null 2>&1 || true
  git reset --hard "$remote_ref"

  archive_root_backups

  log "cleaning repo-local untracked artifacts"
  git clean -fdx \
    -e .env \
    -e .venv \
    -e .runtime \
    -e data

  log "current branch: $(git rev-parse --abbrev-ref HEAD)"
  log "current revision: $(git rev-parse --short HEAD)"
}

wait_for_health() {
  local url="$1"
  local attempts="${AGENTHUB_HEALTH_ATTEMPTS:-30}"
  local delay="${AGENTHUB_HEALTH_DELAY_SECONDS:-2}"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl -fs --max-time 10 "$url" >/dev/null; then
      return 0
    fi
    log "health check not ready ($attempt/$attempts)"
    sleep "$delay"
  done

  return 1
}

smoke_check_status() {
  local url="$1"
  local expected="$2"
  local actual
  actual="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$url")"
  if [[ "$actual" != "$expected" ]]; then
    log "smoke check failed for $url: expected $expected got $actual"
    return 1
  fi
}

smoke_check_post_status() {
  local url="$1"
  local expected="$2"
  local body="$3"
  local actual
  actual="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$url" -H 'Content-Type: application/json' -d "$body")"
  IFS=',' read -r -a expected_codes <<<"$expected"
  local candidate=""
  for candidate in "${expected_codes[@]}"; do
    if [[ "$actual" == "$candidate" ]]; then
      return 0
    fi
  done
  log "smoke check failed for $url: expected one of [$expected] got $actual"
  return 1
}

clean_node_modules() {
  local resolved_root
  resolved_root="$(pwd -P)"
  if [[ -z "$resolved_root" || "$resolved_root" == "/" ]]; then
    log "refusing to clean unsafe project root: $resolved_root"
    return 1
  fi

  local targets=(
    "$resolved_root/node_modules"
    "$resolved_root/apps/web/node_modules"
    "$resolved_root/apps/mobile/node_modules"
    "$resolved_root/apps/desktop/node_modules"
    "$resolved_root/packages/protocol/node_modules"
    "$(realpath -m "$npm_cache_dir")"
  )
  local target resolved_target
  for target in "${targets[@]}"; do
    resolved_target="$(realpath -m "$target")"
    case "$resolved_target" in
      "$resolved_root"/*)
        if [[ -e "$resolved_target" ]]; then
          log "removing incomplete install: $resolved_target"
          rm -rf -- "$resolved_target"
        fi
        ;;
      *)
        log "refusing to remove path outside project root: $resolved_target"
        return 1
        ;;
    esac
  done
}

npm_ci() {
  mkdir -p "$npm_cache_dir"
  npm ci --cache "$npm_cache_dir" --prefer-online --no-audit --no-fund
}

pip_install_api_dependencies() {
  local python_bin="$1"
  if "$python_bin" -m pip install -r apps/api/requirements.txt; then
    return 0
  fi
  log "pip install failed; retrying with mirrors.aliyun.com"
  if "$python_bin" -m pip install -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com -r apps/api/requirements.txt; then
    return 0
  fi
  log "pip install with Aliyun public mirror failed; retrying with PyPI"
  "$python_bin" -m pip install -i https://pypi.org/simple -r apps/api/requirements.txt
}

install_node_dependencies() {
  log "installing Node dependencies"
  if ! npm_ci; then
    log "npm ci failed; cleaning node_modules and retrying"
    clean_node_modules
    npm_ci
  fi
  if [[ ! -x node_modules/.bin/tsc || ! -x node_modules/.bin/vite ]]; then
    log "Node install missing build tools; cleaning node_modules and retrying"
    clean_node_modules
    npm_ci
  fi
  test -x node_modules/.bin/tsc
  test -x node_modules/.bin/vite
}

cd "$project_root"

mkdir -p "$(dirname "$deploy_lock")"
exec 9>"$deploy_lock"
if ! flock -w 300 9; then
  log "another deploy is still running: $deploy_lock"
  exit 1
fi

log "project root: $project_root"
prepare_git_checkout "$branch"

if [[ "$skip_pip" != "1" && -x ".venv/bin/python" ]]; then
  log "installing Python API dependencies"
  pip_install_api_dependencies .venv/bin/python
fi

if [[ "$skip_npm_ci" != "1" ]]; then
  install_node_dependencies
fi

log "building worker bundles"
.venv/bin/python scripts/build-worker-bundle.py --output-root "$worker_downloads_dir"
test -f "$worker_downloads_dir/agenthub-worker-windows.zip"
test -f "$worker_downloads_dir/agenthub-worker-linux.tar.gz"

log "building Web console"
rm -rf apps/web/dist
npm run web:build
test -f apps/web/dist/index.html

if [[ -d "$downloads_dir" ]]; then
  log "syncing downloads from $downloads_dir"
  mkdir -p apps/web/dist/downloads
  cp -a "$downloads_dir"/. apps/web/dist/downloads/
fi

log "ensuring worker helper scripts are executable"
chmod +x scripts/update-linux-worker.sh

if command -v nginx >/dev/null 2>&1; then
  log "validating nginx"
  nginx -t
fi

log "restarting systemd services"
systemctl restart "$api_service"
systemctl restart "$worker_service"

if command -v nginx >/dev/null 2>&1 && systemctl list-unit-files nginx.service >/dev/null 2>&1; then
  log "reloading nginx"
  systemctl reload nginx
fi

log "service status"
systemctl is-active "$api_service"
systemctl is-active "$worker_service"

if command -v curl >/dev/null 2>&1; then
  log "health check: $health_url"
  wait_for_health "$health_url"
  public_base="${AGENTHUB_PUBLIC_BASE_URL:-}"
  if [[ -n "$public_base" ]]; then
    public_base="${public_base%/}"
    log "public smoke checks: $public_base"
    smoke_check_status "$public_base/healthz" "200"
    smoke_check_post_status "$public_base/api/worker/enroll" "403" '{"enrollment_token":"invalid","worker_id":"smoke-worker","machine_name":"smoke-worker","os":"linux","connection_mode":"public_relay","transport_state":"polling","reachable_backends":[],"workspace_roots":["/tmp"],"capabilities":{}}'
    smoke_check_post_status "$public_base/api/internal/jobs/claim" "401,403" '{"worker_id":"smoke-worker"}'
  fi
fi

log "done"
