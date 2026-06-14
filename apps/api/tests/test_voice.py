from __future__ import annotations

import base64
from types import SimpleNamespace
from typing import Any

import httpx
from fastapi.testclient import TestClient

from conftest import auth_headers, bootstrap_owner, create_worker, login
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
    assert response.json()["text"] == "继续优化 UI"
    assert calls == {"audio_bytes": b"fake-audio", "audio_format": "wav", "language": "zh-CN"}


def test_voice_transcribe_returns_recording_diagnostics(
    client: TestClient,
    monkeypatch,
) -> None:
    bootstrap_owner(client)
    owner_login = login(client)

    async def fake_transcribe_audio_bytes(audio_bytes: bytes, *, audio_format: str, language: str | None = None) -> str:
        return "带诊断的语音"

    monkeypatch.setattr(doubao_asr, "transcribe_audio_bytes", fake_transcribe_audio_bytes)

    response = client.post(
        "/api/voice/transcribe",
        json={
            "filename": "voice.wav",
            "content_type": "audio/wav",
            "data_base64": base64.b64encode(b"fake-audio").decode("ascii"),
            "language": "zh-CN",
            "duration_ms": 2345,
            "chunk_count": 7,
        },
        headers=auth_headers(owner_login),
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "text": "带诊断的语音",
        "diagnostics": {
            "filename": "voice.wav",
            "content_type": "audio/wav",
            "input_format": "wav",
            "asr_format": "wav",
            "input_bytes": len(b"fake-audio"),
            "prepared_bytes": len(b"fake-audio"),
            "duration_ms": 2345,
            "chunk_count": 7,
        },
    }


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
    assert response.json()["text"] == "转码后的语音"
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
            "diagnostics": {
                "filename": "voice.wav",
                "content_type": "audio/wav",
                "input_format": "wav",
                "asr_format": "wav",
                "input_bytes": len(b"fake-audio"),
                "prepared_bytes": len(b"fake-audio"),
                "duration_ms": None,
                "chunk_count": None,
            },
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
        "detail": {
            "message": "Voice ASR timed out",
            "code": "VOICE_ASR_TIMEOUT",
            "diagnostics": {
                "filename": "voice.wav",
                "content_type": "audio/wav",
                "input_format": "wav",
                "asr_format": "wav",
                "input_bytes": len(b"fake-audio"),
                "prepared_bytes": len(b"fake-audio"),
                "duration_ms": None,
                "chunk_count": None,
            },
        }
    }


def test_voice_stream_auth_returns_streaming_config(client: TestClient, monkeypatch) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    calls: dict[str, object] = {}

    async def fake_issue_stream_auth(*, uid: str) -> dict[str, object]:
        calls["uid"] = uid
        return {
            "url": "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
            "auth": {
                "api_resource_id": "volc.bigasr.sauc.duration",
                "api_app_key": "app-key",
                "api_access_key": "Jwt; token-123",
            },
            "config": {
                "user": {"uid": uid},
                "audio": {"format": "pcm", "rate": 16000, "bits": 16, "channel": 1},
                "request": {"model_name": "bigmodel", "show_utterances": True},
            },
            "expires_in_seconds": 300,
        }

    monkeypatch.setattr(doubao_asr, "issue_stream_auth", fake_issue_stream_auth)

    response = client.post("/api/voice/stream-auth", headers=auth_headers(owner_login))

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["url"] == "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"
    assert payload["auth"]["api_access_key"] == "Jwt; token-123"
    assert payload["config"]["request"]["model_name"] == "bigmodel"
    assert payload["expires_in_seconds"] == 300
    assert calls["uid"]


def test_voice_stream_auth_reports_missing_credentials_without_500(client: TestClient, monkeypatch) -> None:
    bootstrap_owner(client)
    owner_login = login(client)

    async def fake_issue_stream_auth(*, uid: str) -> dict[str, object]:
        raise RuntimeError("Doubao streaming ASR credentials are not configured")

    monkeypatch.setattr(doubao_asr, "issue_stream_auth", fake_issue_stream_auth)

    response = client.post("/api/voice/stream-auth", headers=auth_headers(owner_login))

    assert response.status_code == 503, response.text
    assert response.json() == {
        "detail": {
            "message": "Doubao streaming ASR credentials are not configured",
            "code": "VOICE_STREAM_AUTH_FAILED",
        }
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


def test_voice_transcribe_can_use_openai_compatible_whisper_provider(client: TestClient, monkeypatch) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    calls: dict[str, Any] = {}

    monkeypatch.setattr(
        "app.routers.voice.get_settings",
        lambda: SimpleNamespace(
            max_voice_audio_bytes=12 * 1024 * 1024,
            voice_asr_provider="openai",
            openai_asr_api_key="asr-key",
            openai_asr_base_url="https://voice.example.test/v1",
            openai_asr_model="whisper-large-v3",
        ),
    )

    class FakeAsyncClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            calls["client_kwargs"] = kwargs

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, *args: Any) -> None:
            return None

        async def post(self, url: str, *, headers: dict[str, str], files: dict[str, Any], data: dict[str, str]) -> httpx.Response:
            calls["url"] = url
            calls["headers"] = headers
            calls["data"] = data
            calls["file"] = files["file"]
            request = httpx.Request("POST", url)
            return httpx.Response(200, request=request, json={"text": "Whisper 识别结果"})

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeAsyncClient)

    response = client.post(
        "/api/voice/transcribe",
        json={
            "filename": "voice.webm",
            "content_type": "audio/webm",
            "data_base64": base64.b64encode(b"webm-audio").decode("ascii"),
            "language": "zh-CN",
        },
        headers=auth_headers(owner_login),
    )

    assert response.status_code == 200, response.text
    assert response.json()["text"] == "Whisper 识别结果"
    assert calls["url"] == "https://voice.example.test/v1/audio/transcriptions"
    assert calls["headers"] == {"Authorization": "Bearer asr-key"}
    assert calls["data"] == {"model": "whisper-large-v3", "language": "zh-CN"}
    assert calls["file"] == ("voice.webm", b"webm-audio", "audio/webm")


