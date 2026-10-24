"""HTTP API for the dashboard. All routes require an authenticated session
(viewer or higher) unless noted; mutating routes need operator/admin and the
CSRF header (see app.security.auth)."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.agents.schemas import AGENT_NAMES
from app.config import get_settings
from app.core.audit import audit, verify_chain
from app.core.util import jsonable, utcnow
from app.data.snapshot import INTERVAL_SECONDS, candle_is_stale, freshness_report, latest_candles
from app.db.models import (
    AppSetting,
    AuditLog,
    BacktestRun,
    Decision,
    LlmCall,
    MarketObservation,
    PaperOrder,
    PaperPosition,
    RiskDecision,
    TelegramRequest,
    User,
)
from app.exchange import mexc
from app.n8n.monitor import workflow_overview
from app.paper import engine as paper
from app.quant import indicators as ind
from app.quant.backtest import STRATEGIES, Bars, CostModel
from app.quant.service import summarize_run
from app.risk.engine import TradeProposal
from app.risk.service import PAPER_SPECS, evaluate_and_record, limits_from_settings, recent_decisions, set_emergency_stop
from app.security.auth import COOKIE_NAME, DB, Admin, Operator, Viewer, create_session, destroy_session
from app.security.passwords import verify_password
from app.security.ratelimit import RateLimiter
from app.services import queries

router = APIRouter(prefix="/api")

# Strategy internals (parameters, search grids, prompt versions) and private data
# (exchange balances, Telegram user ids) are visible to admins only. Enforced here,
# server-side, not just hidden in the UI.
STRATEGY_HIDDEN = "hidden"


def is_admin(p: Any) -> bool:
    return getattr(p, "role", None) == "admin"


def mask_id(v: Any) -> str:
    s_ = str(v)
    return "•••" + s_[-3:] if len(s_) > 3 else "•••"


def redact_backtest(d: dict[str, Any]) -> dict[str, Any]:
    r = d.get("results") or {}
    split = r.get("split")
    if split:
        split["selected_params"] = STRATEGY_HIDDEN
        split.pop("_grid_scores", None)
    for f in (r.get("walk_forward") or {}).get("folds", []):
        f["params"] = STRATEGY_HIDDEN
    if r.get("default_params_full_period"):
        r["default_params_full_period"].pop("trades", None)
    d.pop("assumptions", None)
    return d
_login_limiter = RateLimiter(10, 300)


# ------------------------------------------------------------------ auth

class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


@router.post("/auth/login")
def login(body: LoginIn, response: Response, db: DB) -> dict[str, Any]:
    if not _login_limiter.allow(body.username.lower()):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "too many attempts")
    user = db.scalar(select(User).where(User.username == body.username))
    if not user or user.disabled or not verify_password(body.password, user.password_hash):
        audit(db, f"user:{body.username}", "auth.login_failed")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    token = create_session(db, user)
    s = get_settings()
    response.set_cookie(COOKIE_NAME, token, httponly=True, secure=s.cookie_secure, samesite="strict",
                        max_age=s.session_ttl_hours * 3600, path="/")
    audit(db, f"user:{user.username}", "auth.login")
    return {"username": user.username, "role": user.role}


_signup_limiter: RateLimiter | None = None
USERNAME_RE = r"^[a-zA-Z0-9_.-]{3,32}$"
EMAIL_RE = r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$"


class RegisterIn(BaseModel):
    username: str = Field(pattern=USERNAME_RE)
    email: str = Field(max_length=254, pattern=EMAIL_RE)
    password: str = Field(min_length=12, max_length=256)
    accept_terms: bool


@router.post("/auth/register", status_code=201)
def register(body: RegisterIn, request: Request, response: Response, db: DB) -> dict[str, Any]:
    """Self-registration. New accounts are read-only viewers; roles are raised by an admin."""
    global _signup_limiter
    s = get_settings()
    if not s.allow_signup:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "registration is closed")
    if not body.accept_terms:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "terms and risk disclosure must be accepted")
    _signup_limiter = _signup_limiter or RateLimiter(s.signup_rate_limit_per_hour, 3600)
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
    if not _signup_limiter.allow(ip):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "too many registrations; try later")
    if body.password.lower() in (body.username.lower(), body.email.lower()):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "password must differ from username and email")
    email = body.email.strip().lower()
    taken = db.scalar(select(User.id).where((func.lower(User.username) == body.username.lower()) | (User.email == email)))
    if taken:
        # Same message for both cases so the endpoint cannot enumerate registered emails.
        raise HTTPException(status.HTTP_409_CONFLICT, "username or email is not available")
    from app.security.passwords import hash_password

    user = User(username=body.username, email=email, password_hash=hash_password(body.password), role="viewer")
    db.add(user)
    db.flush()
    token = create_session(db, user)
    response.set_cookie(COOKIE_NAME, token, httponly=True, secure=s.cookie_secure, samesite="strict",
                        max_age=s.session_ttl_hours * 3600, path="/")
    audit(db, f"user:{user.username}", "auth.register", None, {"role": "viewer"})
    return {"username": user.username, "role": user.role}


@router.post("/auth/logout")
def logout(request: Request, response: Response, db: DB, p: Viewer) -> dict[str, str]:
    token = request.cookies.get(COOKIE_NAME)
    if token:
        destroy_session(db, token)
    response.delete_cookie(COOKIE_NAME, path="/")
    audit(db, p.actor, "auth.logout")
    return {"status": "ok"}


@router.get("/auth/me")
def me(p: Viewer) -> dict[str, Any]:
    return {"username": p.username, "role": p.role}


# ------------------------------------------------------------------ overview

@router.get("/overview")
def overview(db: DB, p: Viewer) -> dict[str, Any]:
    perf = paper.performance(db)
    return {
        "system": queries.system_status(db),
        "regime": queries.market_regime(db),
        "markets": [queries.market_snapshot(db, s) for s in get_settings().symbols],
        "agents": queries.agent_statuses(db),
        "paper": {k: perf[k] for k in ("data_kind", "equity", "starting_equity", "return_pct", "realized_pnl", "unrealized_pnl",
                                         "current_drawdown", "max_drawdown_period", "trades", "open_positions", "equity_curve", "as_of")},
        "recent_decisions": [{"id": d.id, "symbol": d.symbol, "decision": d.decision, "created_at": d.created_at.isoformat(),
                              "session_id": str(d.session_id)}
                             for d in db.scalars(select(Decision).order_by(Decision.id.desc()).limit(10))],
        "alerts": _alerts(db),
    }


def _alerts(db) -> list[dict[str, Any]]:
    st = queries.system_status(db)
    out = []
    if st["emergency_stop"]:
        out.append({"level": "critical", "message": "Emergency stop is active"})
    for src in st["sources"]:
        if src["status"] in ("down", "degraded"):
            out.append({"level": "warning", "message": f"Data source {src['source']} is {src['status']}: {src['last_error'] or ''}"[:200]})
        elif src["status"] == "unconfigured":
            out.append({"level": "info", "message": f"Data source {src['source']} needs configuration"})
    if st["stale_series"]:
        out.append({"level": "warning", "message": f"{len(st['stale_series'])} data series are stale"})
    if st["simulated_data_present"]:
        out.append({"level": "info", "message": "Simulated (synthetic) data is present; any analysis on it is labeled SIMULATED and cannot trade"})
    if st["workflow_errors_24h"]:
        out.append({"level": "warning", "message": f"{st['workflow_errors_24h']} n8n workflow errors in 24h"})
    veto = queries.latest_veto(db)
    if veto:
        out.append({"level": "info", "message": f"Last risk veto ({veto['symbol']}): {veto['reasons'][0] if veto['reasons'] else ''}"[:200]})
    return out


# ------------------------------------------------------------------ market

@router.get("/market/candles")
def candles(db: DB, p: Viewer, symbol: str = "BTCUSDT", interval: Literal["1h", "4h", "1d"] = "4h",
            limit: int = Query(500, ge=10, le=2000)) -> dict[str, Any]:
    rows = latest_candles(db, symbol.upper(), interval, limit)
    if not rows:
        return {"symbol": symbol, "interval": interval, "rows": [], "status": "unavailable", "source": None}
    b = Bars.from_rows([[r.open_time.isoformat(), r.open, r.high, r.low, r.close, r.volume] for r in rows])
    ema20, ema50, ema200 = ind.ema(b.close, 20), ind.ema(b.close, 50), ind.ema(b.close, 200)
    rsi = ind.rsi(b.close, 14)
    macd, sig, hist = ind.macd(b.close)
    nan = lambda x: None if x != x else round(float(x), 6)  # noqa: E731
    markers = []
    for pos in db.scalars(select(PaperPosition).where(PaperPosition.symbol == symbol.upper())):
        markers.append({"time": pos.opened_at.isoformat(), "kind": "entry", "side": pos.side, "price": float(pos.entry_price),
                        "stop": float(pos.stop_loss), "take_profit": float(pos.take_profit) if pos.take_profit else None, "simulated": True})
        if pos.closed_at:
            markers.append({"time": pos.closed_at.isoformat(), "kind": "exit", "side": pos.side, "price": float(pos.exit_price),
                            "reason": pos.exit_reason, "simulated": True})
    last = rows[-1]
    return {
        "symbol": symbol.upper(), "interval": interval, "source": last.source,
        "status": "simulated" if last.quality == "simulated" else ("stale" if candle_is_stale(last.close_time, interval, utcnow()) else "ok"),
        "last_close_time": last.close_time.isoformat(),
        "rows": [{"time": r.open_time.isoformat(), "open": float(r.open), "high": float(r.high), "low": float(r.low),
                  "close": float(r.close), "volume": float(r.volume)} for r in rows],
        "indicators": {"ema20": [nan(x) for x in ema20], "ema50": [nan(x) for x in ema50], "ema200": [nan(x) for x in ema200],
                       "rsi14": [nan(x) for x in rsi], "macd": [nan(x) for x in macd], "macd_signal": [nan(x) for x in sig],
                       "macd_hist": [nan(x) for x in hist]},
        "volatility": {"atr14_pct": nan(ind.atr(b.high, b.low, b.close, 14)[-1] / b.close[-1]),
                       "realized_vol_annual": nan(ind.realized_vol(b.close, 30, 31536000 / INTERVAL_SECONDS[interval])[-1])},
        "markers": markers,
        "quote": _latest_quote(db, symbol.upper()),
    }


def _latest_quote(db: Any, symbol: str) -> dict[str, Any] | None:
    """Newest TradingView quote for the symbol's base asset, labelled real time only if TradingView streamed it."""
    from app.data.snapshot import base_asset

    q = db.scalars(select(MarketObservation).where(
        MarketObservation.asset == base_asset(symbol), MarketObservation.metric == "price", MarketObservation.source == "tradingview",
    ).order_by(MarketObservation.observed_at.desc()).limit(1)).first()
    if q is None or q.value is None:
        return None
    age = (utcnow() - q.observed_at).total_seconds()
    return {"price": float(q.value), "source": q.source, "observed_at": q.observed_at.isoformat(), "age_seconds": round(age),
            "realtime": q.quality == "ok" and age <= 600, "update_mode": (q.meta or {}).get("update_mode")}


