#!/usr/bin/env bash
set -Eeuo pipefail

domain=""
install_root="/opt/agenthub"
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
service_user="agenthub"
api_host="127.0.0.1"
api_port="8019"
public_base_url=""
admin_email=""
skip_packages="0"
skip_certbot="0"
skip_npm_ci="0"
skip_systemd="0"
render_only="0"
systemd_dir="${AGENTHUB_SELFHOST_SYSTEMD_DIR:-/etc/systemd/system}"
nginx_conf_dir="${AGENTHUB_SELFHOST_NGINX_CONF_DIR:-/etc/nginx/conf.d}"
data_dir="${AGENTHUB_SELFHOST_DATA_DIR:-/var/lib/agenthub}"

usage() {
  cat <<'EOF'
Usage: install-selfhost-linux.sh --domain DOMAIN [options]

Install AgentHub API, Web assets, nginx, HTTPS, and systemd service on an Ubuntu VM.

Options:
  --domain DOMAIN              Public DNS name, for example agenthub.example.com
  --install-root PATH          Install path, default /opt/agenthub
  --source-root PATH           Source checkout path, default repository root
  --service-user USER          Linux service user, default agenthub
  --api-host HOST              Uvicorn bind host, default 127.0.0.1
  --api-port PORT              Uvicorn bind port, default 8019
  --public-base-url URL        External URL, default https://DOMAIN
  --admin-email EMAIL          Email for certbot. Required unless --skip-certbot is used
  --skip-packages              Do not install apt, Node.js, nginx, or certbot packages
  --skip-certbot               Render nginx with expected certificate paths but do not request certificates
  --skip-npm-ci                Do not run npm ci
  --skip-systemd               Render files but do not enable/restart systemd or nginx
  --render-only                Non-root dry run: copy source, write .env, render systemd and nginx only
  -h, --help                   Show this help
EOF
}

log() {
  printf '[agenthub-selfhost] %s\n' "$*"
}

fail() {
  printf '[agenthub-selfhost] ERROR: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local key="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    fail "Missing value for $key"
  fi
}

random_hex() {
  python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
}

random_token() {
  python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
}

replace_placeholder() {
  local input="$1"
  local output="$2"
  shift 2
  cp "$input" "$output"
  while [[ $# -gt 0 ]]; do
    local key="$1"
    local value="$2"
    shift 2
    python3 - "$output" "$key" "$value" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
path.write_text(path.read_text(encoding="utf-8").replace(key, value), encoding="utf-8")
PY
  done
}

guard_existing_runtime_data() {
  local env_path="$install_root/.env"
  local resolved_source
  local resolved_target
  local db_url
  local db_path

  if [[ ! -f "$env_path" ]]; then
    return
  fi

  resolved_source="$(cd "$source_root" && pwd -P)"
  mkdir -p "$install_root"
  resolved_target="$(cd "$install_root" && pwd -P)"

  if [[ "$resolved_source" == "$resolved_target" ]]; then
    return
  fi

  db_url="$(
    python3 - "$env_path" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
match = re.search(r"^AGENTHUB_DATABASE_URL=(.+)$", text, re.M)
print(match.group(1).strip() if match else "")
PY
  )"

  if [[ -z "$db_url" ]]; then
    return
  fi

  db_path="$(
    python3 - "$db_url" <<'PY'
from pathlib import Path
import sys

url = sys.argv[1].strip()
prefix = "sqlite+pysqlite:///"
if not url.startswith(prefix):
    print("")
    raise SystemExit(0)
raw_path = url[len(prefix):]
if raw_path.startswith("/"):
    print(Path(raw_path).resolve())
else:
    print(Path(raw_path).resolve())
PY
  )"

  if [[ -z "$db_path" ]]; then
    return
  fi

  case "$db_path" in
    "$resolved_target"/*)
      fail "Existing AGENTHUB_DATABASE_URL points inside install_root ($db_path) while source_root differs from install_root. Refusing rsync --delete deployment. Move the database outside $resolved_target first, for example /var/lib/agenthub/agenthub.db."
      ;;
  esac
}

install_packages() {
  log "installing system packages"
  apt-get update
  apt-get install -y ca-certificates curl git nginx certbot python3-certbot-nginx python3-venv python3-pip rsync unzip tar openssl

  if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
    log "installing Node.js 20 from NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
}

copy_source_tree() {
  local resolved_source
  local resolved_target
  resolved_source="$(cd "$source_root" && pwd -P)"
  mkdir -p "$install_root"
  resolved_target="$(cd "$install_root" && pwd -P)"

  if [[ "$resolved_source" == "$resolved_target" ]]; then
    log "source root and install root are the same: $resolved_target"
    return
  fi

  log "copying source tree to $resolved_target"
  rsync -a --delete \
    --exclude '.git' \
    --exclude '.venv' \
    --exclude '.runtime' \
    --exclude '.env' \
    --exclude 'data' \
    --exclude 'node_modules' \
    --exclude 'apps/*/node_modules' \
    --exclude 'apps/web/dist' \
    --exclude 'apps/mobile/android/app/build' \
    --exclude 'apps/desktop/dist' \
    "$resolved_source"/ "$resolved_target"/
}