def test_voice_turn_can_send_input_to_selected_session(client: TestClient, monkeypatch) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    create_worker(client)
    session_response = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "sess-voice",
            "backend": "codex",
            "worker_id": "win-main",
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-voice.jsonl",
            "status": "ready",
            "title": "Voice target",
            "last_message": "等你回复",
        },
    )
    assert session_response.status_code == 200, session_response.text

    async def fake_decide(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "spoken_text": "我会发给当前会话。",
            "tool_calls": [
                {
                    "name": "send_session_input",
                    "arguments": {
                        "session_id": "sess-voice",
                        "prompt": "请总结当前进展",
                        "reply_mode": "direct",
                    },
                }
            ],
        }

    monkeypatch.setattr("app.routers.voice.voice_agent.decide", fake_decide)

    response = client.post(
        "/api/voice/turn",
        headers=headers,
        json={"session_id": "sess-voice", "utterance": "帮我问一下当前进展", "source": "web"},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["spoken_text"] == "我会发给当前会话。"
    assert payload["actions"][0]["tool"] == "send_session_input"
    assert payload["actions"][0]["status"] == "ok"
    assert payload["actions"][0]["job"]["kind"] == "session_input"
    assert payload["actions"][0]["job"]["payload"]["prompt"] == "请总结当前进展"


def test_voice_turn_can_answer_pending_user_choice(client: TestClient, monkeypatch) -> None:
    bootstrap_owner(client)
    owner_login = login(client)
    headers = auth_headers(owner_login)
    worker_payload = create_worker(client)
    worker_token = worker_payload["worker_token"]
    session_response = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "session_id": "sess-choice",
            "backend": "codex",
            "worker_id": "win-main",
            "workspace_root": "E:/work/AgentHub",
            "project_name": "AgentHub",
            "namespace": "default",
            "mode": "direct_reply",
            "runtime_session_ref": "codex/sess-choice.jsonl",
            "status": "ready",
            "title": "Choice target",
        },
    )
    assert session_response.status_code == 200, session_response.text
    permission_response = client.post(
        "/api/internal/permissions/requested",
        headers={"Authorization": f"Bearer {worker_token}"},
        json={
            "worker_id": "win-main",
            "permission": {
                "session_id": "sess-choice",
                "backend": "codex",
                "kind": "question",
                "title": "对象存储",
                "description": "上传服务一阶段优先适配哪类对象存储？",
                "detail": {
                    "questions": [
                        {
                            "id": "storage",
                            "header": "对象存储",
                            "question": "上传服务一阶段优先适配哪类对象存储？",
                            "options": [
                                {"label": "S3兼容/MinIO (Recommended)", "description": "最通用"},
                                {"label": "阿里云 OSS", "description": "国内生产可用性强"},
                            ],
                        }
                    ]
                },
                "actions": {},
            },
        },
    )
    assert permission_response.status_code == 200, permission_response.text
    permission_id = permission_response.json()["permission"]["permission_id"]

    async def fake_decide(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "spoken_text": "已选择 S3 兼容方案。",
            "tool_calls": [
                {
                    "name": "respond_permission",
                    "arguments": {
                        "permission_id": permission_id,
                        "action": "answer",
                        "response": {
                            "answers": {
                                "storage": {
                                    "label": "S3兼容/MinIO (Recommended)",
                                    "description": "最通用",
                                }
                            }
                        },
                    },
                }
            ],
        }

    monkeypatch.setattr("app.routers.voice.voice_agent.decide", fake_decide)

    response = client.post(
        "/api/voice/turn",
        headers=headers,
        json={"session_id": "sess-choice", "utterance": "选第一个 S3 兼容", "source": "android"},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["actions"][0]["tool"] == "respond_permission"
    assert payload["actions"][0]["permission"]["status"] == "answered"
    jobs_response = client.get("/api/jobs", headers=headers)
    assert jobs_response.status_code == 200, jobs_response.text
    assert any(job["payload"].get("answered_permission_id") == permission_id for job in jobs_response.json()["items"])
