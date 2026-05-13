from __future__ import annotations

import json
from typing import Any


def dumps_json(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False, separators=(",", ":"))


def loads_json(value: str | None, default: Any = None) -> Any:
    if value in (None, ""):
        return {} if default is None else default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {} if default is None else default