write_env_file() {
  local env_path="$install_root/.env"
  mkdir -p "$data_dir"

  if [[ -f "$env_path" ]]; then
    log "keeping existing env file: $env_path"
    return
  fi

  log "writing env file: $env_path"
  cat >"$env_path" <<EOF
AGENTHUB_ENVIRONMENT=production
AGENTHUB_DATABASE_URL=sqlite+pysqlite:///$data_dir/agenthub.db
AGENTHUB_BOOTSTRAP_TOKEN=$(random_token)
AGENTHUB_WORKER_REGISTRATION_TOKEN=$(random_token)
AGENTHUB_SECRET_ENCRYPTION_KEY=$(random_hex)
AGENTHUB_COOKIE_SECURE=true
AGENTHUB_CORS_ORIGINS=["$public_base_url"]
AGENTHUB_PUBLIC_BASE_URL=$public_base_url
AGENTHUB_RATE_LIMIT_ENABLED=true
AGENTHUB_DEFAULT_SESSION_JOB_TIMEOUT_SECONDS=3600
AGENTHUB_CLAIMED_JOB_STALE_SECONDS=900
AGENTHUB_WORKER_MAX_CONCURRENT_JOBS=2
AGENTHUB_WORKER_JOB_POLL_SECONDS=5
AGENTHUB_WORKER_HEARTBEAT_SECONDS=30
AGENTHUB_MAX_SESSION_ATTACHMENT_BYTES=8388608
AGENTHUB_MAX_VOICE_AUDIO_BYTES=12582912
EOF
  chmod 600 "$env_path"
}

install_dependencies_and_build() {
  cd "$install_root"

  if [[ ! -d ".venv" ]]; then
    log "creating Python venv"
    python3 -m venv .venv
  fi

  log "installing Python API dependencies"
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r apps/api/requirements.txt

  if [[ "$skip_npm_ci" != "1" ]]; then
    log "installing Node dependencies"
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
  fi

  log "building Web assets"
  rm -rf apps/web/dist
  npm run web:build

  log "building worker bundles"
  mkdir -p data/downloads/workers
  .venv/bin/python scripts/build-worker-bundle.py --output-root data/downloads/workers
  mkdir -p apps/web/dist/downloads
  cp -a data/downloads/. apps/web/dist/downloads/
}

install_api_service() {
  local template="$install_root/deploy/systemd/agenthub-api.service.template"
  local service_path="$systemd_dir/agenthub-api.service"
  mkdir -p "$systemd_dir"
  log "rendering systemd service: $service_path"
  replace_placeholder "$template" "$service_path" \
    "__AGENTHUB_PROJECT_ROOT__" "$install_root" \
    "__AGENTHUB_ENV_FILE__" "$install_root/.env" \
    "__AGENTHUB_PYTHON__" "$install_root/.venv/bin/python" \
    "__AGENTHUB_API_HOST__" "$api_host" \
    "__AGENTHUB_API_PORT__" "$api_port"
  python3 - "$service_path" "$service_user" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
service_user = sys.argv[2]
text = path.read_text(encoding="utf-8")
if "User=" not in text:
    text = text.replace("[Service]\n", f"[Service]\nUser={service_user}\nGroup={service_user}\n")
path.write_text(text, encoding="utf-8")
PY
}

write_http_certbot_site() {
  mkdir -p /var/www/agenthub-certbot
  mkdir -p "$nginx_conf_dir"
  cat >"$nginx_conf_dir/agenthub-certbot.conf" <<EOF
server {
    listen 80;
    server_name $domain;

    location /.well-known/acme-challenge/ {
        root /var/www/agenthub-certbot;
    }

    location / {
        return 200 'AgentHub certificate bootstrap';
        add_header Content-Type text/plain;
    }
}
EOF
}

install_nginx_site() {
  local template="$install_root/deploy/nginx/agenthub-selfhost.conf.template"
  local site_path="$nginx_conf_dir/agenthub.conf"
  local cert_dir="${AGENTHUB_SELFHOST_CERT_DIR:-/etc/letsencrypt/live/$domain}"
  local cert="$cert_dir/fullchain.pem"
  local key="$cert_dir/privkey.pem"
  mkdir -p "$nginx_conf_dir"
  log "rendering nginx site: $site_path"
  replace_placeholder "$template" "$site_path" \
    "__AGENTHUB_SERVER_NAME__" "$domain" \
    "__AGENTHUB_TLS_CERT__" "$cert" \
    "__AGENTHUB_TLS_KEY__" "$key" \
    "__AGENTHUB_WEB_ROOT__" "$install_root/apps/web/dist" \
    "__AGENTHUB_API_UPSTREAM__" "$api_host:$api_port"
}

