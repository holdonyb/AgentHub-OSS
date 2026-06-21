from __future__ import annotations

import base64
import binascii
import io
import math
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
import wave

from app.core.audit import write_event
from app.core.json import loads_json
from app.core.config import get_settings
from app.core.deps import Actor, DbSession, require_min_role
from app.models import AgentPermission, AgentSession, AgentTimeline
from app.routers import permissions as permissions_router
from app.routers import sessions as sessions_router
from app.schemas import PermissionRespondIn, SessionBtwIn, SessionInputIn, VoiceStreamAuthOut, VoiceTranscribeIn, VoiceTranscribeOut, VoiceTurnIn, VoiceTurnOut
from app.services import doubao_asr, openai_asr, permission_out, session_summary_out
from app.voice_agent import VoiceAgentError, voice_agent

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
QUIET_WAV_PEAK_THRESHOLD = 0.18
TARGET_WAV_PEAK = 0.52
MAX_WAV_GAIN_MULTIPLIER = 6.0


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


def _boost_quiet_wav(audio_bytes: bytes) -> tuple[bytes, float | None]:
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as reader:
            params = reader.getparams()
            if params.sampwidth != 2:
                return audio_bytes, None
            frame_bytes = reader.readframes(params.nframes)
    except wave.Error:
        return audio_bytes, None
    if not frame_bytes:
        return audio_bytes, None

    sample_count = len(frame_bytes) // 2
    if sample_count <= 0:
        return audio_bytes, None

    peak = 0.0
    samples: list[int] = []
    for index in range(0, len(frame_bytes), 2):
        sample = int.from_bytes(frame_bytes[index : index + 2], "little", signed=True)
        samples.append(sample)
        normalized = abs(sample) / 32767
        if normalized > peak:
            peak = normalized
    if peak <= 0 or peak >= QUIET_WAV_PEAK_THRESHOLD:
        return audio_bytes, None

    gain = min(MAX_WAV_GAIN_MULTIPLIER, TARGET_WAV_PEAK / peak)
    if gain <= 1.05:
        return audio_bytes, None

    boosted = bytearray()
    for sample in samples:
        value = int(round(sample * gain))
        if value > 32767:
            value = 32767
        elif value < -32768:
            value = -32768
        boosted.extend(int(value).to_bytes(2, "little", signed=True))

    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setparams(params)
        writer.writeframes(bytes(boosted))
    return output.getvalue(), round(20 * math.log10(gain), 1)


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


def _voice_diagnostics(
    payload: VoiceTranscribeIn,
    *,
    input_format: str,
    asr_format: str,
    input_bytes: int,
    prepared_bytes: int,
    gain_applied_db: float | None = None,
) -> dict[str, object]:
    return {
        "filename": payload.filename,
        "content_type": payload.content_type,
        "input_format": input_format,
        "asr_format": asr_format,
        "input_bytes": input_bytes,
        "prepared_bytes": prepared_bytes,
        "gain_applied_db": gain_applied_db,
        "duration_ms": payload.duration_ms,
        "chunk_count": payload.chunk_count,
    }


def _voice_error(status_code: int, message: str, code: str, diagnostics: dict[str, object]) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"message": message, "code": code, "diagnostics": diagnostics})


async def _transcribe_with_config(payload: VoiceTranscribeIn, source_audio_bytes: bytes, input_format: str) -> tuple[str, dict[str, object]]:
    settings = get_settings()
    provider = getattr(settings, "voice_asr_provider", "doubao")
    diagnostics: dict[str, object] = _voice_diagnostics(
        payload,
        input_format=input_format,
        asr_format=input_format,
        input_bytes=len(source_audio_bytes),
        prepared_bytes=len(source_audio_bytes),
    )
    if provider == "openai":
        text = await openai_asr.transcribe_audio_bytes(
            source_audio_bytes,
            filename=payload.filename,
            content_type=payload.content_type.split(";", 1)[0].strip().lower(),
            language=payload.language,
            api_key=(getattr(settings, "openai_asr_api_key", "") or getattr(settings, "openai_api_key", "")),
            base_url=getattr(settings, "openai_asr_base_url", "https://api.openai.com/v1"),
            model=getattr(settings, "openai_asr_model", "whisper-1"),
        )
        return text, diagnostics
    audio_bytes, audio_format = _prepare_audio_for_asr(source_audio_bytes, input_format)
    gain_applied_db: float | None = None
    if audio_format == "wav":
        audio_bytes, gain_applied_db = _boost_quiet_wav(audio_bytes)
    diagnostics = _voice_diagnostics(
        payload,
        input_format=input_format,
        asr_format=audio_format,
        input_bytes=len(source_audio_bytes),
        prepared_bytes=len(audio_bytes),
        gain_applied_db=gain_applied_db,
    )
    if len(audio_bytes) > settings.max_voice_audio_bytes:
        raise HTTPException(status_code=413, detail={"message": "Audio is too large", "code": "VOICE_TOO_LARGE"})
    text = await doubao_asr.transcribe_audio_bytes(
        audio_bytes,
        audio_format=audio_format,
        language=payload.language,
    )
    return text, diagnostics


