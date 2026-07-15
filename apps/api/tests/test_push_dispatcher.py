from __future__ import annotations

from datetime import timedelta
from typing import Any, Callable

import httpx
from fastapi.testclient import TestClient

from conftest import auth_headers, bootstrap_owner, create_worker, login


class FakeResponse:
    def __init__(self, payload: dict[str, Any], status_code: int = 200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "provider error",
                request=httpx.Request("POST", "https://exp.host"),
                response=httpx.Response(self.status_code),
            )

    def json(self) -> dict[str, Any]:
        return self._payload


class FakeExpoClient:
    def __init__(
        self,
        responses: list[FakeResponse | Exception],
        *,
        on_post: Callable[[], None] | None = None,
    ):
        self.responses = list(responses)
        self.requests: list[dict[str, Any]] = []
        self.closed = False
        self.on_post = on_post

    def post(self, url: str, **kwargs: Any) -> FakeResponse:
        self.requests.append({"url": url, **kwargs})
        if self.on_post is not None:
            self.on_post()
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def close(self) -> None:
        self.closed = True


def _queue_delivery(client: TestClient, suffix: str = "success") -> tuple[dict[str, str], str]:
    from test_push_devices import _create_session, _register_device, _request_permission

    bootstrap_owner(client)
    headers = auth_headers(login(client))
    worker = create_worker(client, f"push-dispatch-worker-{suffix}")
    worker_id = worker["worker"]["worker_id"]
    _create_session(client, headers, worker_id)
    registered = _register_device(
        client,
        headers,
        device_id=f"phone-{suffix}-1",
        push_token=f"ExponentPushToken[{suffix}-token]",
    )
    assert registered.status_code == 200, registered.text
    _request_permission(
        client,
        {"Authorization": f"Bearer {worker['worker_token']}"},
        worker_id,
        f"permission-{suffix}",
    )
    return headers, f"phone-{suffix}-1"


def _settings(**overrides: Any):
    from app.core.config import Settings

    values = {
        "expo_push_enabled": True,
        "expo_push_batch_size": 100,
        "expo_push_max_attempts": 3,
        "expo_push_timeout_seconds": 2.0,
        "expo_push_backoff_seconds": 0.0,
        "expo_push_receipt_delay_seconds": 0,
    }
    values.update(overrides)
    return Settings(**values)


def test_dispatcher_sends_ticket_and_records_successful_receipt(client: TestClient) -> None:
    from app.core.push_dispatcher import dispatch_pending_pushes, refresh_push_receipts
    from app.models import NotificationDelivery, utcnow

    headers, _ = _queue_delivery(client)
    notification = client.get("/api/notifications", headers=headers).json()["items"][0]
    claimed = client.post(
        f"/api/notifications/{notification['notification_id']}/delivered",
        headers=headers,
    )
    assert claimed.status_code == 200

    transport = FakeExpoClient(
        [
            FakeResponse({"data": [{"status": "ok", "id": "ticket-success-1"}]}),
            FakeResponse({"data": {"ticket-success-1": {"status": "ok"}}}),
        ]
    )
    with client.app.state.SessionLocal() as db:
        sent = dispatch_pending_pushes(db, _settings(), http_client=transport)
        assert sent == {"ticketed": 1, "retry": 0, "failed": 0, "disabled": 0}
        delivery = db.query(NotificationDelivery).one()
        assert delivery.status == "ticketed"
        assert delivery.provider_ticket_id == "ticket-success-1"
        assert delivery.receipt_next_attempt_at is not None
        assert delivery.receipt_next_attempt_at <= utcnow()

        receipts = refresh_push_receipts(db, _settings(), http_client=transport)
        assert receipts == {"delivered": 1, "pending": 0, "failed": 0, "disabled": 0}
        db.refresh(delivery)
        assert delivery.status == "delivered"
        assert delivery.delivered_at is not None

    assert transport.requests[0]["json"][0]["data"] == {
        "notificationId": notification["notification_id"],
        "sessionId": "push-device-session",
        "notificationType": "approval",
    }
    assert transport.requests[0]["json"][0]["to"] == "ExponentPushToken[success-token]"
    assert transport.requests[1]["json"] == {"ids": ["ticket-success-1"]}


def test_dispatcher_retries_transport_failures_without_losing_delivery(client: TestClient) -> None:
    from app.core.push_dispatcher import dispatch_pending_pushes
    from app.models import NotificationDelivery

    _queue_delivery(client, "retry")
    transport = FakeExpoClient([httpx.ConnectError("offline")])
    with client.app.state.SessionLocal() as db:
        result = dispatch_pending_pushes(db, _settings(), http_client=transport)
        assert result == {"ticketed": 0, "retry": 1, "failed": 0, "disabled": 0}
        delivery = db.query(NotificationDelivery).one()
        assert delivery.status == "retry"
        assert delivery.attempts == 1
        assert delivery.next_attempt_at is not None
        assert "offline" in delivery.last_error


