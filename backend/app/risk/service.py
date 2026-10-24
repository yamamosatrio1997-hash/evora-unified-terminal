"""Glue between the pure Risk Engine and persistence/configuration."""
from __future__ import annotations

import uuid
from dataclasses import asdict
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.events import emit
from app.core.util import canonical_json, jsonable, sha256_hex, utcnow
from app.db.models import RiskDecision, RiskState
from app.risk.engine import (
    ENGINE_VERSION,
    ContractSpec,
    PortfolioState,
    RiskLimits,
    RiskResult,
    TradeProposal,
    evaluate,
)

# Contract specifications of the *paper* venue. They model a USDT-margined linear
# perpetual with typical retail-tier parameters. They are configuration of the
# simulator, not claims about any exchange; live use must load specs from the
# exchange (see app/exchange/mexc.py) and will reject when they are unavailable.
PAPER_SPECS: dict[str, ContractSpec] = {
    "BTCUSDT": ContractSpec("BTCUSDT", "linear", Decimal("1"), Decimal("0.001"), Decimal("0.001"), Decimal("0.1"),
                            Decimal("20"), Decimal("0.0005"), Decimal("0.005"), source="paper_venue_config"),
    "ETHUSDT": ContractSpec("ETHUSDT", "linear", Decimal("1"), Decimal("0.01"), Decimal("0.01"), Decimal("0.01"),
                            Decimal("20"), Decimal("0.0005"), Decimal("0.005"), source="paper_venue_config"),
}


def limits_from_settings() -> RiskLimits:
    s = get_settings()
    return RiskLimits(
        max_planned_risk_per_trade=s.max_planned_risk_per_trade,
        max_daily_loss=s.max_daily_loss,
        max_portfolio_exposure=s.max_portfolio_exposure,
        max_correlated_risk=s.max_correlated_risk,
        max_drawdown_halt=s.max_drawdown_halt,
        drawdown_risk_reduction_start=s.drawdown_risk_reduction_start,
        max_leverage=s.max_leverage,
        data_stale_after_seconds=s.data_stale_after_seconds,
    )


def emergency_stop_active(db: Session) -> bool:
    st = db.get(RiskState, 1)
    return bool(st and st.emergency_stop)


def set_emergency_stop(db: Session, active: bool, reason: str, actor: str) -> RiskState:
    st = db.get(RiskState, 1) or RiskState(id=1)
    st.emergency_stop, st.reason, st.updated_by, st.updated_at = active, reason, actor, utcnow()
    db.merge(st)
    emit(db, "risk.emergency_stop", active=active, reason=reason, actor=actor)
    return st


def evaluate_and_record(db: Session, proposal: TradeProposal, portfolio: PortfolioState, spec: ContractSpec | None,
                        session_id: uuid.UUID | None = None) -> tuple[RiskResult, RiskDecision]:
    limits = limits_from_settings()
    now = utcnow()
    result = evaluate(proposal, portfolio, spec, limits, now)
    inputs = jsonable({
        "proposal": asdict(proposal),
        "portfolio": {**asdict(portfolio), "seen_idempotency_keys": len(portfolio.seen_idempotency_keys)},
        "spec": asdict(spec) if spec else None,
        "limits": asdict(limits),
        "evaluated_at": now,
    })
    out = jsonable(result.to_dict())
    digest = sha256_hex(canonical_json({"inputs": inputs, "result": out}))
    row = RiskDecision(session_id=session_id, symbol=proposal.symbol, approved=result.approved, reasons=out["reasons"],
                       inputs=inputs, result=out, engine_version=ENGINE_VERSION, hash=digest)
    db.add(row)
    db.flush()
    emit(db, "risk.decision", agent="risk", session_id=session_id, risk_decision_id=row.id,
         symbol=proposal.symbol, verdict=result.verdict, reasons=result.reasons[:5])
    return result, row


def recent_decisions(db: Session, limit: int = 50) -> list[dict[str, Any]]:
    rows = db.scalars(select(RiskDecision).order_by(RiskDecision.id.desc()).limit(limit)).all()
    return [{"id": r.id, "created_at": r.created_at.isoformat(), "symbol": r.symbol, "approved": r.approved,
             "verdict": r.result.get("verdict"), "reasons": r.reasons, "session_id": str(r.session_id) if r.session_id else None,
             "estimated_loss": r.result.get("estimated_loss"), "risk_fraction": r.result.get("risk_fraction"),
             "hash": r.hash} for r in rows]
