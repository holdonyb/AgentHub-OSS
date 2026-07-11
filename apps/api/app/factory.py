from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError

from app.core.config import Settings
from app.core.database import create_db_engine, create_session_local, init_database
from app.core.rate_limit import RateLimitMiddleware
from app.core.security import generate_token
from app.routers import (
    auth,
    events,
    internal,
    jobs,
    memory,
    permissions,
    providers,
    schedules,
    secrets,
    sessions,
    settings as settings_router,
    sync,
    tasks,
    timeline,
    voice,
    worker_relay,
    workers,
)

logger = logging.getLogger("agenthub")


def _database_error_payload(error: OperationalError) -> tuple[int, dict[str, str]]:
    message = str(error).lower()
    if "database is locked" in message or "database schema is locked" in message:
        return 503, {"message": "Database is busy, retry shortly", "code": "DB_BUSY"}
    return 500, {"message": "Database operation failed", "code": "DB_OPERATION_FAILED"}


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title=settings.app_name)
    app.state.settings = settings
    app.state.bootstrap_token = settings.bootstrap_token or generate_token("boot")
    if settings.bootstrap_token is None:
        logger.warning("AgentHub bootstrap token generated for this process: %s", app.state.bootstrap_token)

    engine = create_db_engine(settings.database_url)
    SessionLocal = create_session_local(engine)
    app.state.db_engine = engine
    app.state.SessionLocal = SessionLocal
    init_database(engine)

    app.add_middleware(RateLimitMiddleware, settings=settings)
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-CSRF-Token"],
    )

    app.include_router(auth.router)
    app.include_router(workers.router)
    app.include_router(sessions.router)
    app.include_router(tasks.router)
    app.include_router(timeline.router)
    app.include_router(jobs.router)
    app.include_router(events.router)
    app.include_router(memory.router)
    app.include_router(schedules.router)
    app.include_router(secrets.router)
    app.include_router(settings_router.router)
    app.include_router(permissions.router)
    app.include_router(providers.router)
    app.include_router(sync.router)
    app.include_router(voice.router)
    app.include_router(internal.router)
    app.include_router(worker_relay.router)

    @app.exception_handler(OperationalError)
    async def handle_operational_error(request: Request, exc: OperationalError):
        status_code, detail = _database_error_payload(exc)
        if status_code >= 500:
            logger.warning("Database operation failed during %s %s: %s", request.method, request.url.path, exc)
        return JSONResponse(status_code=status_code, content={"detail": detail})

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app
