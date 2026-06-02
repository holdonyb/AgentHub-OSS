#!/usr/bin/env bash
set -Eeuo pipefail

domain=""
site_root="/var/www/agenthub-site"
github_repo="YOUR_ORG/AgentHub-OSS"
nginx_available_dir="/etc/nginx/sites-available"
nginx_enabled_dir="/etc/nginx/sites-enabled"
cert_dir=""
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: deploy-website.sh --domain myagenthub.dev [options]

Deploy the static AgentHub OSS website and nginx vhost for the public root domain.

Options:
  --domain DOMAIN                 Root domain, for example myagenthub.dev
  --site-root PATH                Static site target root, default /var/www/agenthub-site
  --github-repo OWNER/REPO        Release/docs target repo, default YOUR_ORG/AgentHub-OSS
  --cert-dir PATH                 TLS cert directory, default /etc/letsencrypt/live/DOMAIN
  --nginx-available-dir PATH      Nginx sites-available dir, default /etc/nginx/sites-available
  --nginx-enabled-dir PATH        Nginx sites-enabled dir, default /etc/nginx/sites-enabled
  --source-root PATH              Repository root, default current repo root
  -h, --help                      Show this help
EOF
}

fail() {
  printf '[agenthub-website] ERROR: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local key="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    fail "Missing value for $key"
  fi
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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      require_value "$1" "${2:-}"
      domain="$2"
      shift 2
      ;;
    --site-root)
      require_value "$1" "${2:-}"
      site_root="$2"
      shift 2
      ;;
    --github-repo)
      require_value "$1" "${2:-}"
      github_repo="$2"
      shift 2
      ;;
    --cert-dir)
      require_value "$1" "${2:-}"
      cert_dir="$2"
      shift 2
      ;;
    --nginx-available-dir)
      require_value "$1" "${2:-}"
      nginx_available_dir="$2"
      shift 2
      ;;
    --nginx-enabled-dir)
      require_value "$1" "${2:-}"
      nginx_enabled_dir="$2"
      shift 2
      ;;
    --source-root)
      require_value "$1" "${2:-}"
      source_root="$2"
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

[[ -n "$domain" ]] || {
  usage
  fail "--domain is required"
}

if [[ -z "$cert_dir" ]]; then
  cert_dir="/etc/letsencrypt/live/$domain"
fi

mkdir -p "$site_root/app" "$site_root/download" "$site_root/release" "$site_root/assets"
cp "$source_root/website/styles.css" "$site_root/styles.css"
cp "$source_root/scripts/install.sh" "$site_root/install.sh"
chmod +x "$site_root/install.sh"
cp "$source_root/docs/assets/agenthub-readme-hero.png" "$site_root/assets/agenthub-readme-hero.png"
cp "$source_root/docs/assets/agenthub-architecture-overview.png" "$site_root/assets/agenthub-architecture-overview.png"
cp "$source_root/docs/assets/agenthub-release-showcase.svg" "$site_root/assets/agenthub-release-showcase.svg"
cp "$source_root/assets/brand/agenthub-mark.svg" "$site_root/assets/agenthub-mark.svg"
cp "$source_root/assets/brand/agenthub-icon.png" "$site_root/assets/agenthub-icon.png"

replace_placeholder \
  "$source_root/website/index.html" \
  "$site_root/index.html" \
  "__AGENTHUB_GITHUB_REPO__" "$github_repo"

replace_placeholder \
  "$source_root/website/app/index.html" \
  "$site_root/app/index.html" \
  "__AGENTHUB_GITHUB_REPO__" "$github_repo"

replace_placeholder \
  "$source_root/website/download/index.html" \
  "$site_root/download/index.html" \
  "__AGENTHUB_GITHUB_REPO__" "$github_repo"

replace_placeholder \
  "$source_root/website/release/index.html" \
  "$site_root/release/index.html" \
  "__AGENTHUB_GITHUB_REPO__" "$github_repo"

site_conf="$nginx_available_dir/agenthub-website.conf"
replace_placeholder \
  "$source_root/deploy/nginx/agenthub-website.conf.template" \
  "$site_conf" \
  "__AGENTHUB_ROOT_DOMAIN__" "$domain" \
  "__AGENTHUB_TLS_CERT__" "$cert_dir/fullchain.pem" \
  "__AGENTHUB_TLS_KEY__" "$cert_dir/privkey.pem" \
  "__AGENTHUB_SITE_ROOT__" "$site_root" \
  "__AGENTHUB_GITHUB_REPO__" "$github_repo"

mkdir -p "$nginx_enabled_dir"
ln -sfn "$site_conf" "$nginx_enabled_dir/agenthub-website.conf"

nginx -t
systemctl reload nginx

printf '[agenthub-website] deployed site root=%s domain=%s\n' "$site_root" "$domain"
