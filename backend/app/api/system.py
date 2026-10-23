"""Health checks, live event stream, Telegram webhook and n8n service endpoints."""
from __future__ import annotations

import asyncio
import hmac
import json
import uuid
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, text

from app.config import get_settings
from app.core.audit import audit
from app.core.util import utcnow
from app.db.models import SystemEvent
from app.db.session import get_engine, session_scope
from app.security.auth import DB, OperatorOrService, Service, Viewer
from app.services import queries

router = APIRouter(prefix="/api")
VERSION = "0.1.0"


# ------------------------------------------------------------------ health (no auth)

@router.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "version": VERSION, "time": utcnow().isoformat()}


@router.get("/health/ready")
def ready() -> JSONResponse:
    try:
        with get_engine().connect() as c:
            c.execute(text("SELECT 1"))
            rev = c.execute(text("SELECT version_num FROM alembic_version")).scalar()
        return JSONResponse({"status": "ready", "db": "ok", "migration": rev})
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"status": "not_ready", "db": type(e).__name__}, status_code=503)


@router.get("/health/deep")
def deep_health(db: DB, p: OperatorOrService) -> dict[str, Any]:
    st = queries.system_status(db)
    problems = [s["source"] for s in st["sources"] if s["status"] in ("down", "degraded")]
    healthy = st["database"] == "ok" and not st["emergency_stop"] and not problems
    return {"healthy": healthy, "problems": problems, **st}


# ------------------------------------------------------------------ events

@router.get("/events")
def events(db: DB, p: Viewer, after_id: int = 0, limit: int = Query(200, le=500)) -> list[dict[str, Any]]:
    rows = db.scalars(select(SystemEvent).where(SystemEvent.id > after_id).order_by(SystemEvent.id).limit(limit))
    return [_ev(e) for e in rows]


def _ev(e: SystemEvent) -> dict[str, Any]:
    return {"id": e.id, "ts": e.ts.isoformat(), "type": e.type, "agent": e.agent,
            "session_id": str(e.session_id) if e.session_id else None, "payload": e.payload}


@router.get("/events/stream")
async def events_stream(request: Request, p: Viewer, after_id: int | None = None) -> StreamingResponse:
    """Server-sent events backed by the system_events table (works across processes)."""
    def latest_id() -> int:
        with session_scope() as db:
            return db.scalar(select(SystemEvent.id).order_by(SystemEvent.id.desc()).limit(1)) or 0

    def fetch(after: int) -> list[dict[str, Any]]:
        with session_scope() as db:
            return [_ev(e) for e in db.scalars(select(SystemEvent).where(SystemEvent.id > after).order_by(SystemEvent.id).limit(200))]

    async def gen():
        cursor = after_id if after_id is not None else await asyncio.to_thread(latest_id)
        idle = 0
        while not await request.is_disconnected():
            batch = await asyncio.to_thread(fetch, cursor)
            for e in batch:
                cursor = e["id"]
                yield f"id: {e['id']}\nevent: {e['type']}\ndata: {json.dumps(e)}\n\n"
            idle = 0 if batch else idle + 1
            if idle and idle % 15 == 0:
                yield ": keepalive\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ telegram webhook