request_certificate() {
  if [[ "$skip_certbot" == "1" ]]; then
    local cert_dir="${AGENTHUB_SELFHOST_CERT_DIR:-/etc/letsencrypt/live/$domain}"
    mkdir -p "$cert_dir"
    if [[ ! -f "$cert_dir/fullchain.pem" || ! -f "$cert_dir/privkey.pem" ]]; then
      log "skipping certbot; generating a temporary self-signed certificate for $domain"
      openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
        -keyout "$cert_dir/privkey.pem" \
        -out "$cert_dir/fullchain.pem" \
        -subj "/CN=$domain" >/dev/null 2>&1
      chmod 600 "$cert_dir/privkey.pem"
    else
      log "skipping certbot; using existing certificate paths under $cert_dir"
    fi
    return
  fi
  if [[ -z "$admin_email" ]]; then
    fail "--admin-email is required unless --skip-certbot is used"
  fi

  write_http_certbot_site
  nginx -t
  if [[ "$skip_systemd" != "1" ]]; then
    systemctl reload nginx || systemctl restart nginx
  fi

  log "requesting Let's Encrypt certificate for $domain"
  certbot certonly --webroot -w /var/www/agenthub-certbot -d "$domain" -m "$admin_email" --agree-tos --non-interactive
  rm -f "$nginx_conf_dir/agenthub-certbot.conf"
}

enable_services() {
  if [[ "$skip_systemd" == "1" ]]; then
    log "skipping systemd/nginx activation"
    return
  fi

  systemctl daemon-reload
  systemctl enable --now agenthub-api.service
  nginx -t
  systemctl reload nginx || systemctl restart nginx
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      require_value "$1" "${2:-}"
      domain="$2"
      shift 2
      ;;
    --install-root)
      require_value "$1" "${2:-}"
      install_root="$2"
      shift 2
      ;;
    --source-root)
      require_value "$1" "${2:-}"
      source_root="$2"
      shift 2
      ;;
    --service-user)
      require_value "$1" "${2:-}"
      service_user="$2"
      shift 2
      ;;
    --api-host)
      require_value "$1" "${2:-}"
      api_host="$2"
      shift 2
      ;;
    --api-port)
      require_value "$1" "${2:-}"
      api_port="$2"
      shift 2
      ;;
    --public-base-url)
      require_value "$1" "${2:-}"
      public_base_url="$2"
      shift 2
      ;;
    --admin-email)
      require_value "$1" "${2:-}"
      admin_email="$2"
      shift 2
      ;;
    --skip-packages)
      skip_packages="1"
      shift
      ;;
    --skip-certbot)
      skip_certbot="1"
      shift
      ;;
    --skip-npm-ci)
      skip_npm_ci="1"
      shift
      ;;
    --skip-systemd)
      skip_systemd="1"
      shift
      ;;
    --render-only)
      render_only="1"
      skip_packages="1"
      skip_certbot="1"
      skip_npm_ci="1"
      skip_systemd="1"
      shift
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

if [[ -z "$domain" ]]; then
  usage
  fail "--domain is required"
fi

if [[ -z "$public_base_url" ]]; then
  public_base_url="https://$domain"
fi

if [[ "$render_only" == "1" ]]; then
  systemd_dir="${AGENTHUB_SELFHOST_SYSTEMD_DIR:-$install_root/systemd}"
  nginx_conf_dir="${AGENTHUB_SELFHOST_NGINX_CONF_DIR:-$install_root/nginx}"
  data_dir="${AGENTHUB_SELFHOST_DATA_DIR:-$install_root/data}"
fi

if [[ "$(id -u)" -ne 0 && "$render_only" != "1" ]]; then
  fail "Run as root, for example: sudo bash scripts/install-selfhost-linux.sh --domain $domain --admin-email you@example.com"
fi

if [[ "$skip_packages" != "1" ]]; then
  install_packages
fi

if [[ "$render_only" != "1" ]] && ! id "$service_user" >/dev/null 2>&1; then
  log "creating service user: $service_user"
  useradd --system --create-home --shell /usr/sbin/nologin "$service_user"
fi

guard_existing_runtime_data
copy_source_tree
write_env_file
if [[ "$render_only" == "1" ]]; then
  install_api_service
  install_nginx_site
  log "render-only complete"
  exit 0
fi
install_dependencies_and_build
chown -R "$service_user:$service_user" "$install_root" "$data_dir"
install_api_service
request_certificate
install_nginx_site
enable_services

log "done"
log "Open $public_base_url and create the owner with AGENTHUB_BOOTSTRAP_TOKEN from $install_root/.env"