def _voice_context(db: DbSession, actor: Actor, session_id: str | None) -> dict[str, Any]:
    selected_session = None
    if session_id:
        selected_session = (
            db.query(AgentSession)
            .filter(AgentSession.space_id == actor.space_id)
            .filter(AgentSession.session_id == session_id)
            .one_or_none()
        )
        if selected_session is None:
            raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
    pending_permissions = (
        db.query(AgentPermission)
        .filter(AgentPermission.space_id == actor.space_id)
        .filter(AgentPermission.status == "pending")
        .order_by(AgentPermission.created_at.desc())
        .limit(20)
        .all()
    )
    if selected_session is not None:
        timeline_rows = (
            db.query(AgentTimeline)
            .filter(AgentTimeline.space_id == actor.space_id)
            .filter(AgentTimeline.session_id == selected_session.session_id)
            .filter(AgentTimeline.text != "")
            .order_by(AgentTimeline.seq.desc())
            .limit(12)
            .all()
        )
    else:
        timeline_rows = []
    return {
        "selected_session": session_summary_out(selected_session) if selected_session is not None else None,
        "pending_permissions": [permission_out(row) for row in pending_permissions],
        "latest_timeline": [
            {
                "seq": row.seq,
                "item_type": row.item_type,
                "role": row.role,
                "text": " ".join(row.text.split())[:1200],
                "payload": loads_json(row.payload_json, {}),
            }
            for row in reversed(timeline_rows)
        ],
    }


def _require_tool_session_id(arguments: dict[str, Any], selected_session_id: str | None) -> str:
    session_id = str(arguments.get("session_id") or selected_session_id or "").strip()
    if not session_id:
        raise HTTPException(status_code=400, detail={"message": "Voice tool requires a session", "code": "VOICE_TOOL_SESSION_REQUIRED"})
    return session_id


def _execute_voice_tool(
    *,
    name: str,
    arguments: dict[str, Any],
    selected_session_id: str | None,
    db: DbSession,
    actor: Actor,
) -> dict[str, Any]:
    if name == "read_session_state":
        session_id = _require_tool_session_id(arguments, selected_session_id)
        session = (
            db.query(AgentSession)
            .filter(AgentSession.space_id == actor.space_id)
            .filter(AgentSession.session_id == session_id)
            .one_or_none()
        )
        if session is None:
            raise HTTPException(status_code=404, detail={"message": "Session not found", "code": "SESSION_NOT_FOUND"})
        return {"tool": name, "status": "ok", "session": session_summary_out(session)}
    if name == "send_session_input":
        session_id = _require_tool_session_id(arguments, selected_session_id)
        prompt = str(arguments.get("prompt") or "").strip()
        reply_mode = str(arguments.get("reply_mode") or "direct").strip()
        if reply_mode not in {"direct", "plan"}:
            reply_mode = "direct"
        result = sessions_router.send_session_input(
            session_id,
            SessionInputIn(prompt=prompt, reply_mode=reply_mode),
            db=db,
            actor=actor,
        )
        return {"tool": name, "status": "ok", **result}
    if name == "respond_permission":
        permission_id = str(arguments.get("permission_id") or "").strip()
        if not permission_id:
            raise HTTPException(status_code=400, detail={"message": "Voice tool requires a permission", "code": "VOICE_TOOL_PERMISSION_REQUIRED"})
        action = str(arguments.get("action") or "answer").strip()
        if action not in {"allow", "deny", "answer", "edit_and_allow"}:
            action = "answer"
        response = arguments.get("response")
        result = permissions_router.respond_permission(
            permission_id,
            PermissionRespondIn(action=action, response=response if isinstance(response, dict) else {}),
            db=db,
            actor=actor,
        )
        return {"tool": name, "status": "ok", **result}
    if name == "create_btw":
        session_id = _require_tool_session_id(arguments, selected_session_id)
        prompt = str(arguments.get("prompt") or "").strip()
        title = str(arguments.get("title") or "").strip() or None
        result = sessions_router.btw_session(session_id, SessionBtwIn(prompt=prompt, title=title), db=db, actor=actor)
        return {"tool": name, "status": "ok", **result}
    raise HTTPException(status_code=400, detail={"message": "Voice tool is not allowed", "code": "VOICE_TOOL_NOT_ALLOWED"})


@router.post("/api/voice/transcribe", response_model=VoiceTranscribeOut)
async def transcribe_voice(
    payload: VoiceTranscribeIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
) -> dict[str, object]:
    source_id = f"voice-{uuid.uuid4().hex}"
    input_format = _audio_format(payload)
    try:
        source_audio_bytes = base64.b64decode(payload.data_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail={"message": "Invalid audio data", "code": "VOICE_INVALID"}) from None
    if not source_audio_bytes:
        raise HTTPException(status_code=400, detail={"message": "Audio cannot be empty", "code": "VOICE_EMPTY"})
    settings = get_settings()
    if len(source_audio_bytes) > settings.max_voice_audio_bytes:
        raise HTTPException(status_code=413, detail={"message": "Audio is too large", "code": "VOICE_TOO_LARGE"})
    diagnostics: dict[str, object] = _voice_diagnostics(
        payload,
        input_format=input_format,
        asr_format=input_format,
        input_bytes=len(source_audio_bytes),
        prepared_bytes=len(source_audio_bytes),
    )
    try:
        text, diagnostics = await _transcribe_with_config(payload, source_audio_bytes, input_format)
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
        message = "Voice ASR timed out"
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
        message = _asr_http_error_message(exc)
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
        message = f"Voice ASR request failed: {type(exc).__name__}"
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


