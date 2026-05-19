#!/usr/bin/env bash
set -Eeuo pipefail

base_url=""
expect_public_relay="0"
expect_worker_bundles="0"
insecure="0"
json_output="0"

usage() {
  cat <<'EOF'
Usage: check-selfhost.sh --base-url URL [options]

Smoke-check an AgentHub self-host deployment.

Options:
  --base-url URL          AgentHub public or Tailscale URL, for example https://agenthub.example.com
  --expect-public-relay   Also verify public worker relay rejects invalid enrollment
  --expect-worker-bundles Also verify downloadable Windows/Linux worker bundles exist
  --insecure              Pass -k to curl for temporary/self-signed certificate checks
  --json                  Emit a machine-readable success summary after checks
  -h, --help              Show this help
EOF
}

log() {
  printf '[agenthub-check] %s\n' "$*"
}

fail() {
  printf '[agenthub-check] ERROR: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local key="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    fail "Missing value for $key"
  fi
}

curl_args=()
checks=()

record_check() {
  local method="$1"
  local path="$2"
  local status="$3"
  checks+=("$method $path $status")
}

http_status() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local url="${base_url%/}$path"
  if [[ -n "$body" ]]; then
    curl "${curl_args[@]}" -sS -o /dev/null -w '%{http_code}' --max-time 20 -X "$method" "$url" -H 'Content-Type: application/json' -d "$body"
  else
    curl "${curl_args[@]}" -sS -o /dev/null -w '%{http_code}' --max-time 20 -X "$method" "$url"
  fi
}

expect_status() {
  local method="$1"
  local path="$2"
  local expected="$3"
  local body="${4:-}"
  local actual
  actual="$(http_status "$method" "$path" "$body")"
  IFS=',' read -r -a expected_values <<<"$expected"
  for candidate in "${expected_values[@]}"; do
    if [[ "$actual" == "$candidate" ]]; then
      log "$method $path -> $actual"
      record_check "$method" "$path" "$actual"
      return 0
    fi
  done
  fail "$method $path expected [$expected] got $actual"
}

emit_json() {
  local checks_blob
  checks_blob="$(printf '%s\n' "${checks[@]}")"
  AGENTHUB_CHECKS="$checks_blob" python3 - "$base_url" <<'PY'
import json
import os
import sys

base_url = sys.argv[1]
checks = []
for line in os.environ.get("AGENTHUB_CHECKS", "").splitlines():
    if not line.strip():
        continue
    method, path, status = line.split(" ", 2)
    checks.append({"method": method, "path": path, "status": int(status)})
print(json.dumps({"status": "ok", "base_url": base_url, "checks": checks}, ensure_ascii=False))
PY
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      require_value "$1" "${2:-}"
      base_url="$2"
      shift 2
      ;;
    --expect-public-relay)
      expect_public_relay="1"
      shift
      ;;
    --expect-worker-bundles)
      expect_worker_bundles="1"
      shift
      ;;
    --insecure)
      insecure="1"
      shift
      ;;
    --json)
      json_output="1"
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

if [[ -z "$base_url" ]]; then
  usage
  fail "--base-url is required"
fi

if [[ "$insecure" == "1" ]]; then
  curl_args+=("-k")
fi

expect_status GET /healthz 200
expect_status GET / 200
expect_status POST /api/internal/jobs/claim 401,403 '{"worker_id":"smoke-worker"}'

if [[ "$expect_public_relay" == "1" ]]; then
  expect_status POST /api/worker/enroll 403 '{"enrollment_token":"invalid","worker_id":"smoke-worker","machine_name":"smoke-worker","os":"linux","connection_mode":"public_relay","transport_state":"polling","reachable_backends":[],"workspace_roots":["/tmp"],"capabilities":{}}'
fi

if [[ "$expect_worker_bundles" == "1" ]]; then
  expect_status GET /downloads/workers/worker-bundles-manifest.json 200
  expect_status GET /downloads/workers/agenthub-worker-windows.zip 200
  expect_status GET /downloads/workers/agenthub-worker-linux.tar.gz 200
fi

log "self-host smoke checks passed"

if [[ "$json_output" == "1" ]]; then
  emit_json
fi