@router.get("/market/context")
def market_context(db: DB, p: Viewer, symbol: str = "BTCUSDT") -> dict[str, Any]:
    return {"symbol": queries.market_snapshot(db, symbol.upper()), "context": queries.market_context(db), "regime": queries.market_regime(db)}


# ------------------------------------------------------------------ data monitor

@router.get("/data/sources")
def data_sources(db: DB, p: Viewer) -> dict[str, Any]:
    fresh = freshness_report(db)
    return {"sources": queries.source_health(db), "freshness": fresh,
            "missing_by_design": ["Economic calendar", "Verified whale transaction feed", "Exchange flow attribution",
                                  "Order-book depth history", "Liquidations", "Tokenomics/unlocks"],
            "as_of": utcnow().isoformat()}


# ------------------------------------------------------------------ agents

@router.get("/agents")
def agents(db: DB, p: Viewer) -> list[dict[str, Any]]:
    return queries.agent_statuses(db)


@router.get("/agents/{role}")
def agent_detail(role: str, db: DB, p: Viewer) -> dict[str, Any]:
    if role not in AGENT_NAMES:
        raise HTTPException(404, "unknown agent")
    hist = queries.agent_history(db, role)
    if not is_admin(p):
        for h in hist:
            h["output"].pop("prompt_version", None)
    return {"role": role, "name": AGENT_NAMES[role], "history": hist}


