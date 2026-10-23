"""FastAPI application factory."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import routes, system
from app.config import get_settings
from app.core.logging import configure_logging

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()  # raises on unsafe configuration -> process exits
    configure_logging(s.log_level)
    log.info("starting", extra={"ctx": {"env": s.app_env, "live_trading": s.live_trading_enabled, "llm": s.llm_enabled}})
    if s.app_env != "test":
        from app.cli import abort_orphaned_debates, bootstrap_admin

        log.info(bootstrap_admin())
        n = abort_orphaned_debates()
        if n:
            log.warning("aborted orphaned debates", extra={"ctx": {"count": n}})
    yield


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title=s.app_name, version=system.VERSION, lifespan=lifespan,
                  docs_url="/api/docs" if s.app_env != "production" else None, redoc_url=None,
                  openapi_url="/api/openapi.json" if s.app_env != "production" else None)
    if s.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in s.cors_origins.split(",")],
                           allow_credentials=True, allow_methods=["GET", "POST", "PUT"], allow_headers=["content-type", "x-requested-with"])

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        resp.headers.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        if s.cookie_secure:
            resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        if request.url.path.startswith("/api/"):
            resp.headers.setdefault("Cache-Control", "no-store")
        return resp

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        log.exception("unhandled error", extra={"ctx": {"path": request.url.path}})
        return JSONResponse({"detail": "internal error"}, status_code=500)

    app.include_router(system.router)
    app.include_router(routes.router)
    return app


app = create_app()
