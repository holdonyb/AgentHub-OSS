#!/usr/bin/env bash
set -Eeuo pipefail

base_url=""
admin_token=""
worker_id="agenthub-smoke-$(date +%s)"
connection_mode="public_relay"
workspace_root="/tmp/agenthub-smoke-workspace"
insecure="0"
json_output="0"
create_job="1"

usage() {
  cat <<'EOF'
Usage: smoke-worker-onboarding.sh --base-url URL --admin-token TOKEN [options]

Exercise the public relay worker onboarding path without installing a long-lived worker service.
The script creates a one-time enrollment, enrolls a synthetic worker, sends heartbeat,
creates a health_check job, claims it through /api/worker/jobs/claim, and completes it.

Options:
  --base-url URL              AgentHub public or Tailscale URL
  --admin-token TOKEN         Personal access token with admin/operator permissions
  --worker-id ID              Worker id to use, default agenthub-smoke-<timestamp>
  --connection-mode MODE      public_relay or private, default public_relay
  --workspace-root PATH       Workspace root reported by the synthetic worker
  --skip-job                  Only test enrollment and heartbeat
  --insecure                  Pass -k to curl for temporary/self-signed certificate checks
  --json                      Emit a machine-readable success summary
  -h, --help                  Show this help
EOF
}

log() {
  printf '[agenthub-worker-smoke] %s\n' "$*"
}

fail() {
  printf '[agenthub-worker-smoke] ERROR: %s\n' "$*" >&2
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

json_get() {
  local path="$1"
  local payload
  payload="$(cat)"
  AGENTHUB_JSON_PAYLOAD="$payload" python3 - "$path" <<'PY'
import json
import os
import sys

path = sys.argv[1].split(".")
value = json.loads(os.environ["AGENTHUB_JSON_PAYLOAD"])
for part in path:
    value = value[part]
print(value)
PY
}

curl_args=()

request_json() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="${4:-}"
  local expected="${5:-200}"
  local url="${base_url%/}$path"
  local tmp
  local status
  tmp="$(mktemp)"
  local args=("${curl_args[@]}" -sS -o "$tmp" -w '%{http_code}' --max-time 30 -X "$method" "$url")
  if [[ -n "$token" ]]; then
    args+=(-H "Authorization: Bearer $token")
  fi
  if [[ -n "$body" ]]; then
    args+=(-H 'Content-Type: application/json' -d "$body")
  fi
  status="$(curl "${args[@]}")" || {
    cat "$tmp" >&2 || true
    rm -f "$tmp"
    fail "$method $path curl failed"
  }
  if [[ "$status" != "$expected" ]]; then
    cat "$tmp" >&2 || true
    rm -f "$tmp"
    fail "$method $path expected $expected got $status"
  fi
  cat "$tmp"
  rm -f "$tmp"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      require_value "$1" "${2:-}"
      base_url="$2"
      shift 2
      ;;
    --admin-token)
      require_value "$1" "${2:-}"
      admin_token="$2"
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
    --workspace-root)
      require_value "$1" "${2:-}"
      workspace_root="$2"
      shift 2
      ;;
    --skip-job)
      create_job="0"
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

[[ -n "$base_url" ]] || {
  usage
  fail "--base-url is required"
}
[[ -n "$admin_token" ]] || {
  usage
  fail "--admin-token is required"
}
[[ "$connection_mode" == "public_relay" || "$connection_mode" == "private" ]] || fail "--connection-mode must be public_relay or private"

require_tool curl
require_tool python3

if [[ "$insecure" == "1" ]]; then
  curl_args+=("-k")
fi

log "creating enrollment for $worker_id"
enrollment_response="$(
  request_json \
    POST \
    /api/worker-enrollments \
    "$admin_token" \
    "{\"label\":\"self-host smoke $worker_id\",\"expires_in_hours\":1}"
)"
enrollment_token="$(printf '%s' "$enrollment_response" | json_get enrollment_token)"

log "enrolling synthetic worker $worker_id"
enroll_response="$(
  request_json \
    POST \
    /api/worker/enroll \
    "" \
    "{\"enrollment_token\":\"$enrollment_token\",\"worker_id\":\"$worker_id\",\"machine_name\":\"$worker_id\",\"os\":\"linux\",\"connection_mode\":\"$connection_mode\",\"transport_state\":\"polling\",\"worker_version\":\"smoke\",\"reachable_backends\":[\"smoke\"],\"workspace_roots\":[\"$workspace_root\"],\"capabilities\":{\"synthetic_smoke\":true}}"
)"
worker_token="$(printf '%s' "$enroll_response" | json_get worker_token)"

log "sending worker heartbeat"
request_json \
  POST \
  /api/worker/heartbeat \
  "$worker_token" \
  "{\"status\":\"online\",\"transport_state\":\"polling\",\"worker_version\":\"smoke\",\"reachable_backends\":[\"smoke\"],\"workspace_roots\":[\"$workspace_root\"],\"capabilities\":{\"synthetic_smoke\":true},\"active_job_ids\":[]}" \
  >/dev/null

job_id=""
claimed_job_id=""
if [[ "$create_job" == "1" ]]; then
  log "creating health_check job"
  job_response="$(
    request_json \
      POST \
      /api/jobs \
      "$admin_token" \
      "{\"kind\":\"health_check\",\"worker_id\":\"$worker_id\",\"priority\":1,\"payload\":{\"source\":\"selfhost-smoke\"}}"
  )"
  job_id="$(printf '%s' "$job_response" | json_get job.job_id)"

  log "claiming health_check job"
  claim_response="$(request_json POST /api/worker/jobs/claim "$worker_token")"
  claimed_job_id="$(printf '%s' "$claim_response" | json_get job.job_id)"
  [[ "$claimed_job_id" == "$job_id" ]] || fail "claimed job $claimed_job_id did not match created job $job_id"

  log "completing health_check job"
  request_json \
    POST \
    "/api/worker/jobs/$job_id/complete" \
    "$worker_token" \
    "{\"worker_id\":\"$worker_id\",\"result_text\":\"self-host worker onboarding smoke ok\"}" \
    >/dev/null
fi

log "worker onboarding smoke checks passed"

if [[ "$json_output" == "1" ]]; then
  python3 - "$base_url" "$worker_id" "$connection_mode" "$job_id" <<'PY'
import json
import sys

print(json.dumps({
    "status": "ok",
    "base_url": sys.argv[1],
    "worker_id": sys.argv[2],
    "connection_mode": sys.argv[3],
    "job_id": sys.argv[4] or None,
}, ensure_ascii=False))
PY
fi
