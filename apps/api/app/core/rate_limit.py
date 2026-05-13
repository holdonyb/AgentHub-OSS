from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from app.core.config import Settings


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, settings: Settings) -> None:  # type: ignore[no-untyped-def]
        super().__init__(app)
        self.settings = settings
        self.buckets: dict[tuple[str, str], deque[float]] = defaultdict(deque)

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if not self.settings.rate_limit_enabled:
            return await call_next(request)

        limit = self._limit_for(request)
        if limit is None:
            return await call_next(request)

        count, window = limit
        key = (self._client_ip(request), f"{request.method}:{request.url.path}")
        now = time.monotonic()
        bucket = self.buckets[key]
        while bucket and now - bucket[0] > window:
            bucket.popleft()
        if len(bucket) >= count:
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded", "code": "RATE_LIMITED"},
            )
        bucket.append(now)
        return await call_next(request)

    def _client_ip(self, request: Request) -> str:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
        return request.client.host if request.client else "unknown"

    def _limit_for(self, request: Request) -> tuple[int, int] | None:
        path = request.url.path
        if request.method == "POST" and path == "/api/auth/login":
            return (
                self.settings.login_rate_limit_count,
                self.settings.login_rate_limit_window_seconds,
            )
        if request.method in {"POST", "DELETE"} and (
            path.startswith("/api/tokens")
            or path == "/api/jobs"
            or path == "/api/voice/transcribe"
            or path.endswith("/input")
            or path == "/api/auth/bootstrap"
        ):
            return (
                self.settings.mutation_rate_limit_count,
                self.settings.mutation_rate_limit_window_seconds,
            )
        return None