# ------------------------------------------------------------------ debates

@router.get("/debates")
def debates(db: DB, p: Viewer, symbol: str | None = None, limit: int = Query(20, le=100)) -> list[dict[str, Any]]:
    return queries.recent_debates(db, limit, symbol.upper() if symbol else None)


@router.get("/debates/{session_id}")
def debate(session_id: uuid.UUID, db: DB, p: Viewer) -> dict[str, Any]:
    d = queries.debate_detail(db, session_id)
    if d is None:
        raise HTTPException(404, "not found")
    if not is_admin(p):
        for a in d["analyses"]:
            a["output"].pop("prompt_version", None)
        d["session"].pop("config", None)
    return d


# ------------------------------------------------------------------ quant

@router.get("/quant/strategies")
def strategies(p: Viewer) -> list[dict[str, Any]]:
    return [{"name": s.name, "description": s.description,
             **({"defaults": s.defaults, "grid": s.grid} if is_admin(p) else {})} for s in STRATEGIES.values()]


@router.get("/quant/backtests")
def backtests(db: DB, p: Viewer, limit: int = Query(20, le=100)) -> list[dict[str, Any]]:
    return [summarize_run(r) for r in queries.latest_backtests(db, limit)]


@router.get("/quant/backtests/{run_id}")
def backtest(run_id: uuid.UUID, db: DB, p: Viewer) -> dict[str, Any]:
    r = db.get(BacktestRun, run_id)
    if r is None:
        raise HTTPException(404, "not found")
    out = summarize_run(r, full=True)
    return out if is_admin(p) else redact_backtest(out)


