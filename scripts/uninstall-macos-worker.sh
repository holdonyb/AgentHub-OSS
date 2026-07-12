#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

worker_id="$(hostname)"
install_root=""
launch_agent_label=""
purge="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --worker-id)
      [[ -n "${2:-}" ]] || { echo "Missing value for --worker-id" >&2; exit 1; }
      worker_id="$2"
      shift 2
      ;;
    --install-root)
      [[ -n "${2:-}" ]] || { echo "Missing value for --install-root" >&2; exit 1; }
      install_root="$2"
      shift 2
      ;;
    --launch-agent-label)
      [[ -n "${2:-}" ]] || { echo "Missing value for --launch-agent-label" >&2; exit 1; }
      launch_agent_label="$2"
      shift 2
      ;;
    --purge)
      purge="1"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

safe_worker_id="$(printf '%s' "$worker_id" | tr -c 'A-Za-z0-9._-' '_')"
if [[ -z "$safe_worker_id" || "$safe_worker_id" == "." || "$safe_worker_id" == ".." ]]; then
  safe_worker_id="worker"
fi
launch_agent_label="${launch_agent_label:-dev.myagenthub.worker.$safe_worker_id}"
if [[ "$launch_agent_label" == "." || "$launch_agent_label" == ".." || ! "$launch_agent_label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "Invalid --launch-agent-label: $launch_agent_label" >&2
  exit 1
fi
install_root="${install_root:-$HOME/Library/Application Support/AgentHub/workers/$safe_worker_id}"
plist_path="$HOME/Library/LaunchAgents/$launch_agent_label.plist"
launch_domain="gui/$(id -u)"

launch_agent_loaded() {
  launchctl print "$launch_domain/$launch_agent_label" >/dev/null 2>&1
}

if launch_agent_loaded; then
  launchctl bootout "$launch_domain/$launch_agent_label"
  for attempt in {1..50}; do
    if ! launch_agent_loaded; then
      break
    fi
    if [[ "$attempt" == "50" ]]; then
      echo "LaunchAgent is still running: $launch_agent_label" >&2
      exit 1
    fi
    sleep 0.1
  done
fi
if launch_agent_loaded; then
  echo "Refusing to remove files while LaunchAgent is running: $launch_agent_label" >&2
  exit 1
fi
rm -f -- "$plist_path"

if [[ "$purge" == "1" ]]; then
  if launch_agent_loaded; then
    echo "Refusing to purge a running worker: $launch_agent_label" >&2
    exit 1
  fi
  workers_root="$HOME/Library/Application Support/AgentHub/workers"
  mkdir -p "$workers_root"
  resolved_workers_root="$(cd "$workers_root" && pwd -P)"
  if [[ -d "$install_root" ]]; then
    resolved_install_root="$(cd "$install_root" && pwd -P)"
    case "$resolved_install_root" in
      "$resolved_workers_root"/*)
        rm -rf -- "$resolved_install_root"
        ;;
      *)
        echo "Refusing to purge worker root outside $resolved_workers_root: $resolved_install_root" >&2
        exit 1
        ;;
    esac
  fi
fi

echo "Removed LaunchAgent: $launch_agent_label"
if [[ "$purge" != "1" ]]; then
  echo "Worker files retained at: $install_root"
fi
