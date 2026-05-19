from __future__ import annotations

import base64
import binascii
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException

from app.core.audit import write_event
from app.core.config import get_settings
from app.core.deps import Actor, DbSession, require_min_role
from app.schemas import VoiceStreamAuthOut, VoiceTranscribeIn, VoiceTranscribeOut
from app.services import voice_asr

router = APIRouter()

ALLOWED_AUDIO_TYPES = {
    "audio/webm": "webm",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "mp4",
    "audio/m4a": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
}
DOUBAO_STANDARD_AUDIO_FORMATS = {"wav", "mp3", "ogg", "raw"}
TRANSCODABLE_AUDIO_FORMATS = {"webm", "mp4", "m4a", "aac"}


def _audio_format(payload: VoiceTranscribeIn) -> str:
    content_type = payload.content_type.split(";", 1)[0].strip().lower()
    if content_type in ALLOWED_AUDIO_TYPES:
        return ALLOWED_AUDIO_TYPES[content_type]
    suffix = payload.filename.replace("\\", "/").rsplit("/", 1)[-1].rsplit(".", 1)
    if len(suffix) == 2 and suffix[1].lower() in {"webm", "wav", "mp3", "mp4", "m4a", "ogg"}:
        return suffix[1].lower()
    raise HTTPException(status_code=400, detail={"message": "Unsupported audio type", "code": "VOICE_TYPE"})


def _transcode_audio_to_wav(audio_bytes: bytes, source_format: str) -> bytes:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to transcode voice audio")
    suffix = source_format if source_format in TRANSCODABLE_AUDIO_FORMATS | DOUBAO_STANDARD_AUDIO_FORMATS else "bin"
    with tempfile.TemporaryDirectory(prefix="agenthub-voice-") as temp_dir:
        input_path = Path(temp_dir) / f"input.{suffix}"
        output_path = Path(temp_dir) / "output.wav"
        input_path.write_bytes(audio_bytes)
        try:
            result = subprocess.run(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(input_path),
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-f",
                    "wav",
                    str(output_path),
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError("ffmpeg timed out while transcoding voice audio") from None
        if result.returncode != 0 or not output_path.exists():
            error = " ".join((result.stderr or result.stdout or "unknown ffmpeg error").split())
            raise RuntimeError(f"ffmpeg failed to transcode voice audio: {error[:180]}")
        return output_path.read_bytes()


def _prepare_audio_for_asr(audio_bytes: bytes, audio_format: str, *, provider: str) -> tuple[bytes, str]:
    if provider in {"openai", "openai-compatible", "whisper"}:
        if audio_format in ALLOWED_AUDIO_TYPES.values():
            return audio_bytes, audio_format
        raise HTTPException(status_code=400, detail={"message": "Unsupported audio type", "code": "VOICE_TYPE"})
    if audio_format in DOUBAO_STANDARD_AUDIO_FORMATS:
        return audio_bytes, audio_format
    if audio_format in TRANSCODABLE_AUDIO_FORMATS:
        return _transcode_audio_to_wav(audio_bytes, audio_format), "wav"
    raise HTTPException(status_code=400, detail={"message": "Unsupported audio type", "code": "VOICE_TYPE"})


def _asr_http_error_message(exc: httpx.HTTPStatusError, *, provider_label: str) -> str:
    reason = exc.response.reason_phrase.strip() if exc.response else ""
    suffix = f" {reason}" if reason else ""
    if not exc.response:
        return f"{provider_label} HTTP error"
    provider_code = exc.response.headers.get("X-Api-Status-Code", "").strip()
    provider_message = exc.response.headers.get("X-Api-Message", "").strip()
    provider_detail = ""
    if provider_code:
        provider_detail = f" ({provider_code})"
    if provider_message:
        provider_detail = f"{provider_detail}: {provider_message[:180]}"
    return f"{provider_label} HTTP {exc.response.status_code}{suffix}{provider_detail}"


def _voice_diagnostics(
    payload: VoiceTranscribeIn,
    *,
    provider: str,
    input_format: str,
    asr_format: str,
    input_bytes: int,
    prepared_bytes: int,
) -> dict[str, object]:
    return {
        "provider": provider,
        "filename": payload.filename,
        "content_type": payload.content_type,
        "input_format": input_format,
        "asr_format": asr_format,
        "input_bytes": input_bytes,
        "prepared_bytes": prepared_bytes,
        "duration_ms": payload.duration_ms,
        "chunk_count": payload.chunk_count,
    }


def _voice_error(status_code: int, message: str, code: str, diagnostics: dict[str, object]) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"message": message, "code": code, "diagnostics": diagnostics})


