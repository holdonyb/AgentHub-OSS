from __future__ import annotations

import pytest

from app.core.config import Settings


@pytest.mark.parametrize(
    ("raw_value", "expected"),
    [
        ("http://localhost:8080", ["http://localhost:8080"]),
        ("[http://localhost:8080]", ["http://localhost:8080"]),
    ],
)
def test_settings_accept_operator_friendly_cors_origin_values(
    monkeypatch: pytest.MonkeyPatch,
    raw_value: str,
    expected: list[str],
) -> None:
    monkeypatch.setenv("AGENTHUB_CORS_ORIGINS", raw_value)

    settings = Settings(_env_file=None)

    assert settings.cors_origins == expected
