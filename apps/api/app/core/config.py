from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from pydantic import AliasChoices, Field
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
    max_session_attachments: Annotated[int, Field(ge=1, le=20)] = 5
    max_session_attachment_bytes: Annotated[int, Field(ge=1024)] = 8 * 1024 * 1024
    max_voice_audio_bytes: Annotated[int, Field(ge=1024)] = 12 * 1024 * 1024
    secret_encryption_key: str = ""
    voice_asr_provider: str = "doubao"
    doubao_asr_api_key: str = ""
    doubao_asr_app_key: str = ""
    doubao_asr_access_key: str = ""
    doubao_asr_endpoint: str = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
    doubao_asr_resource_id: str = "volc.seedasr.auc"
    doubao_asr_sts_endpoint: str = "https://openspeech.bytedance.com/api/v1/sts/token"
    doubao_stream_asr_url: str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"
    doubao_stream_asr_resource_id: str = "volc.bigasr.sauc.duration"
    doubao_stream_token_duration_seconds: Annotated[int, Field(ge=60, le=3600)] = 300
    openai_asr_api_key: str = Field(
        default="",
        validation_alias=AliasChoices("AGENTHUB_OPENAI_ASR_API_KEY", "OPENAI_API_KEY"),
    )
    openai_asr_base_url: str = "https://api.openai.com/v1"
    openai_asr_model: str = "whisper-1"


@lru_cache
def get_settings() -> Settings:
    return Settings()
