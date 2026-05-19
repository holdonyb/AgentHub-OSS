#!/usr/bin/env bash
set -euo pipefail

iface="${1:-}"
if [[ -z "$iface" ]]; then
  iface="$(ip route show default 2>/dev/null | awk 'NR==1 { print $5 }')"
fi

if [[ -z "$iface" ]]; then
  echo "Could not detect default network interface" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
if ! apt-get update; then
  backup_suffix="$(date -u +%Y%m%dT%H%M%SZ)"
  cp /etc/apt/sources.list "/etc/apt/sources.list.agenthub-backup-${backup_suffix}"
  sed -i 's#mirrors.cloud.aliyuncs.com/ubuntu#mirrors.aliyun.com/ubuntu#g' /etc/apt/sources.list
  if [[ -f /etc/apt/sources.list.d/focal.list ]] && grep -q ' focal ' /etc/apt/sources.list.d/focal.list; then
    mv /etc/apt/sources.list.d/focal.list "/etc/apt/sources.list.d/focal.list.agenthub-disabled-${backup_suffix}"
  fi
  apt-get update
fi
apt-get install -y vnstat python3

systemctl enable --now vnstat
vnstat -u -i "$iface" >/dev/null 2>&1 || true
systemctl restart vnstat

cat <<EOF
AgentHub VM traffic monitor installed.
Interface: $iface

Use this to query:
  bash scripts/report-vm-traffic.sh $iface
EOF