class BacktestIn(BaseModel):
    strategy: str
    symbol: str = "BTCUSDT"
    interval: Literal["1h", "4h", "1d"] = "4h"
    taker_fee_bps: float = Field(5, ge=0, le=100)
    slippage_bps: float = Field(3, ge=0, le=200)
    funding_rate_per_8h: float = Field(0.0001, ge=-0.01, le=0.01)


@router.post("/quant/backtests")
def create_backtest(body: BacktestIn, db: DB, p: Operator) -> dict[str, Any]:
    from app.quant.service import run_backtest_job

    if body.strategy not in STRATEGIES:
        raise HTTPException(400, "unknown strategy")
    run = run_backtest_job(db, body.strategy, body.symbol.upper(), body.interval,
                           costs=CostModel(body.taker_fee_bps, body.slippage_bps, body.funding_rate_per_8h))
    audit(db, p.actor, "quant.backtest", str(run.id), body.model_dump())
    out = summarize_run(run, full=True)
    return out if is_admin(p) else redact_backtest(out)


# ------------------------------------------------------------------ risk

@router.get("/risk/status")
def risk_status(db: DB, p: Viewer) -> dict[str, Any]:
    from app.db.models import RiskState

    acct = paper.get_account(db)
    pf = paper.portfolio_state(db, acct)
    st = db.get(RiskState, 1)
    lim = limits_from_settings()
    exposure = sum((o.notional for o in pf.open_positions), Decimal(0))
    return {
        "limits": jsonable(lim.__dict__),
        "emergency_stop": {"active": bool(st and st.emergency_stop), "reason": st.reason if st else None,
                           "updated_by": st.updated_by if st else None, "updated_at": st.updated_at.isoformat() if st else None},
        "portfolio": {"equity": str(pf.equity), "peak_equity": str(pf.peak_equity), "available_margin": str(pf.available_margin),
                      "realized_pnl_today": str(pf.realized_pnl_today),
                      "drawdown": str((pf.peak_equity - pf.equity) / pf.peak_equity if pf.peak_equity else 0),
                      "exposure_notional": str(exposure), "exposure_ratio": str(exposure / pf.equity if pf.equity else 0),
                      "open_positions": [jsonable(o.__dict__) for o in pf.open_positions], "data_kind": "PAPER"},
        "contract_specs": {k: jsonable(v.__dict__) for k, v in PAPER_SPECS.items()},
        "disclosure": "Planned risk is an estimate; realized losses can exceed it (gaps, slippage, liquidation, outages, execution failures).",
    }


