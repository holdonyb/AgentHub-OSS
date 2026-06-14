from __future__ import annotations

import json
import re
from typing import Any

import httpx

from app.core.config import get_settings


VOICE_TOOL_NAMES = {
    "read_session_state",
    "send_session_input",
    "respond_permission",
    "create_btw",
}


class VoiceAgentError(RuntimeError):
    pass


def _extract_json_object(value: str) -> dict[str, Any]:
    raw = value.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise VoiceAgentError("Voice agent provider returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise VoiceAgentError("Voice agent provider returned a non-object payload")
    return parsed


def _normalize_tool_call(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    name = str(value.get("name") or value.get("tool") or "").strip()
    if name not in VOICE_TOOL_NAMES:
        return None
    arguments = value.get("arguments")
    if not isinstance(arguments, dict):
        arguments = {}
    return {"name": name, "arguments": arguments}


class AgentHubVoiceAgent:
    async def decide(
        self,
        *,
        utterance: str,
        context: dict[str, Any],
        source: str,
    ) -> dict[str, Any]:
        settings = get_settings()
        if settings.voice_agent_provider == "disabled":
            raise VoiceAgentError("Voice agent provider is disabled")
        api_key = (settings.voice_agent_api_key or settings.openai_api_key).strip()
        if not api_key:
            raise VoiceAgentError("Voice agent provider credentials are not configured")
        model = settings.voice_agent_model.strip()
        if not model:
            raise VoiceAgentError("Voice agent model is not configured")
        base_url = (settings.voice_agent_base_url or "https://api.openai.com/v1").strip().rstrip("/")
        system_prompt = (
            "You are AgentHub's voice control planner. Return strict JSON only.\n"
            "Available tools:\n"
            "- read_session_state({session_id?})\n"
            "- send_session_input({session_id?, prompt, reply_mode?})\n"
            "- respond_permission({permission_id, action, response})\n"
            "- create_btw({session_id?, prompt, title?})\n"
            "Never invent tools. Never execute shell commands. Keep spoken_text short.\n"
            "If the user asks to answer an approval/question, use respond_permission with the visible pending permission.\n"
            "If the user asks to send work to the selected session, use send_session_input.\n"
            "JSON shape: {\"spoken_text\":\"...\", \"tool_calls\":[{\"name\":\"...\",\"arguments\":{...}}]}."
        )
        user_payload = {
            "source": source,
            "utterance": utterance,
            "context": context,
        }
        request_payload = {
            "model": model,
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
        }
        async with httpx.AsyncClient(timeout=settings.voice_agent_timeout_seconds) as client:
            response = await client.post(
                f"{base_url}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=request_payload,
            )
            response.raise_for_status()
        body = response.json()
        choices = body.get("choices") if isinstance(body, dict) else None
        message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
        content = str(message.get("content") or "").strip() if isinstance(message, dict) else ""
        if not content:
            raise VoiceAgentError("Voice agent provider returned empty content")
        decision = _extract_json_object(content)
        spoken_text = str(decision.get("spoken_text") or "").strip()
        tool_calls = [_normalize_tool_call(item) for item in decision.get("tool_calls", []) if isinstance(decision.get("tool_calls"), list)]
        normalized_calls = [item for item in tool_calls if item is not None]
        if not spoken_text and not normalized_calls:
            raise VoiceAgentError("Voice agent provider returned no action")
        return {
            "spoken_text": spoken_text or "已处理。",
            "tool_calls": normalized_calls,
        }


voice_agent = AgentHubVoiceAgent()
