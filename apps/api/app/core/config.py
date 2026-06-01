from __future__ import annotations

import json
from functools import lru_cache
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="AGENTHUB_", extra="ignore")

    app_name: str = "AgentHub"
    environment: str = "development"
    database_url: str = "sqlite+pysqlite:///./agenthub.db"
    bootstrap_token: str | None = None
    worker_registration_token: str | None = None
    cookie_secure: bool = True
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["http://localhost:43073"])
    rate_limit_enabled: bool = True
    login_rate_limit_count: Annotated[int, Field(ge=1)] = 5
    login_rate_limit_window_seconds: Annotated[int, Field(ge=1)] = 300
    mutation_rate_limit_count: Annotated[int, Field(ge=1)] = 60
    mutation_rate_limit_window_seconds: Annotated[int, Field(ge=1)] = 60
    heartbeat_offline_seconds: Annotated[int, Field(ge=1)] = 180
    claimed_job_stale_seconds: Annotated[int, Field(ge=1)] = 900
    orphaned_claimed_job_grace_seconds: Annotated[int, Field(ge=1)] = 120
    default_session_job_timeout_seconds: Annotated[int, Field(ge=60)] = 3600
    max_session_attachments: Annotated[int, Field(ge=1, le=20)] = 5
    max_session_attachment_bytes: Annotated[int, Field(ge=1024)] = 8 * 1024 * 1024
    max_voice_audio_bytes: Annotated[int, Field(ge=1024)] = 12 * 1024 * 1024
    secret_encryption_key: str = ""
    doubao_asr_api_key: str = ""
    doubao_asr_app_key: str = ""
    doubao_asr_access_key: str = ""
    doubao_asr_endpoint: str = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
    doubao_asr_resource_id: str = "volc.seedasr.auc"
    doubao_asr_sts_endpoint: str = "https://openspeech.bytedance.com/api/v1/sts/token"
    doubao_stream_asr_url: str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"
    doubao_stream_asr_resource_id: str = "volc.bigasr.sauc.duration"
    doubao_stream_token_duration_seconds: Annotated[int, Field(ge=60, le=3600)] = 300

    @field_validator("cors_origins", mode="before")
    @classmethod
    def normalize_cors_origins(cls, value: object) -> list[str] | object:
        if isinstance(value, list):
            return value
        if not isinstance(value, str):
            return value

        raw = value.strip()
        if not raw:
            return []

        if raw.startswith(("'", '"')) and raw.endswith(("'", '"')) and len(raw) >= 2:
            raw = raw[1:-1].strip()

        if raw.startswith("[") and raw.endswith("]"):
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                inner = raw[1:-1].strip()
                if not inner:
                    return []
                return [item.strip().strip("'\"") for item in inner.split(",") if item.strip()]
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]

        return [raw]


@lru_cache
def get_settings() -> Settings:
    return Settings()