def test_dispatcher_recovers_an_expired_sending_claim(client: TestClient) -> None:
    from app.core.push_dispatcher import dispatch_pending_pushes
    from app.models import NotificationDelivery, utcnow

    _queue_delivery(client, "stale-send")
    with client.app.state.SessionLocal() as db:
        delivery = db.query(NotificationDelivery).one()
        delivery.status = "sending"
        delivery.attempts = 1
        delivery.next_attempt_at = utcnow() - timedelta(seconds=1)
        db.commit()

    transport = FakeExpoClient(
        [FakeResponse({"data": [{"status": "ok", "id": "ticket-stale-send"}]})]
    )
    with client.app.state.SessionLocal() as db:
        result = dispatch_pending_pushes(db, _settings(), http_client=transport)
        assert result == {"ticketed": 1, "retry": 0, "failed": 0, "disabled": 0}
        delivery = db.query(NotificationDelivery).one()
        assert delivery.status == "ticketed"
        assert delivery.attempts == 2


def test_dispatcher_does_not_send_again_after_exhausted_sending_claim(client: TestClient) -> None:
    from app.core.push_dispatcher import dispatch_pending_pushes
    from app.models import NotificationDelivery, utcnow

    _queue_delivery(client, "exhausted-send")
    with client.app.state.SessionLocal() as db:
        delivery = db.query(NotificationDelivery).one()
        delivery.status = "sending"
        delivery.attempts = 3
        delivery.next_attempt_at = utcnow() - timedelta(seconds=1)
        db.commit()

    transport = FakeExpoClient([])
    with client.app.state.SessionLocal() as db:
        result = dispatch_pending_pushes(db, _settings(expo_push_max_attempts=3), http_client=transport)
        delivery = db.query(NotificationDelivery).one()
        assert result == {"ticketed": 0, "retry": 0, "failed": 1, "disabled": 0}
        assert delivery.status == "failed"
        assert delivery.attempts == 3
        assert "maximum attempts" in delivery.last_error
    assert transport.requests == []


def test_device_revocation_wins_over_an_in_flight_send_response(client: TestClient) -> None:
    from app.core.push_devices import disable_push_device
    from app.core.push_dispatcher import dispatch_pending_pushes
    from app.models import NotificationDelivery, PushDevice

    _queue_delivery(client, "revoke-send")

    def revoke_during_send() -> None:
        with client.app.state.SessionLocal() as other_db:
            disable_push_device(other_db, other_db.query(PushDevice).one(), "logged out")
            other_db.commit()

    transport = FakeExpoClient(
        [FakeResponse({"data": [{"status": "ok", "id": "ticket-after-revoke"}]})],
        on_post=revoke_during_send,
    )
    with client.app.state.SessionLocal() as db:
        result = dispatch_pending_pushes(db, _settings(), http_client=transport)
        db.expire_all()
        assert result == {"ticketed": 0, "retry": 0, "failed": 0, "disabled": 0}
        assert db.query(NotificationDelivery).one().status == "disabled"
        assert db.query(PushDevice).one().enabled is False


def test_dispatcher_closes_the_http_client_it_creates(client: TestClient, monkeypatch) -> None:
    from app.core import push_dispatcher

    _queue_delivery(client, "owned-client")
    transport = FakeExpoClient([FakeResponse({"data": [{"status": "ok", "id": "ticket-owned"}]})])
    monkeypatch.setattr(push_dispatcher.httpx, "Client", lambda: transport)

    with client.app.state.SessionLocal() as db:
        push_dispatcher.dispatch_pending_pushes(db, _settings())

    assert transport.closed is True


def test_dispatcher_disables_unregistered_expo_device(client: TestClient) -> None:
    from app.core.push_dispatcher import dispatch_pending_pushes
    from app.models import NotificationDelivery, PushDevice

    _queue_delivery(client, "unregistered")
    transport = FakeExpoClient(
        [
            FakeResponse(
                {
                    "data": [
                        {
                            "status": "error",
                            "message": "Device is not registered",
                            "details": {"error": "DeviceNotRegistered"},
                        }
                    ]
                }
            )
        ]
    )
    with client.app.state.SessionLocal() as db:
        result = dispatch_pending_pushes(db, _settings(), http_client=transport)
        assert result == {"ticketed": 0, "retry": 0, "failed": 0, "disabled": 1}
        delivery = db.query(NotificationDelivery).one()
        device = db.query(PushDevice).one()
        assert delivery.status == "disabled"
        assert device.enabled is False
        assert device.push_token == ""


def test_dispatcher_expires_devices_that_have_not_renewed_their_registration(client: TestClient) -> None:
    from app.core.push_dispatcher import dispatch_pending_pushes
    from app.models import NotificationDelivery, PushDevice, utcnow

    _queue_delivery(client, "stale-device")
    with client.app.state.SessionLocal() as db:
        device = db.query(PushDevice).one()
        device.last_seen_at = utcnow() - timedelta(days=31)
        db.commit()

    transport = FakeExpoClient([])
    with client.app.state.SessionLocal() as db:
        result = dispatch_pending_pushes(
            db,
            _settings(expo_push_device_ttl_days=30),
            http_client=transport,
        )
        assert result == {"ticketed": 0, "retry": 0, "failed": 0, "disabled": 1}
        assert db.query(PushDevice).one().enabled is False
        assert db.query(NotificationDelivery).one().status == "disabled"
    assert transport.requests == []