@router.post("/api/voice/transcribe", response_model=VoiceTranscribeOut)
async def transcribe_voice(
    payload: VoiceTranscribeIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
) -> dict[str, object]:
    source_id = f"voice-{uuid.uuid4().hex}"
    provider = voice_asr.diagnostics_provider()
    provider_label = voice_asr.provider_label()
    input_format = _audio_format(payload)
    try:
        source_audio_bytes = base64.b64decode(payload.data_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail={"message": "Invalid audio data", "code": "VOICE_INVALID"}) from None
    if not source_audio_bytes:
        raise HTTPException(status_code=400, detail={"message": "Audio cannot be empty", "code": "VOICE_EMPTY"})
    if len(source_audio_bytes) > get_settings().max_voice_audio_bytes:
        raise HTTPException(status_code=413, detail={"message": "Audio is too large", "code": "VOICE_TOO_LARGE"})
    diagnostics: dict[str, object] = _voice_diagnostics(
        payload,
        provider=provider,
        input_format=input_format,
        asr_format=input_format,
        input_bytes=len(source_audio_bytes),
        prepared_bytes=len(source_audio_bytes),
    )
    try:
        audio_bytes, audio_format = _prepare_audio_for_asr(source_audio_bytes, input_format, provider=provider)
        diagnostics = _voice_diagnostics(
            payload,
            provider=provider,
            input_format=input_format,
            asr_format=audio_format,
            input_bytes=len(source_audio_bytes),
            prepared_bytes=len(audio_bytes),
        )
        if len(audio_bytes) > get_settings().max_voice_audio_bytes:
            raise HTTPException(status_code=413, detail={"message": "Audio is too large", "code": "VOICE_TOO_LARGE"})
        text = await voice_asr.transcribe_audio_bytes(
            audio_bytes,
            audio_format=audio_format,
            language=payload.language,
        )
    except RuntimeError as exc:
        message = str(exc)
        status_code = 503 if "not configured" in message else 502
        write_event(
            db,
            space_id=actor.space_id,
            actor_type="user",
            actor_id=actor.actor_id,
            source_type="voice",
            source_id=source_id,
            event_type="voice.transcribe.failed",
            level="warning",
            payload={"message": message, "code": "VOICE_ASR_FAILED", "diagnostics": diagnostics},
        )
        db.commit()
        raise _voice_error(status_code, message, "VOICE_ASR_FAILED", diagnostics) from None
    except httpx.TimeoutException:
        message = f"{provider_label} timed out"
        write_event(
            db,
            space_id=actor.space_id,
            actor_type="user",
            actor_id=actor.actor_id,
            source_type="voice",
            source_id=source_id,
            event_type="voice.transcribe.failed",
            level="warning",
            payload={"message": message, "code": "VOICE_ASR_TIMEOUT", "diagnostics": diagnostics},
        )
        db.commit()
        raise _voice_error(504, message, "VOICE_ASR_TIMEOUT", diagnostics) from None
    except httpx.HTTPStatusError as exc:
        message = _asr_http_error_message(exc, provider_label=provider_label)
        write_event(
            db,
            space_id=actor.space_id,
            actor_type="user",
            actor_id=actor.actor_id,
            source_type="voice",
            source_id=source_id,
            event_type="voice.transcribe.failed",
            level="warning",
            payload={"message": message, "code": "VOICE_ASR_FAILED", "diagnostics": diagnostics},
        )
        db.commit()
        raise _voice_error(502, message, "VOICE_ASR_FAILED", diagnostics) from None
    except httpx.RequestError as exc:
        message = f"{provider_label} request failed: {type(exc).__name__}"
        write_event(
            db,
            space_id=actor.space_id,
            actor_type="user",
            actor_id=actor.actor_id,
            source_type="voice",
            source_id=source_id,
            event_type="voice.transcribe.failed",
            level="warning",
            payload={"message": message, "code": "VOICE_ASR_FAILED", "diagnostics": diagnostics},
        )
        db.commit()
        raise _voice_error(502, message, "VOICE_ASR_FAILED", diagnostics) from None
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="voice",
        source_id=source_id,
        event_type="voice.transcribe",
        payload={"text_length": len(text), "diagnostics": diagnostics},
    )
    db.commit()
    return {"text": text, "diagnostics": diagnostics}


