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

python3 - "$iface" <<'PY'
from __future__ import annotations

from datetime import datetime, timezone
import json
import subprocess
import sys

iface = sys.argv[1]
def iso_from_epoch(value: int) -> str:
    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()

def summarize_json_mode() -> dict[str, object]:
    payload = json.loads(subprocess.check_output(["vnstat", "--json"], text=True))
    interfaces = payload.get("interfaces") or []
    target = None
    for item in interfaces:
        if item.get("name") == iface:
            target = item
            break
    if target is None:
        raise RuntimeError(f"Interface {iface} not found in vnstat output")
    traffic = target.get("traffic") or {}
    days = traffic.get("day") or []
    months = traffic.get("month") or []
    hours = traffic.get("hour") or []
    totals = traffic.get("total") or {}

    def summarize_day(entry: dict[str, object]) -> dict[str, object]:
        date = entry.get("date") or {}
        assert isinstance(date, dict)
        stamp = f"{date.get('year', 0):04d}-{date.get('month', 0):02d}-{date.get('day', 0):02d}"
        rx = int(entry.get("rx", 0))
        tx = int(entry.get("tx", 0))
        return {"date": stamp, "rx_bytes": rx, "tx_bytes": tx, "total_bytes": rx + tx}

    def summarize_hour(entry: dict[str, object]) -> dict[str, object]:
        date = entry.get("date") or {}
        time = entry.get("time") or {}
        assert isinstance(date, dict) and isinstance(time, dict)
        stamp = (
            f"{date.get('year', 0):04d}-{date.get('month', 0):02d}-{date.get('day', 0):02d} "
            f"{time.get('hour', 0):02d}:{time.get('minute', 0):02d}"
        )
        rx = int(entry.get("rx", 0))
        tx = int(entry.get("tx", 0))
        return {"hour": stamp, "rx_bytes": rx, "tx_bytes": tx, "total_bytes": rx + tx}

    return {
        "interface": iface,
        "updated_at": payload.get("updated"),
        "today": summarize_day(days[-1]) if days else None,
        "yesterday": summarize_day(days[-2]) if len(days) > 1 else None,
        "last_24_hours": [summarize_hour(item) for item in hours[-24:]],
        "current_month": {
            "month": f"{months[-1].get('date', {}).get('year', 0):04d}-{months[-1].get('date', {}).get('month', 0):02d}"
            if months
            else None,
            "rx_bytes": int(months[-1].get("rx", 0)) if months else 0,
            "tx_bytes": int(months[-1].get("tx", 0)) if months else 0,
            "total_bytes": (int(months[-1].get("rx", 0)) + int(months[-1].get("tx", 0))) if months else 0,
        },
        "lifetime_total_bytes": int(totals.get("rx", 0)) + int(totals.get("tx", 0)),
    }

def summarize_dumpdb_mode() -> dict[str, object]:
    raw = subprocess.check_output(["vnstat", "--dumpdb"], text=True)
    meta: dict[str, str] = {}
    days: list[dict[str, object]] = []
    hours: list[dict[str, object]] = []
    months: list[dict[str, object]] = []

    for line in raw.splitlines():
      parts = line.strip().split(";")
      if not parts or not parts[0]:
          continue
      record_type = parts[0]
      if record_type == "d" and len(parts) >= 5:
          stamp = int(parts[2] or 0)
          if stamp <= 0:
              continue
          rx = int(parts[3] or 0)
          tx = int(parts[4] or 0)
          days.append({"date": iso_from_epoch(stamp)[:10], "rx_bytes": rx, "tx_bytes": tx, "total_bytes": rx + tx})
      elif record_type == "h" and len(parts) >= 5:
          stamp = int(parts[2] or 0)
          if stamp <= 0:
              continue
          rx = int(parts[3] or 0)
          tx = int(parts[4] or 0)
          hours.append({"hour": iso_from_epoch(stamp)[:13].replace("T", " ") + ":00", "rx_bytes": rx, "tx_bytes": tx, "total_bytes": rx + tx})
      elif record_type == "m" and len(parts) >= 5:
          stamp = int(parts[2] or 0)
          if stamp <= 0:
              continue
          rx = int(parts[3] or 0)
          tx = int(parts[4] or 0)
          months.append({"month": iso_from_epoch(stamp)[:7], "rx_bytes": rx, "tx_bytes": tx, "total_bytes": rx + tx})
      elif len(parts) >= 2:
          meta[record_type] = parts[1]

    current_month_rx = int(meta.get("currx", "0"))
    current_month_tx = int(meta.get("curtx", "0"))
    lifetime_rx = int(meta.get("totalrx", "0")) or current_month_rx
    lifetime_tx = int(meta.get("totaltx", "0")) or current_month_tx
    updated_at = iso_from_epoch(int(meta.get("updated", "0"))) if meta.get("updated") else None

    return {
        "interface": meta.get("interface", iface),
        "updated_at": updated_at,
        "today": days[0] if days else None,
        "yesterday": days[1] if len(days) > 1 else None,
        "last_24_hours": hours[:24],
        "current_month": months[0] if months else {
            "month": updated_at[:7] if updated_at else None,
            "rx_bytes": current_month_rx,
            "tx_bytes": current_month_tx,
            "total_bytes": current_month_rx + current_month_tx,
        },
        "lifetime_total_bytes": lifetime_rx + lifetime_tx,
    }

def live_sample_text() -> str | None:
    try:
        output = subprocess.check_output(["vnstat", "-tr", "5", "-i", iface], text=True, stderr=subprocess.STDOUT)
    except Exception:
        return None
    text = output.strip()
    return text or None

try:
    result = summarize_json_mode()
except Exception:
    result = summarize_dumpdb_mode()

sample = live_sample_text()
if sample:
    result["live_sample"] = sample

print(json.dumps(result, ensure_ascii=False, indent=2))
PY
