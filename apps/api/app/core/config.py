from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="AGENTHUB_", extra="ignore")

    app_name: str = "AgentHub"
    environment: str = "development"
    database_url: str = "sqlite+pysqlite:///./agenthub.db"
    bootstrap_token: str | None = None
    worker_registration_token: str | None = None
    cookie_secure: bool = True
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
    rate_limit_enabled: bool = True
    login_rate_limit_count: Annotated[int, Field(ge=1)] = 5
    login_rate_limit_window_seconds: Annotated[int, Field(ge=1)] = 300
    mutation_rate_limit_count: Annotated[int, Field(ge=1)] = 60
    mutation_rate_limit_window_seconds: Annotated[int, Field(ge=1)] = 60
    heartbeat_offline_seconds: Annotated[int, Field(ge=1)] = 180
    claimed_job_stale_seconds: Annotated[int, Field(ge=1)] = 900
    orphaned_claimed_job_grace_seconds: Annotated[int, Field(ge=1)] = 120
    default_session_job_timeout_seconds: Annotated[int, Field(ge=60)] = 3600
    max_session_attachment_bytes: Annotated[int, Field(ge=1024)] = 8 * 1024 * 1024
    max_voice_audio_bytes: Annotated[int, Field(ge=1024)] = 12 * 1024 * 1024
    secret_encryption_key: str = ""
    doubao_asr_api_key: str = ""
    doubao_asr_app_key: str = ""
    doubao_asr_access_key: str = ""
    doubao_asr_endpoint: str = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
    doubao_asr_resource_id: str = "volc.seedasr.auc"


@lru_cache
def get_settings() -> Settings:
    return Settings()
