from __future__ import annotations

import base64
import binascii
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException

from app.core.config import get_settings
from app.core.deps import Actor, require_min_role
from app.schemas import VoiceTranscribeIn, VoiceTranscribeOut
from app.services import doubao_asr

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


def _prepare_audio_for_asr(audio_bytes: bytes, audio_format: str) -> tuple[bytes, str]:
    if audio_format in DOUBAO_STANDARD_AUDIO_FORMATS:
        return audio_bytes, audio_format
    if audio_format in TRANSCODABLE_AUDIO_FORMATS:
        return _transcode_audio_to_wav(audio_bytes, audio_format), "wav"
    raise HTTPException(status_code=400, detail={"message": "Unsupported audio type", "code": "VOICE_TYPE"})


def _asr_http_error_message(exc: httpx.HTTPStatusError) -> str:
    reason = exc.response.reason_phrase.strip() if exc.response else ""
    suffix = f" {reason}" if reason else ""
    if not exc.response:
        return "Doubao ASR HTTP error"
    provider_code = exc.response.headers.get("X-Api-Status-Code", "").strip()
    provider_message = exc.response.headers.get("X-Api-Message", "").strip()
    provider_detail = ""
    if provider_code:
        provider_detail = f" ({provider_code})"
    if provider_message:
        provider_detail = f"{provider_detail}: {provider_message[:180]}"
    return f"Doubao ASR HTTP {exc.response.status_code}{suffix}{provider_detail}"


@router.post("/api/voice/transcribe", response_model=VoiceTranscribeOut)
async def transcribe_voice(
    payload: VoiceTranscribeIn,
    actor: Actor = Depends(require_min_role("operator")),
) -> dict[str, str]:
    del actor
    audio_format = _audio_format(payload)
    try:
        audio_bytes = base64.b64decode(payload.data_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail={"message": "Invalid audio data", "code": "VOICE_INVALID"}) from None
    if not audio_bytes:
        raise HTTPException(status_code=400, detail={"message": "Audio cannot be empty", "code": "VOICE_EMPTY"})
    if len(audio_bytes) > get_settings().max_voice_audio_bytes:
        raise HTTPException(status_code=413, detail={"message": "Audio is too large", "code": "VOICE_TOO_LARGE"})
    try:
        audio_bytes, audio_format = _prepare_audio_for_asr(audio_bytes, audio_format)
        if len(audio_bytes) > get_settings().max_voice_audio_bytes:
            raise HTTPException(status_code=413, detail={"message": "Audio is too large", "code": "VOICE_TOO_LARGE"})
        text = await doubao_asr.transcribe_audio_bytes(
            audio_bytes,
            audio_format=audio_format,
            language=payload.language,
        )
    except RuntimeError as exc:
        message = str(exc)
        status_code = 503 if "not configured" in message else 502
        raise HTTPException(status_code=status_code, detail={"message": message, "code": "VOICE_ASR_FAILED"}) from None
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail={"message": "Doubao ASR timed out", "code": "VOICE_ASR_TIMEOUT"},
        ) from None
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail={"message": _asr_http_error_message(exc), "code": "VOICE_ASR_FAILED"},
        ) from None
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail={"message": f"Doubao ASR request failed: {type(exc).__name__}", "code": "VOICE_ASR_FAILED"},
        ) from None
    return {"text": text}