def test_receipt_polling_fails_after_bounded_missing_receipts(client: TestClient) -> None:
    from app.core.push_dispatcher import dispatch_pending_pushes, refresh_push_receipts
    from app.models import NotificationDelivery

    _queue_delivery(client, "missing-receipt")
    transport = FakeExpoClient(
        [
            FakeResponse({"data": [{"status": "ok", "id": "ticket-missing-receipt"}]}),
            FakeResponse({"data": {}}),
            FakeResponse({"data": {}}),
        ]
    )
    settings = _settings(expo_push_max_attempts=2, expo_push_backoff_seconds=0)
    with client.app.state.SessionLocal() as db:
        assert dispatch_pending_pushes(db, settings, http_client=transport)["ticketed"] == 1
        assert refresh_push_receipts(db, settings, http_client=transport) == {
            "delivered": 0,
            "pending": 1,
            "failed": 0,
            "disabled": 0,
        }
        assert refresh_push_receipts(db, settings, http_client=transport) == {
            "delivered": 0,
            "pending": 0,
            "failed": 1,
            "disabled": 0,
        }
        delivery = db.query(NotificationDelivery).one()
        assert delivery.status == "failed"
        assert delivery.receipt_attempts == 2


def test_receipt_polling_does_not_retry_an_exhausted_claim(client: TestClient) -> None:
    from app.core.push_dispatcher import refresh_push_receipts
    from app.models import NotificationDelivery, utcnow

    _queue_delivery(client, "exhausted-receipt")
    with client.app.state.SessionLocal() as db:
        delivery = db.query(NotificationDelivery).one()
        delivery.status = "checking_receipt"
        delivery.provider_ticket_id = "ticket-exhausted-receipt"
        delivery.receipt_attempts = 3
        delivery.receipt_next_attempt_at = utcnow() - timedelta(seconds=1)
        db.commit()

    transport = FakeExpoClient([])
    with client.app.state.SessionLocal() as db:
        result = refresh_push_receipts(
            db,
            _settings(expo_push_max_attempts=3),
            http_client=transport,
        )
        delivery = db.query(NotificationDelivery).one()
        assert result == {"delivered": 0, "pending": 0, "failed": 1, "disabled": 0}
        assert delivery.status == "failed"
        assert delivery.receipt_attempts == 3
        assert "maximum attempts" in delivery.last_error
    assert transport.requests == []


def test_device_revocation_wins_over_an_in_flight_receipt_response(client: TestClient) -> None:
    from app.core.push_devices import disable_push_device
    from app.core.push_dispatcher import dispatch_pending_pushes, refresh_push_receipts
    from app.models import NotificationDelivery, PushDevice

    _queue_delivery(client, "revoke-receipt")
    settings = _settings()
    with client.app.state.SessionLocal() as db:
        sent = dispatch_pending_pushes(
            db,
            settings,
            http_client=FakeExpoClient(
                [FakeResponse({"data": [{"status": "ok", "id": "ticket-revoke-receipt"}]})]
            ),
        )
        assert sent["ticketed"] == 1

    def revoke_during_receipt() -> None:
        with client.app.state.SessionLocal() as other_db:
            disable_push_device(other_db, other_db.query(PushDevice).one(), "logged out")
            other_db.commit()

    transport = FakeExpoClient(
        [FakeResponse({"data": {"ticket-revoke-receipt": {"status": "ok"}}})],
        on_post=revoke_during_receipt,
    )
    with client.app.state.SessionLocal() as db:
        result = refresh_push_receipts(db, settings, http_client=transport)
        db.expire_all()
        assert result == {"delivered": 0, "pending": 0, "failed": 0, "disabled": 0}
        assert db.query(NotificationDelivery).one().status == "disabled"
        assert db.query(PushDevice).one().enabled is False


def test_dispatch_worker_runs_ticket_and_receipt_passes_with_fresh_sessions(
    client: TestClient,
    monkeypatch,
) -> None:
    from app.core import push_dispatcher

    calls: list[str] = []

    def fake_dispatch(db, settings):
        assert db is not None
        calls.append("dispatch")
        return {"ticketed": 0, "retry": 0, "failed": 0, "disabled": 0}

    def fake_receipts(db, settings):
        assert db is not None
        calls.append("receipts")
        return {"delivered": 0, "pending": 0, "failed": 0, "disabled": 0}

    monkeypatch.setattr(push_dispatcher, "dispatch_pending_pushes", fake_dispatch)
    monkeypatch.setattr(push_dispatcher, "refresh_push_receipts", fake_receipts)

    worker = push_dispatcher.PushDispatchWorker(client.app.state.SessionLocal, _settings())
    worker.run_once()

    assert calls == ["dispatch", "receipts"]