@router.post("/telegram/webhook", include_in_schema=False)
async def telegram_webhook(request: Request, x_telegram_bot_api_secret_token: str | None = Header(None)) -> dict[str, Any]:
    secret = get_settings().telegram_webhook_secret.get_secret_value()
    if not secret or not hmac.compare_digest((x_telegram_bot_api_secret_token or "").encode(), secret.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad secret")
    body = await request.body()
    if len(body) > 64_000:
        raise HTTPException(413, "payload too large")
    try:
        update = json.loads(body)
    except ValueError as e:
        raise HTTPException(400, "invalid json") from e

    def work() -> dict[str, Any]:
        from app.telegram.client import TelegramSender
        from app.telegram.service import handle_update

        with session_scope() as db:
            return handle_update(db, update, TelegramSender())

    res = await asyncio.to_thread(work)
    return {"ok": True, "status": res.get("status")}


# ------------------------------------------------------------------ service endpoints (n8n)

class IngestIn(BaseModel):
    sources: list[str] = Field(default_factory=list)


@router.post("/service/ingest")
def svc_ingest(body: IngestIn, db: DB, p: OperatorOrService) -> dict[str, Any]:
    from app.data.ingest import run_ingestion

    return run_ingestion(db, body.sources or None)


class DebateIn(BaseModel):
    symbol: str = "BTCUSDT"
    idempotency_key: str | None = Field(None, max_length=120)
    wait: bool = False


@router.post("/service/debate")
def svc_debate(body: DebateIn, background: BackgroundTasks, p: OperatorOrService) -> JSONResponse:
    from app.debate.orchestrator import DuplicateDebate, run_debate

    symbol = body.symbol.upper()
    if symbol not in get_settings().symbols:
        raise HTTPException(400, "symbol not in WATCH_SYMBOLS")
    key = body.idempotency_key or f"manual:{uuid.uuid4()}"
    trigger = "n8n" if p.username.startswith("service") else "dashboard"
    with session_scope() as db:
        audit(db, p.actor, "debate.requested", symbol, {"idempotency_key": key})
    if body.wait:
        try:
            sid = run_debate(symbol, trigger, key)
        except DuplicateDebate as e:
            return JSONResponse({"status": "duplicate", "session_id": str(e.session_id)}, status_code=200)
        except RuntimeError as e:
            return JSONResponse({"status": "busy", "detail": str(e)}, status_code=409)
        with session_scope() as db:
            return JSONResponse({"status": "completed", **queries.debate_detail(db, sid)["session"]})

    def bg() -> None:
        try:
            run_debate(symbol, trigger, key)
        except (DuplicateDebate, RuntimeError):
            pass

    background.add_task(bg)
    return JSONResponse({"status": "accepted", "idempotency_key": key}, status_code=202)


class BacktestJobIn(BaseModel):
    strategies: list[str] = Field(default_factory=lambda: ["ema_trend", "rsi_mean_reversion", "donchian_breakout"])
    interval: str = "4h"
    # False: run in the background and return 202 at once (for callers with short execution limits, e.g. n8n Cloud).
    wait: bool = True


def _run_scheduled_backtests(strategies: list[str], interval: str, actor: str) -> list[dict[str, Any]]:
    from app.core.locks import job_lock
    from app.quant.service import run_backtest_job, summarize_run

    out = []
    with job_lock("scheduled-backtest", actor, 3600), session_scope() as db:
        for sym in get_settings().symbols:
            for strat in strategies:
                out.append(summarize_run(run_backtest_job(db, strat, sym, interval)))
    return out


@router.post("/service/backtest", response_model=None)
def svc_backtest(body: BacktestJobIn, background: BackgroundTasks, p: OperatorOrService) -> list[dict[str, Any]] | JSONResponse:
    from app.core.locks import LockHeld

    if not body.wait:
        def bg() -> None:
            try:
                _run_scheduled_backtests(body.strategies, body.interval, p.actor)
            except LockHeld:
                pass

        background.add_task(bg)
        return JSONResponse({"status": "accepted"}, status_code=202)
    try:
        return _run_scheduled_backtests(body.strategies, body.interval, p.actor)
    except LockHeld:
        raise HTTPException(409, "backtest job already running") from None


@router.post("/service/paper/mark")
def svc_mark(db: DB, p: OperatorOrService) -> dict[str, Any]:
    from app.paper.engine import mark_to_market

    return mark_to_market(db)


class CallbackIn(BaseModel):
    workflow_id: str
    workflow_name: str | None = None
    execution_id: str
    status: str
    started_at: str | None = None
    finished_at: str | None = None
    error: Any = None


@router.post("/service/n8n/callback")
def svc_callback(body: CallbackIn, db: DB, p: Service) -> dict[str, Any]:
    from app.n8n.monitor import record_callback

    row = record_callback(db, body.model_dump())
    return {"recorded": row.id if row else None}


class TelegramPushIn(BaseModel):
    kind: str = Field("report", pattern="^(report|alert|growth)$")
    message: str | None = Field(None, max_length=1000)


@router.post("/service/telegram/push")
def svc_telegram_push(body: TelegramPushIn, db: DB, p: Service) -> dict[str, Any]:
    """Scheduled report / alert to every allow-listed user (content built from DB)."""
    from app.telegram.client import TelegramSender, notify
    from app.telegram.handlers import h_report
    from app.telegram.intents import Intent

    s = get_settings()
    if not s.telegram_bot_token.get_secret_value():
        return {"status": "not_configured"}
    if body.kind == "report":
        text_out = h_report(db, Intent("report", period="today"))
    elif body.kind == "growth":
        text_out = growth_digest(db)
    else:
        text_out = f"PERINGATAN SISTEM: {body.message or 'cek dashboard'}"
    sender = TelegramSender()
    sent = sum(notify(db, sender, uid, body.kind, text_out) for uid in s.telegram_allowlist)
    return {"status": "ok", "sent": sent, "recipients": len(s.telegram_allowlist)}


def growth_digest(db) -> str:
    """Aggregate counts only; no usernames or emails leave the database."""
    from datetime import timedelta

    from sqlalchemy import func

    from app.db.models import TelegramRequest, User, UserSession

    now = utcnow()
    total = db.scalar(select(func.count()).select_from(User)) or 0
    new_24h = db.scalar(select(func.count()).select_from(User).where(User.created_at > now - timedelta(days=1))) or 0
    new_7d = db.scalar(select(func.count()).select_from(User).where(User.created_at > now - timedelta(days=7))) or 0
    active = db.scalar(select(func.count(func.distinct(UserSession.user_id))).where(UserSession.created_at > now - timedelta(days=1))) or 0
    tg = db.scalar(select(func.count()).select_from(TelegramRequest).where(TelegramRequest.created_at > now - timedelta(days=1))) or 0
    return (f"Ringkasan pertumbuhan per {now:%Y-%m-%d %H:%M} UTC\n"
            f"Total akun: {total} | Baru 24 jam: {new_24h} | Baru 7 hari: {new_7d}\n"
            f"Pengguna login 24 jam: {active} | Permintaan Telegram 24 jam: {tg}")


@router.get("/service/growth")
def svc_growth(db: DB, p: Service) -> dict[str, Any]:
    return {"digest": growth_digest(db)}
