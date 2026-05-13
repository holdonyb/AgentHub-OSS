from __future__ import annotations

import base64
from types import SimpleNamespace

import httpx
from fastapi.testclient import TestClient

from conftest import auth_headers, bootstrap_owner, login
from app.services import DoubaoAsrFacade, doubao_asr


def test_voice_transcribe_accepts_base64_audio_and_returns_text(
    client: TestClient,
    monkeypatch,
) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    calls: dict[str, object] = {}

    async def fake_transcribe_audio_bytes(audio_bytes: bytes, *, audio_format: str, language: str | None = None) -> str:
        calls["audio_bytes"] = audio_bytes
        calls["audio_format"] = audio_format
        calls["language"] = language
        return "继续优化 UI"

    monkeypatch.setattr(doubao_asr, "transcribe_audio_bytes", fake_transcribe_audio_bytes)

    response = client.post(
        "/api/voice/transcribe",
        json={
            "filename": "voice.wav",
            "content_type": "audio/wav",
            "data_base64": base64.b64encode(b"fake-audio").decode("ascii"),
            "language": "zh-CN",
        },
        headers=auth_headers(owner_login),
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"text": "继续优化 UI"}
    assert calls == {"audio_bytes": b"fake-audio", "audio_format": "wav", "language": "zh-CN"}


def test_voice_transcribe_transcodes_webm_to_wav_for_doubao_standard_model(
    client: TestClient,
    monkeypatch,
) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    calls: dict[str, object] = {}

    def fake_transcode_audio_to_wav(audio_bytes: bytes, source_format: str) -> bytes:
        calls["source_audio_bytes"] = audio_bytes
        calls["source_format"] = source_format
        return b"wav-audio"

    async def fake_transcribe_audio_bytes(audio_bytes: bytes, *, audio_format: str, language: str | None = None) -> str:
        calls["audio_bytes"] = audio_bytes
        calls["audio_format"] = audio_format
        calls["language"] = language
        return "转码后的语音"

    monkeypatch.setattr("app.routers.voice._transcode_audio_to_wav", fake_transcode_audio_to_wav)
    monkeypatch.setattr(doubao_asr, "transcribe_audio_bytes", fake_transcribe_audio_bytes)

    response = client.post(
        "/api/voice/transcribe",
        json={
            "filename": "voice.webm",
            "content_type": "audio/webm",
            "data_base64": base64.b64encode(b"fake-audio").decode("ascii"),
            "language": "zh-CN",
        },
        headers=auth_headers(owner_login),
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"text": "转码后的语音"}
    assert calls == {
        "source_audio_bytes": b"fake-audio",
        "source_format": "webm",
        "audio_bytes": b"wav-audio",
        "audio_format": "wav",
        "language": "zh-CN",
    }


def test_voice_transcribe_reports_provider_http_errors_without_500(
    client: TestClient,
    monkeypatch,
) -> None:
    bootstrap_owner(client)
    owner_login = login(client)

    async def fake_transcribe_audio_bytes(audio_bytes: bytes, *, audio_format: str, language: str | None = None) -> str:
        request = httpx.Request("POST", "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash")
        response = httpx.Response(
            403,
            request=request,
            headers={
                "X-Api-Status-Code": "45000030",
                "X-Api-Message": "[resource_id=volc.bigasr.auc_turbo] requested resource not granted",
            },
        )
        raise httpx.HTTPStatusError("403 forbidden", request=request, response=response)

    monkeypatch.setattr(doubao_asr, "transcribe_audio_bytes", fake_transcribe_audio_bytes)

    response = client.post(
        "/api/voice/transcribe",
        json={
            "filename": "voice.wav",
            "content_type": "audio/wav",
            "data_base64": base64.b64encode(b"fake-audio").decode("ascii"),
            "language": "zh-CN",
        },
        headers=auth_headers(owner_login),
    )

    assert response.status_code == 502, response.text
    assert response.json() == {
        "detail": {
            "message": (
                "Doubao ASR HTTP 403 Forbidden (45000030): "
                "[resource_id=volc.bigasr.auc_turbo] requested resource not granted"
            ),
            "code": "VOICE_ASR_FAILED",
        }
    }


def test_voice_transcribe_reports_provider_timeout_without_500(
    client: TestClient,
    monkeypatch,
) -> None:
    bootstrap_owner(client)
    owner_login = login(client)

    async def fake_transcribe_audio_bytes(audio_bytes: bytes, *, audio_format: str, language: str | None = None) -> str:
        raise httpx.ReadTimeout("timed out")

    monkeypatch.setattr(doubao_asr, "transcribe_audio_bytes", fake_transcribe_audio_bytes)

    response = client.post(
        "/api/voice/transcribe",
        json={
            "filename": "voice.wav",
            "content_type": "audio/wav",
            "data_base64": base64.b64encode(b"fake-audio").decode("ascii"),
            "language": "zh-CN",
        },
        headers=auth_headers(owner_login),
    )

    assert response.status_code == 504, response.text
    assert response.json() == {
        "detail": {"message": "Doubao ASR timed out", "code": "VOICE_ASR_TIMEOUT"}
    }


def test_doubao_asr_uses_recording_file_2_submit_query_with_api_key(monkeypatch) -> None:
    facade = DoubaoAsrFacade()
    calls: dict[str, object] = {}
    monkeypatch.setattr(
        "app.services.get_settings",
        lambda: SimpleNamespace(
            doubao_asr_api_key="api-key",
            doubao_asr_app_key="",
            doubao_asr_access_key="",
            doubao_asr_endpoint="https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
            doubao_asr_resource_id="volc.seedasr.auc",
        ),
    )

    async def fail_flash(*args, **kwargs) -> str:
        raise AssertionError("standard recording-file ASR must not call flash endpoint")

    async def fake_submit_query(
        audio_bytes: bytes,
        *,
        audio_format: str,
        language: str | None,
        api_key: str,
        app_key: str,
        access_key: str,
        resource_id: str,
    ) -> str:
        calls.update(
            {
                "audio_bytes": audio_bytes,
                "audio_format": audio_format,
                "language": language,
                "api_key": api_key,
                "app_key": app_key,
                "access_key": access_key,
                "resource_id": resource_id,
            }
        )
        return "大模型 2.0"

    monkeypatch.setattr(facade, "_transcribe_flash", fail_flash)
    monkeypatch.setattr(facade, "_transcribe_submit_query", fake_submit_query)

    import anyio

    async def run_transcribe() -> str:
        return await facade.transcribe_audio_bytes(b"wav-audio", audio_format="wav", language="zh-CN")

    text = anyio.run(run_transcribe)

    assert text == "大模型 2.0"
    assert calls == {
        "audio_bytes": b"wav-audio",
        "audio_format": "wav",
        "language": "zh-CN",
        "api_key": "api-key",
        "app_key": "",
        "access_key": "",
        "resource_id": "volc.seedasr.auc",
    }