@router.get("/risk/decisions")
def risk_decisions(db: DB, p: Viewer, limit: int = Query(50, le=200)) -> list[dict[str, Any]]:
    return recent_decisions(db, limit)


@router.get("/risk/decisions/{rid}")
def risk_decision(rid: int, db: DB, p: Viewer) -> dict[str, Any]:
    r = db.get(RiskDecision, rid)
    if r is None:
        raise HTTPException(404, "not found")
    return {"id": r.id, "created_at": r.created_at.isoformat(), "inputs": r.inputs, "result": r.result, "hash": r.hash,
            "integrity_ok": paper.verify_risk_decision(r)}


class ProposalIn(BaseModel):
    symbol: str
    side: Literal["long", "short"]
    entry_price: Decimal | None = None
    stop_loss: Decimal | None = None
    take_profit: Decimal | None = None
    leverage: Decimal = Decimal(1)
    risk_fraction: Decimal | None = None


@router.post("/risk/evaluate")
def risk_evaluate(body: ProposalIn, db: DB, p: Operator) -> dict[str, Any]:
    """Position-sizing calculator. Uses the latest stored price timestamp so stale
    data is rejected exactly as in the automated path."""
    from app.data.snapshot import latest_price

    px, ts, _ = latest_price(db, body.symbol.upper())
    prop = TradeProposal(symbol=body.symbol.upper(), side=body.side, entry_price=body.entry_price or px, stop_loss=body.stop_loss,
                         take_profit=body.take_profit, leverage=body.leverage, requested_risk_fraction=body.risk_fraction, data_timestamp=ts)
    result, row = evaluate_and_record(db, prop, paper.portfolio_state(db, paper.get_account(db)), PAPER_SPECS.get(body.symbol.upper()))
    audit(db, p.actor, "risk.manual_evaluate", str(row.id), {"verdict": result.verdict})
    return {"risk_decision_id": row.id, **jsonable(result.to_dict())}


class EmergencyIn(BaseModel):
    active: bool
    reason: str = Field(min_length=3, max_length=500)


@router.post("/risk/emergency-stop")
def emergency(body: EmergencyIn, db: DB, p: Operator) -> dict[str, Any]:
    # Any operator can engage the stop; only an admin can release it.
    if not body.active and p.role != "admin":
        raise HTTPException(403, "only an admin can release the emergency stop")
    set_emergency_stop(db, body.active, body.reason, p.actor)
    audit(db, p.actor, "risk.emergency_stop", None, body.model_dump())
    return {"active": body.active}


# ------------------------------------------------------------------ paper

@router.get("/paper/summary")
def paper_summary(db: DB, p: Viewer) -> dict[str, Any]:
    return paper.performance(db)


@router.get("/paper/positions")
def paper_positions(db: DB, p: Viewer, status_: str | None = Query(None, alias="status")) -> list[dict[str, Any]]:
    q = select(PaperPosition)
    if status_:
        q = q.where(PaperPosition.status == status_)
    return [jsonable({c.name: getattr(x, c.name) for c in PaperPosition.__table__.columns}) | {"simulated": True}
            for x in db.scalars(q.order_by(PaperPosition.id.desc()).limit(200))]


