"""Read models shared by the HTTP API and the Telegram bot."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.agents.schemas import AGENT_NAMES
from app.config import get_settings
from app.data.snapshot import base_asset, freshness_report, latest_candles
from app.db.models import (
    AgentAnalysis,
    BacktestRun,
    DebateMessage,
    DebateSession,
    Decision,
    MarketObservation,
    RiskDecision,
    SourceHealth,
    SystemEvent,
    TelegramRequest,
    WorkflowExecution,
)
from app.core.util import utcnow
from app.risk.service import emergency_stop_active


def agent_statuses(db: Session) -> list[dict[str, Any]]:
    """Latest persisted analysis per agent, plus the latest real state event."""
    out = []
    for role, name in AGENT_NAMES.items():
        a = db.scalar(select(AgentAnalysis).where(AgentAnalysis.agent_role == role).order_by(AgentAnalysis.id.desc()).limit(1))
        ev = db.scalar(select(SystemEvent).where(SystemEvent.type == "agent.state", SystemEvent.agent == role)
                       .order_by(SystemEvent.id.desc()).limit(1))
        state = (ev.payload.get("state") if ev else None) or "idle"
        if ev and state not in ("completed", "warning", "error", "veto") and utcnow() - ev.ts > timedelta(minutes=15):
            state = "error"  # stuck in an active state: surface it rather than animate it
        out.append({
            "role": role, "name": name, "state": state if a or ev else "idle",
            "last_event_at": ev.ts.isoformat() if ev else None,
            "last_analysis": None if a is None else {
                "id": a.id, "session_id": str(a.session_id), "status": a.status, "created_at": a.created_at.isoformat(),
                "stance": a.output.get("stance"), "conclusion": a.output.get("conclusion"),
                "confidence": a.output.get("confidence"), "missing_data": a.output.get("missing_data", [])[:6],
                "errors": a.output.get("errors", [])[:3], "llm_used": a.output.get("llm_used"), "model": a.model,
                "prompt_version": a.prompt_version,
            },
        })
    return out


def agent_history(db: Session, role: str, limit: int = 20) -> list[dict[str, Any]]:
    rows = db.scalars(select(AgentAnalysis).where(AgentAnalysis.agent_role == role).order_by(AgentAnalysis.id.desc()).limit(limit))
    return [{"id": a.id, "session_id": str(a.session_id), "round": a.round, "status": a.status,
             "created_at": a.created_at.isoformat(), "output": a.output, "error": a.error} for a in rows]


def debate_detail(db: Session, session_id: Any) -> dict[str, Any] | None:
    s = db.get(DebateSession, session_id)
    if s is None:
        return None
    msgs = db.scalars(select(DebateMessage).where(DebateMessage.session_id == s.id).order_by(DebateMessage.id))
    analyses = db.scalars(select(AgentAnalysis).where(AgentAnalysis.session_id == s.id).order_by(AgentAnalysis.id))
    dec = db.scalar(select(Decision).where(Decision.session_id == s.id))
    from app.db.models import DataSnapshot

    snap = db.get(DataSnapshot, s.snapshot_id)
    return {
        "session": debate_summary(s),
        "snapshot": {"id": str(snap.id), "hash": snap.content_hash, "created_at": snap.created_at.isoformat(),
                     "quality": snap.quality_summary, "simulated": snap.is_simulated} if snap else None,
        "messages": [{"id": m.id, "round": m.round, "from": m.from_agent, "to": m.to_agent, "kind": m.kind,
                      "content": m.content, "references": m.references, "reply_to": m.reply_to,
                      "created_at": m.created_at.isoformat()} for m in msgs],
        "analyses": [{"role": a.agent_role, "round": a.round, "status": a.status, "output": a.output,
                      "tokens_in": a.tokens_in, "tokens_out": a.tokens_out} for a in analyses],
        "decision": None if dec is None else {"decision": dec.decision, "details": dec.details,
                                              "risk_decision_id": dec.risk_decision_id, "created_at": dec.created_at.isoformat(), "id": dec.id},
    }


def debate_summary(s: DebateSession) -> dict[str, Any]:
    return {"id": str(s.id), "symbol": s.symbol, "status": s.status, "trigger": s.trigger, "created_at": s.created_at.isoformat(),
            "finished_at": s.finished_at.isoformat() if s.finished_at else None, "rounds_completed": s.rounds_completed,
            "max_rounds": s.max_rounds, "final_decision": s.final_decision, "tokens_used": s.tokens_used,
            "cost_usd": str(s.cost_usd), "error": s.error, "snapshot_id": str(s.snapshot_id), "config": s.config}


def recent_debates(db: Session, limit: int = 20, symbol: str | None = None) -> list[dict[str, Any]]:
    q = select(DebateSession)
    if symbol:
        q = q.where(DebateSession.symbol == symbol)
    return [debate_summary(s) for s in db.scalars(q.order_by(DebateSession.created_at.desc()).limit(limit))]


def latest_veto(db: Session) -> dict[str, Any] | None:
    r = db.scalar(select(RiskDecision).where(RiskDecision.approved.is_(False)).order_by(RiskDecision.id.desc()).limit(1))
    if r is None:
        return None
    return {"id": r.id, "created_at": r.created_at.isoformat(), "symbol": r.symbol, "reasons": r.reasons,
            "session_id": str(r.session_id) if r.session_id else None, "proposal": r.inputs.get("proposal")}


def latest_backtests(db: Session, limit: int = 10) -> list[BacktestRun]:
    return list(db.scalars(select(BacktestRun).order_by(BacktestRun.created_at.desc()).limit(limit)))


def market_snapshot(db: Session, symbol: str) -> dict[str, Any]:
    base = base_asset(symbol)
    c = latest_candles(db, symbol, "1h", 25)
    out: dict[str, Any] = {"symbol": symbol, "price": None}
    if c:
        last = c[-1]
        out.update(price=str(last.close), price_time=last.close_time.isoformat(), price_source=last.source,
                   simulated=last.quality == "simulated",
                   change_24h_pct=float(last.close / c[0].open - 1) if len(c) >= 24 else None,
                   age_seconds=int((utcnow() - last.close_time).total_seconds()))
    metrics = {}
    for asset, metric in ((symbol, "funding_rate"), (symbol, "open_interest"), (base, "price"), (base, "market_cap"), (base, "change_24h_pct")):
        o = db.scalar(select(MarketObservation).where(MarketObservation.asset == asset, MarketObservation.metric == metric)
                      .order_by(MarketObservation.observed_at.desc()).limit(1))
        if o:
            metrics[metric if asset == symbol or metric not in ("price",) else f"spot_{metric}"] = {
                "value": str(o.value), "unit": o.unit, "source": o.source, "observed_at": o.observed_at.isoformat()}
    out["metrics"] = metrics
    return out


def market_context(db: Session) -> dict[str, Any]:
    out = {}
    for asset, metric in (("CRYPTO", "fear_greed_index"), ("CRYPTO", "btc_dominance_pct"), ("CRYPTO", "total_market_cap"),
                          ("DEFI", "total_tvl"), ("STABLECOINS", "total_supply_usd_pegged"), ("MACRO", "ust_10y_yield"),
                          ("MACRO", "usd_broad_index"), ("MACRO", "fed_funds_effective")):
        o = db.scalar(select(MarketObservation).where(MarketObservation.asset == asset, MarketObservation.metric == metric)
                      .order_by(MarketObservation.observed_at.desc()).limit(1))
        out[f"{asset}:{metric}"] = None if o is None else {"value": str(o.value), "unit": o.unit, "source": o.source,
                                                           "observed_at": o.observed_at.isoformat(), "meta": o.meta}
    return out


def market_regime(db: Session, symbol: str = "BTCUSDT") -> dict[str, Any]:
    """Simple, explained regime label from the latest Technical Analyst output."""
    a = db.scalar(select(AgentAnalysis).where(AgentAnalysis.agent_role == "technical").order_by(AgentAnalysis.id.desc()).limit(1))
    if a is None:
        return {"label": "unknown", "basis": "no technical analysis yet"}
    tfs = (a.output.get("metrics") or {}).get("timeframes") or {}
    d1 = tfs.get("1d") or {}
    if not d1:
        return {"label": "unknown", "basis": "insufficient daily data"}
    vol = d1.get("atr_pct")
    trend = {"up": "trending up", "down": "trending down"}.get(d1.get("trend"), "range / mixed")
    return {"label": trend, "volatility_atr_pct_1d": vol, "basis": f"1d EMA alignment from analysis {a.id}",
            "as_of": a.created_at.isoformat(), "simulated": bool(tfs) and "synthetic" in str(a.output.get("source_references"))}


def source_health(db: Session) -> list[dict[str, Any]]:
    from app.data.ingest import SOURCES

    rows = {h.source: h for h in db.scalars(select(SourceHealth))}
    out = []
    for name in SOURCES:
        h = rows.get(name)
        out.append({"source": name, "status": h.status if h else "never_run",
                    "last_success_at": h.last_success_at.isoformat() if h and h.last_success_at else None,
                    "last_error_at": h.last_error_at.isoformat() if h and h.last_error_at else None,
                    "last_error": h.last_error if h else None, "consecutive_failures": h.consecutive_failures if h else 0,
                    "latency_ms": h.last_latency_ms if h else None, "rate_limit": h.rate_limit_info if h else {}})
    return out


def system_status(db: Session) -> dict[str, Any]:
    s = get_settings()
    try:
        db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:  # noqa: BLE001
        db_ok = False
    fresh = freshness_report(db)
    wf_errors = db.scalar(select(func.count()).select_from(WorkflowExecution)
                          .where(WorkflowExecution.status == "error", WorkflowExecution.created_at > utcnow() - timedelta(hours=24))) or 0
    last_wf = db.scalar(select(func.max(WorkflowExecution.created_at)))
    tg_errors = db.scalar(select(func.count()).select_from(TelegramRequest)
                          .where(TelegramRequest.status == "error", TelegramRequest.created_at > utcnow() - timedelta(hours=24))) or 0
    return {
        "as_of": utcnow().isoformat(),
        "mode": "PAPER" if not s.live_trading_enabled else "LIVE",
        "live_trading_enabled": s.live_trading_enabled,
        "emergency_stop": emergency_stop_active(db),
        "database": "ok" if db_ok else "error",
        "llm": "configured" if s.llm_enabled else "not_configured",
        "telegram": "configured" if s.telegram_bot_token.get_secret_value() else "not_configured",
        "mexc": "configured" if s.mexc_configured else "not_configured",
        "n8n_api": "configured" if s.n8n_api_key.get_secret_value() else "not_configured",
        "sources": source_health(db),
        "stale_series": [f["key"] for f in fresh if f["stale"]],
        "series_tracked": len(fresh),
        "simulated_data_present": any(f["quality"] == "simulated" for f in fresh),
        "workflow_errors_24h": wf_errors,
        "last_workflow_report": last_wf.isoformat() if last_wf else None,
        "telegram_errors_24h": tg_errors,
    }