@router.post("/api/voice/stream-auth", response_model=VoiceStreamAuthOut)
async def create_voice_stream_auth(
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
) -> dict[str, object]:
    source_id = f"voice-stream-{uuid.uuid4().hex}"
    uid = actor.actor_id or "agenthub"
    provider = voice_asr.diagnostics_provider()
    provider_label = voice_asr.provider_label()
    try:
        payload = await voice_asr.issue_stream_auth(uid=uid)
    except RuntimeError as exc:
        message = str(exc)
        error_code = "VOICE_STREAM_UNAVAILABLE" if "does not support streaming auth" in message else "VOICE_STREAM_AUTH_FAILED"
        status_code = 503 if ("not configured" in message or error_code == "VOICE_STREAM_UNAVAILABLE") else 502
        write_event(
            db,
            space_id=actor.space_id,
            actor_type="user",
            actor_id=actor.actor_id,
            source_type="voice",
            source_id=source_id,
            event_type="voice.stream_auth.failed",
            level="warning",
            payload={"message": message, "code": error_code, "provider": provider},
        )
        db.commit()
        raise HTTPException(status_code=status_code, detail={"message": message, "code": error_code}) from None
    except httpx.TimeoutException:
        message = f"{provider_label} token timed out"
        write_event(
            db,
            space_id=actor.space_id,
            actor_type="user",
            actor_id=actor.actor_id,
            source_type="voice",
            source_id=source_id,
            event_type="voice.stream_auth.failed",
            level="warning",
            payload={"message": message, "code": "VOICE_STREAM_AUTH_TIMEOUT"},
        )
        db.commit()
        raise HTTPException(status_code=504, detail={"message": message, "code": "VOICE_STREAM_AUTH_TIMEOUT"}) from None
    except httpx.HTTPStatusError as exc:
        message = _asr_http_error_message(exc, provider_label=f"{provider_label} token")
        write_event(
            db,
            space_id=actor.space_id,
            actor_type="user",
            actor_id=actor.actor_id,
            source_type="voice",
            source_id=source_id,
            event_type="voice.stream_auth.failed",
            level="warning",
            payload={"message": message, "code": "VOICE_STREAM_AUTH_FAILED"},
        )
        db.commit()
        raise HTTPException(status_code=502, detail={"message": message, "code": "VOICE_STREAM_AUTH_FAILED"}) from None
    except httpx.RequestError as exc:
        message = f"{provider_label} token request failed: {type(exc).__name__}"
        write_event(
            db,
            space_id=actor.space_id,
            actor_type="user",
            actor_id=actor.actor_id,
            source_type="voice",
            source_id=source_id,
            event_type="voice.stream_auth.failed",
            level="warning",
            payload={"message": message, "code": "VOICE_STREAM_AUTH_FAILED"},
        )
        db.commit()
        raise HTTPException(status_code=502, detail={"message": message, "code": "VOICE_STREAM_AUTH_FAILED"}) from None
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="voice",
        source_id=source_id,
        event_type="voice.stream_auth",
        payload={"expires_in_seconds": payload["expires_in_seconds"]},
    )
    db.commit()
    return payload
