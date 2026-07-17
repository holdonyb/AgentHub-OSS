from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import hmac
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

import httpx


ConnectionMode = Literal["private", "public_relay"]


@dataclass
class AgentHubClient:
    base_url: str
    worker_id: str
    worker_token: str
    mode: ConnectionMode = "private"
    timeout: float = 30.0
    trust_env: bool = False
    _client: httpx.Client = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._client = httpx.Client(timeout=self.timeout, trust_env=self.trust_env)

    def _headers(self) -> dict[str, str]:
        if not self.worker_token.strip():
            return {}
        return {"Authorization": f"Bearer {self.worker_token}"}

    def _post(self, path: str, *, json: dict[str, Any], headers: dict[str, str] | None = None) -> httpx.Response:
        return self._client.post(
            f"{self.base_url}{path}",
            json=json,
            headers=headers if headers is not None else self._headers(),
        )

    def _get(self, path: str, *, headers: dict[str, str] | None = None) -> httpx.Response:
        return self._client.get(
            f"{self.base_url}{path}",
            headers=headers if headers is not None else self._headers(),
        )

    def close(self) -> None:
        self._client.close()

    def _worker_path(self, private_path: str, public_path: str) -> str:
        return public_path if self.mode == "public_relay" else private_path

    def register(self, payload: dict[str, Any], registration_token: str) -> dict[str, Any]:
        response = self._post(
            "/api/workers/register",
            json=payload,
            headers={"Authorization": f"Bearer {registration_token}"},
        )
        response.raise_for_status()
        return response.json()

    def enroll(self, payload: dict[str, Any]) -> dict[str, Any]:
        response = self._post("/api/worker/enroll", json=payload)
        response.raise_for_status()
        return response.json()

    def heartbeat(self, payload: dict[str, Any]) -> dict[str, Any]:
        path = self._worker_path(f"/api/workers/{self.worker_id}/heartbeat", "/api/worker/heartbeat")
        response = self._post(path, json=payload)
        response.raise_for_status()
        return response.json()

    def claim_job(self) -> dict[str, Any] | None:
        path = self._worker_path("/api/internal/jobs/claim", "/api/worker/jobs/claim")
        response = self._post(path, json={"worker_id": self.worker_id})
        if response.status_code == 204:
            return None
        response.raise_for_status()
        return response.json()["job"]

    def complete_job(self, job_id: str, result_text: str) -> None:
        path = self._worker_path(f"/api/internal/jobs/{job_id}/complete", f"/api/worker/jobs/{job_id}/complete")
        response = self._post(path, json={"worker_id": self.worker_id, "result_text": result_text})
        response.raise_for_status()

    def fail_job(self, job_id: str, error_text: str) -> None:
        path = self._worker_path(f"/api/internal/jobs/{job_id}/fail", f"/api/worker/jobs/{job_id}/fail")
        response = self._post(path, json={"worker_id": self.worker_id, "error_text": error_text})
        response.raise_for_status()

    def upload_transfer(
        self,
        transfer_id: str,
        path: Path,
        *,
        content_type: str,
        filename: str,
        modified_at: str,
    ) -> dict[str, Any]:
        endpoint = self._worker_path(
            f"/api/internal/transfers/{transfer_id}/content",
            f"/api/worker/transfers/{transfer_id}/content",
        )
        headers = {
            **self._headers(),
            "Content-Type": content_type,
            "Content-Length": str(path.stat().st_size),
            "X-AgentHub-Filename": quote(filename, safe=""),
            "X-AgentHub-Modified-At": modified_at,
        }
        with path.open("rb") as stream:
            response = self._client.put(f"{self.base_url}{endpoint}", content=stream, headers=headers)
        response.raise_for_status()
        payload = response.json().get("transfer", {})
        return payload if isinstance(payload, dict) else {}

    def download_transfer(self, transfer_id: str, destination: Path) -> dict[str, Any]:
        endpoint = self._worker_path(
            f"/api/internal/transfers/{transfer_id}/content",
            f"/api/worker/transfers/{transfer_id}/content",
        )
        digest = hashlib.sha256()
        size_bytes = 0
        with self._client.stream("GET", f"{self.base_url}{endpoint}", headers=self._headers()) as response:
            response.raise_for_status()
            expected_sha256 = response.headers.get("X-AgentHub-SHA256", "").strip().lower()
            if len(expected_sha256) != 64 or any(character not in "0123456789abcdef" for character in expected_sha256):
                raise ValueError("Downloaded file checksum metadata is missing or invalid")
            with destination.open("wb") as stream:
                for chunk in response.iter_bytes():
                    size_bytes += len(chunk)
                    digest.update(chunk)
                    stream.write(chunk)
        actual_sha256 = digest.hexdigest()
        if not hmac.compare_digest(actual_sha256, expected_sha256):
            destination.unlink(missing_ok=True)
            raise ValueError("Downloaded file checksum does not match transfer metadata")
        return {"size_bytes": size_bytes, "sha256": actual_sha256}

    def publish_sessions(self, sessions: list[dict[str, Any]]) -> None:
        path = self._worker_path("/api/internal/sessions/discovered", "/api/worker/sessions/discovered")
        response = self._post(path, json={"worker_id": self.worker_id, "sessions": sessions})
        response.raise_for_status()

    def publish_provider_snapshots(self, providers: list[dict[str, Any]]) -> None:
        path = self._worker_path("/api/internal/providers/snapshot", "/api/worker/providers/snapshot")
        response = self._post(path, json={"worker_id": self.worker_id, "providers": providers})
        response.raise_for_status()

    def publish_timeline(self, session_id: str, items: list[dict[str, Any]], *, replace: bool = False) -> None:
        path = self._worker_path(
            f"/api/internal/sessions/{session_id}/timeline",
            f"/api/worker/sessions/{session_id}/timeline",
        )
        response = self._post(path, json={"worker_id": self.worker_id, "items": items, "replace": replace})
        response.raise_for_status()

    def request_permission(self, permission: dict[str, Any]) -> dict[str, Any]:
        path = self._worker_path("/api/internal/permissions/requested", "/api/worker/permissions/requested")
        response = self._post(path, json={"worker_id": self.worker_id, "permission": permission})
        response.raise_for_status()
        return response.json()["permission"]

    def get_permission(self, permission_id: str) -> dict[str, Any]:
        path = self._worker_path(f"/api/internal/permissions/{permission_id}", f"/api/worker/permissions/{permission_id}")
        response = self._get(path)
        response.raise_for_status()
        return response.json()["permission"]

    def resolve_secrets(self, refs: list[str], *, environment: str, namespace: str, job_id: str) -> dict[str, str]:
        path = self._worker_path("/api/internal/secrets/resolve", "/api/worker/secrets/resolve")
        response = self._post(
            path,
            json={
                "worker_id": self.worker_id,
                "job_id": job_id,
                "names": refs,
                "environment": environment,
                "namespace": namespace,
            },
        )
        response.raise_for_status()
        payload = response.json().get("secrets", {})
        return {str(key): str(value) for key, value in payload.items()} if isinstance(payload, dict) else {}