@router.get("/paper/orders")
def paper_orders(db: DB, p: Viewer) -> list[dict[str, Any]]:
    return [jsonable({c.name: getattr(x, c.name) for c in PaperOrder.__table__.columns}) | {"simulated": True}
            for x in db.scalars(select(PaperOrder).order_by(PaperOrder.id.desc()).limit(200))]


@router.post("/paper/execute-decision/{decision_id}")
def paper_execute(decision_id: int, db: DB, p: Operator) -> dict[str, Any]:
    d = db.get(Decision, decision_id)
    if d is None:
        raise HTTPException(404, "decision not found")
    if d.decision not in ("LONG", "SHORT") or d.risk_decision_id is None:
        raise HTTPException(409, f"decision {d.decision} is not executable")
    order = paper.submit_entry_from_risk(db, db.get(RiskDecision, d.risk_decision_id), d.session_id)
    audit(db, p.actor, "paper.execute_decision", str(decision_id), {"order": order.client_order_id, "status": order.status})
    return {"order_id": order.id, "status": order.status, "reject_reason": order.reject_reason, "simulated": True}


@router.post("/paper/positions/{pid}/close")
def paper_close(pid: int, db: DB, p: Operator) -> dict[str, Any]:
    from app.data.snapshot import latest_price

    pos = db.get(PaperPosition, pid)
    if pos is None or pos.status != "open":
        raise HTTPException(404, "open position not found")
    px, ts, _ = latest_price(db, pos.symbol)
    if px is None:
        raise HTTPException(409, "no price available to close")
    paper.close_position(db, paper.get_account(db), pos, px, "manual")
    audit(db, p.actor, "paper.close", str(pid))
    return {"status": "closed", "simulated": True}


# ------------------------------------------------------------------ n8n, telegram, mexc

@router.get("/n8n/status")
def n8n_status(db: DB, p: Viewer) -> dict[str, Any]:
    return workflow_overview(db)


@router.get("/telegram/status")
def telegram_status(db: DB, p: Viewer) -> dict[str, Any]:
    s = get_settings()
    reqs = db.scalars(select(TelegramRequest).order_by(TelegramRequest.id.desc()).limit(50))
    from app.db.models import Notification

    notes = db.scalars(select(Notification).where(Notification.channel == "telegram").order_by(Notification.id.desc()).limit(20))
    return {
        "bot_configured": bool(s.telegram_bot_token.get_secret_value()),
        "webhook_secret_configured": bool(s.telegram_webhook_secret.get_secret_value()),
        "authorized_users_configured": len(s.telegram_allowlist),
        "rate_limit_per_minute": s.telegram_rate_limit_per_minute,
        "requests": [{"id": r.id, "created_at": r.created_at.isoformat(), "user_id": mask_id(r.user_id) if r.authorized else "unauthorized",
                      "authorized": r.authorized, "intent": r.intent, "status": r.status, "latency_ms": r.latency_ms, "error": r.error}
                     for r in reqs],
        "deliveries": [{"created_at": n.created_at.isoformat(), "kind": n.kind, "status": n.status, "error": n.error} for n in notes],
    }


@router.get("/mexc/status")
def mexc_status(db: DB, p: Viewer) -> dict[str, Any]:
    st = mexc.status(db)
    if not is_admin(p):  # balances and positions are private account data
        for v in st["snapshots"].values():
            if v.get("payload") is not None:
                v["payload"] = None
                v["payload_hidden"] = True
    return st


@router.post("/mexc/sync")
def mexc_sync(db: DB, p: Operator) -> dict[str, Any]:
    res = mexc.sync_account(db)
    audit(db, p.actor, "mexc.sync", None, res)
    return res


# ------------------------------------------------------------------ settings & audit

AGENT_SETTINGS_KEY = "agents"