@router.post("/api/voice/turn", response_model=VoiceTurnOut)
async def create_voice_turn(
    payload: VoiceTurnIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
) -> dict[str, object]:
    source_id = f"voice-turn-{uuid.uuid4().hex}"
    utterance = payload.utterance.strip()
    context = _voice_context(db, actor, payload.session_id)
    try:
        decision = await voice_agent.decide(utterance=utterance, context=context, source=payload.source)
    except VoiceAgentError as exc:
        message = str(exc)
        write_event(
            db,
            space_id=actor.space_id,
            actor_type="user",
            actor_id=actor.actor_id,
            source_type="voice",
            source_id=source_id,
            event_type="voice.turn.failed",
            level="warning",
            payload={"message": message, "code": "VOICE_AGENT_FAILED"},
        )
        db.commit()
        raise HTTPException(status_code=503, detail={"message": message, "code": "VOICE_AGENT_FAILED"}) from None
    except httpx.TimeoutException:
        message = "Voice agent provider timed out"
        write_event(
            db,
            space_id=actor.space_id,
            actor_type="user",
            actor_id=actor.actor_id,
            source_type="voice",
            source_id=source_id,
            event_type="voice.turn.failed",
            level="warning",
            payload={"message": message, "code": "VOICE_AGENT_TIMEOUT"},
        )
        db.commit()
        raise HTTPException(status_code=504, detail={"message": message, "code": "VOICE_AGENT_TIMEOUT"}) from None
    except httpx.HTTPStatusError as exc:
        message = f"Voice agent provider HTTP {exc.response.status_code if exc.response else 'error'}"
        write_event(
            db,
            space_id=actor.space_id,
            actor_type="user",
            actor_id=actor.actor_id,
            source_type="voice",
            source_id=source_id,
            event_type="voice.turn.failed",
            level="warning",
            payload={"message": message, "code": "VOICE_AGENT_FAILED"},
        )
        db.commit()
        raise HTTPException(status_code=502, detail={"message": message, "code": "VOICE_AGENT_FAILED"}) from None
    tool_calls = decision.get("tool_calls") if isinstance(decision, dict) else []
    actions: list[dict[str, Any]] = []
    failed = False
    if isinstance(tool_calls, list):
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            name = str(call.get("name") or "").strip()
            arguments = call.get("arguments")
            if not isinstance(arguments, dict):
                arguments = {}
            try:
                action = _execute_voice_tool(
                    name=name,
                    arguments=arguments,
                    selected_session_id=payload.session_id,
                    db=db,
                    actor=actor,
                )
            except HTTPException as exc:
                failed = True
                detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
                action = {"tool": name, "status": "failed", "error": detail}
            actions.append(action)
            write_event(
                db,
                space_id=actor.space_id,
                actor_type="user",
                actor_id=actor.actor_id,
                source_type="voice",
                source_id=source_id,
                event_type="voice.tool_call",
                payload={"tool": name, "status": action.get("status")},
            )
            db.commit()
    spoken_text = str(decision.get("spoken_text") or "").strip() if isinstance(decision, dict) else ""
    status = "failed" if failed and actions and all(action.get("status") == "failed" for action in actions) else "partial" if failed else "ok"
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="voice",
        source_id=source_id,
        event_type="voice.turn",
        payload={"source": payload.source, "utterance_length": len(utterance), "action_count": len(actions), "status": status},
    )
    db.commit()
    return {"spoken_text": spoken_text or "已处理。", "actions": actions, "status": status}


@router.post("/api/voice/stream-auth", response_model=VoiceStreamAuthOut)
async def create_voice_stream_auth(
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
) -> dict[str, object]:
    source_id = f"voice-stream-{uuid.uuid4().hex}"
    uid = actor.actor_id or "agenthub"
    try:
        payload = await doubao_asr.issue_stream_auth(uid=uid)
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
            event_type="voice.stream_auth.failed",
            level="warning",
            payload={"message": message, "code": "VOICE_STREAM_AUTH_FAILED"},
        )
        db.commit()
        raise HTTPException(status_code=status_code, detail={"message": message, "code": "VOICE_STREAM_AUTH_FAILED"}) from None
    except httpx.TimeoutException:
        message = "Doubao streaming ASR token timed out"
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
        message = _asr_http_error_message(exc).replace("Doubao ASR", "Doubao streaming ASR token")
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
        message = f"Doubao streaming ASR token request failed: {type(exc).__name__}"
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
