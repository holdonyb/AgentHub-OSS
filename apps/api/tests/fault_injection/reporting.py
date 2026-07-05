from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def report_dir() -> Path:
    override = os.environ.get("AGENTHUB_FAULT_REPORT_DIR")
    if override:
        return Path(override)
    return Path(__file__).resolve().parent / "reports"


def write_fault_report(scenario: str, payload: dict[str, Any]) -> Path:
    directory = report_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{scenario}.latest.json"
    report = {
        "scenario": scenario,
        "status": "pass",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        **payload,
    }
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path