class AgentSettingsIn(BaseModel):
    enabled: dict[str, bool] = Field(default_factory=dict)
    schedules: dict[str, str] = Field(default_factory=dict)


@router.get("/settings")
def settings_view(db: DB, p: Viewer) -> dict[str, Any]:
    from app.agents.base import load_prompt
    from app.debate.orchestrator import ROUND_NAMES

    s = get_settings()
    row = db.get(AppSetting, AGENT_SETTINGS_KEY)
    prompts = {name: load_prompt(name)[0] for name in ("common", "macro", "fundamental", "onchain", "flow", "critic", "fund_manager", "reply")}
    usage = db.execute(select(func.coalesce(func.sum(LlmCall.tokens_in + LlmCall.tokens_out), 0), func.coalesce(func.sum(LlmCall.cost_usd), 0))).one()
    out = {
        "environment": s.app_env,
        "mode": "PAPER",
        "live_trading_enabled": s.live_trading_enabled,
        "llm": {"provider": s.llm_provider, "model": s.llm_model, "configured": s.llm_enabled,
                "token_budget_per_debate": s.debate_token_budget, "cost_budget_per_debate_usd": str(s.debate_cost_budget_usd),
                "total_tokens": int(usage[0]), "total_cost_usd": str(usage[1])},
        "prompt_versions": prompts,
        "debate_rounds": ROUND_NAMES,
        "risk": jsonable(limits_from_settings().__dict__),
        "secrets_configured": {
            "llm_api_key": bool(s.llm_api_key.get_secret_value()), "telegram_bot_token": bool(s.telegram_bot_token.get_secret_value()),
            "mexc_api_key": bool(s.mexc_api_key.get_secret_value()), "fred_api_key": bool(s.fred_api_key.get_secret_value()),
            "coingecko_api_key": bool(s.coingecko_api_key.get_secret_value()), "n8n_api_key": bool(s.n8n_api_key.get_secret_value()),
            "service_token": bool(s.service_token.get_secret_value()),
        },
        "agents": row.value if row else {"enabled": {r: True for r in AGENT_NAMES}, "schedules": {}},
        "note": "Secrets and risk limits are set via server environment only and are never returned to the browser.",
    }
    if not is_admin(p):
        public = ("environment", "mode", "live_trading_enabled", "debate_rounds", "risk", "agents", "note")
        out = {k: v for k, v in out.items() if k in public}
    return out


@router.put("/settings/agents")
def settings_agents(body: AgentSettingsIn, db: DB, p: Admin) -> dict[str, Any]:
    for role in body.enabled:
        if role not in AGENT_NAMES:
            raise HTTPException(400, f"unknown agent {role}")
    if body.enabled.get("risk") is False or body.enabled.get("fund_manager") is False:
        raise HTTPException(400, "the Risk Manager and Fund Manager cannot be disabled")
    row = db.get(AppSetting, AGENT_SETTINGS_KEY) or AppSetting(key=AGENT_SETTINGS_KEY, value={})
    row.value, row.updated_by, row.updated_at = body.model_dump(), p.actor, utcnow()
    db.merge(row)
    audit(db, p.actor, "settings.agents", None, body.model_dump())
    return row.value


@router.get("/audit")
def audit_log(db: DB, p: Admin, limit: int = Query(100, le=500), before_id: int | None = None) -> dict[str, Any]:
    q = select(AuditLog)
    if before_id:
        q = q.where(AuditLog.id < before_id)
    rows = db.scalars(q.order_by(AuditLog.id.desc()).limit(limit))
    return {"rows": [{"id": r.id, "ts": r.ts.isoformat(), "actor": r.actor, "action": r.action, "target": r.target,
                      "details": r.details, "hash": r.hash[:16]} for r in rows]}


@router.get("/audit/verify")
def audit_verify(db: DB, p: Admin) -> dict[str, Any]:
    ok, bad = verify_chain(db)
    return {"ok": ok, "first_bad_id": bad, "checked_at": datetime.now(UTC).isoformat()}
