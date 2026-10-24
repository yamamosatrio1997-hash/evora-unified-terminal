"""Paper-trading engine (simulation only).

This module imports no exchange client and has no network access. An entry can
only be created from a persisted, approved RiskDecision whose hash verifies and
that is recent; the fill is re-validated against the price the Risk Engine used.
Paper balances are never mixed with exchange balances.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.events import emit
from app.core.util import canonical_json, sha256_hex, utcnow
from app.data.snapshot import latest_candles, latest_price
from app.db.models import (
    PaperAccount,
    PaperEquitySnapshot,
    PaperOrder,
    PaperPosition,
    RiskDecision,
)
from app.risk.engine import OpenExposure, PortfolioState
from app.risk.service import PAPER_SPECS, emergency_stop_active

ZERO = Decimal(0)
SLIPPAGE_RATE = Decimal("0.0005")
RISK_DECISION_TTL = timedelta(minutes=15)
MAX_ENTRY_DRIFT = Decimal("0.005")  # fill must be within 0.5% of the risk-evaluated entry
PARTICIPATION_CAP = Decimal("0.10")  # max share of last bar volume a simulated order may take


class PaperOrderRejected(Exception):
    pass


def get_account(db: Session, name: str = "default") -> PaperAccount:
    acct = db.scalar(select(PaperAccount).where(PaperAccount.name == name))
    if acct is None:
        eq = get_settings().paper_starting_equity
        acct = PaperAccount(name=name, starting_equity=eq, cash=eq, peak_equity=eq)
        db.add(acct)
        db.flush()
    return acct


def open_positions(db: Session, acct: PaperAccount) -> list[PaperPosition]:
    return list(db.scalars(select(PaperPosition).where(PaperPosition.account_id == acct.id, PaperPosition.status == "open")))


def _mark(db: Session, symbol: str) -> tuple[Decimal | None, Any]:
    px, ts, _ = latest_price(db, symbol)
    return px, ts


def valuation(db: Session, acct: PaperAccount) -> dict[str, Any]:
    unreal = ZERO
    notional = ZERO
    stale_marks = []
    now = utcnow()
    for p in open_positions(db, acct):
        px, ts = _mark(db, p.symbol)
        if px is None:
            stale_marks.append(p.symbol)
            px = p.entry_price
        elif (now - ts).total_seconds() > 7200:
            stale_marks.append(p.symbol)
        sign = 1 if p.side == "long" else -1
        unreal += sign * (px - p.entry_price) * p.qty
        notional += px * p.qty
    equity = acct.cash + unreal
    peak = max(acct.peak_equity, equity)
    return {"equity": equity, "cash": acct.cash, "unrealized_pnl": unreal, "notional": notional,
            "drawdown": (peak - equity) / peak if peak > 0 else ZERO, "peak_equity": peak, "stale_marks": stale_marks}


def realized_today(db: Session, acct: PaperAccount) -> Decimal:
    start = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    return db.scalar(select(func.coalesce(func.sum(PaperPosition.realized_pnl), 0)).where(
        PaperPosition.account_id == acct.id, PaperPosition.closed_at >= start)) or ZERO


def portfolio_state(db: Session, acct: PaperAccount) -> PortfolioState:
    v = valuation(db, acct)
    s = get_settings()
    positions = open_positions(db, acct)
    margin_used = sum((p.entry_price * p.qty for p in positions), ZERO) / s.max_leverage
    keys = frozenset(db.scalars(select(PaperOrder.client_order_id).where(PaperOrder.account_id == acct.id)))
    return PortfolioState(
        equity=v["equity"], available_margin=max(ZERO, v["equity"] - margin_used), peak_equity=v["peak_equity"],
        realized_pnl_today=realized_today(db, acct),
        open_positions=tuple(OpenExposure(p.symbol, p.side, p.entry_price * p.qty, p.planned_risk) for p in positions),
        emergency_stop=emergency_stop_active(db), seen_idempotency_keys=keys,
    )


def verify_risk_decision(row: RiskDecision) -> bool:
    return sha256_hex(canonical_json({"inputs": row.inputs, "result": row.result})) == row.hash


def submit_entry_from_risk(db: Session, risk_row: RiskDecision, session_id: uuid.UUID | None = None,
                           acct: PaperAccount | None = None) -> PaperOrder:
    acct = acct or get_account(db)
    coid = f"paper-risk-{risk_row.id}"
    existing = db.scalar(select(PaperOrder).where(PaperOrder.client_order_id == coid))
    if existing:
        return existing  # idempotent: retries never create a second order
    proposal = risk_row.inputs["proposal"]
    result = risk_row.result
    order = PaperOrder(account_id=acct.id, client_order_id=coid, symbol=risk_row.symbol,
                       side="buy" if proposal["side"] == "long" else "sell", order_type="market", purpose="entry",
                       qty=Decimal(result["qty"] or "0"), stop_loss=Decimal(proposal["stop_loss"]),
                       take_profit=Decimal(proposal["take_profit"]) if proposal.get("take_profit") else None,
                       status="NEW", risk_decision_id=risk_row.id, session_id=session_id)
    db.add(order)
    db.flush()

    def reject(reason: str) -> PaperOrder:
        order.status, order.reject_reason, order.updated_at = "REJECTED", reason, utcnow()
        emit(db, "paper.order_rejected", order_id=order.id, reason=reason, symbol=order.symbol)
        db.flush()
        return order

    if not risk_row.approved:
        return reject("risk decision was not approved")
    if not verify_risk_decision(risk_row):
        return reject("risk decision hash mismatch (record integrity failure)")
    if utcnow() - risk_row.created_at > RISK_DECISION_TTL:
        return reject("risk decision expired; re-evaluate with fresh data")
    if emergency_stop_active(db):
        return reject("emergency stop active")
    if risk_row.symbol not in PAPER_SPECS:
        return reject("no paper contract specification")
    px, ts = _mark(db, risk_row.symbol)
    if px is None or ts is None or (utcnow() - ts).total_seconds() > get_settings().data_stale_after_seconds:
        return reject("no fresh price to simulate a fill")
    planned_entry = Decimal(proposal["entry_price"])
    if abs(px - planned_entry) / planned_entry > MAX_ENTRY_DRIFT:
        return reject(f"price moved {abs(px - planned_entry) / planned_entry:.2%} from the risk-evaluated entry")
    d = 1 if proposal["side"] == "long" else -1
    stop = Decimal(proposal["stop_loss"])
    if (d == 1 and px <= stop) or (d == -1 and px >= stop):
        return reject("price already beyond stop-loss")
    spec = PAPER_SPECS[risk_row.symbol]
    fill_px = px * (1 + d * SLIPPAGE_RATE)
    qty = order.qty
    bars = latest_candles(db, risk_row.symbol, "1h", 1)
    if bars:
        cap = (bars[-1].volume * PARTICIPATION_CAP).quantize(spec.qty_step) if bars[-1].volume else qty
        if cap < qty:
            qty = (cap // spec.qty_step) * spec.qty_step
    if qty < spec.min_qty:
        return reject("simulated liquidity insufficient for minimum size")
    fee = fill_px * qty * spec.taker_fee_rate
    order.filled_qty, order.avg_fill_price, order.fee = qty, fill_px, fee
    order.slippage_cost = abs(fill_px - px) * qty
    order.status = "FILLED" if qty == order.qty else "PARTIALLY_FILLED_CANCELED"
    order.updated_at = utcnow()
    planned_risk = Decimal(result["estimated_loss"]) * (qty / order.qty)
    pos = PaperPosition(account_id=acct.id, symbol=order.symbol, side=proposal["side"], qty=qty, entry_price=fill_px,
                        stop_loss=stop, take_profit=order.take_profit, planned_risk=planned_risk, status="open", fees=fee)
    db.add(pos)
    acct.cash -= fee
    db.flush()
    order.position_id = pos.id
    emit(db, "paper.order_filled", order_id=order.id, position_id=pos.id, symbol=order.symbol, side=pos.side,
         qty=str(qty), price=str(fill_px), partial=order.status != "FILLED", simulated=True)
    record_equity(db, acct)
    return order


def close_position(db: Session, acct: PaperAccount, pos: PaperPosition, raw_price: Decimal, reason: str) -> PaperPosition:
    d = 1 if pos.side == "long" else -1
    fill = raw_price * (1 - d * SLIPPAGE_RATE)
    spec = PAPER_SPECS.get(pos.symbol)
    fee = fill * pos.qty * (spec.taker_fee_rate if spec else Decimal("0.0005"))
    gross = d * (fill - pos.entry_price) * pos.qty
    pos.status, pos.closed_at, pos.exit_price, pos.exit_reason = "closed", utcnow(), fill, reason
    pos.fees += fee
    pos.realized_pnl = gross - pos.fees
    acct.cash += gross - fee
    db.add(PaperOrder(account_id=acct.id, client_order_id=f"paper-exit-{pos.id}", symbol=pos.symbol,
                      side="sell" if d == 1 else "buy", order_type="market", purpose="exit", qty=pos.qty,
                      status="FILLED", filled_qty=pos.qty, avg_fill_price=fill, fee=fee,
                      slippage_cost=abs(fill - raw_price) * pos.qty, position_id=pos.id))
    db.flush()
    emit(db, "paper.position_closed", position_id=pos.id, symbol=pos.symbol, reason=reason,
         realized_pnl=str(pos.realized_pnl), simulated=True)
    return pos


def mark_to_market(db: Session, acct: PaperAccount | None = None) -> dict[str, Any]:
    """Check stops/targets against closed 1h bars since entry (stop first if both)."""
    acct = acct or get_account(db)
    closed = []
    for pos in open_positions(db, acct):
        for bar in latest_candles(db, pos.symbol, "1h", 500):
            if bar.open_time < pos.opened_at:
                continue
            d = 1 if pos.side == "long" else -1
            hit_stop = bar.low <= pos.stop_loss if d == 1 else bar.high >= pos.stop_loss
            hit_tp = pos.take_profit is not None and (bar.high >= pos.take_profit if d == 1 else bar.low <= pos.take_profit)
            if hit_stop:
                px = min(pos.stop_loss, bar.open) if d == 1 else max(pos.stop_loss, bar.open)
                closed.append(close_position(db, acct, pos, px, "stop_loss").id)
                break
            if hit_tp:
                closed.append(close_position(db, acct, pos, pos.take_profit, "take_profit").id)
                break
    snap = record_equity(db, acct)
    return {"closed_positions": closed, "equity": str(snap.equity), "drawdown": str(snap.drawdown)}


def record_equity(db: Session, acct: PaperAccount) -> PaperEquitySnapshot:
    v = valuation(db, acct)
    acct.peak_equity = v["peak_equity"]
    snap = PaperEquitySnapshot(account_id=acct.id, equity=v["equity"], cash=v["cash"], unrealized_pnl=v["unrealized_pnl"],
                               drawdown=v["drawdown"], marks_stale=bool(v["stale_marks"]))
    db.add(snap)
    db.flush()
    return snap


def performance(db: Session, acct: PaperAccount | None = None, since: Any = None) -> dict[str, Any]:
    acct = acct or get_account(db)
    q = select(PaperPosition).where(PaperPosition.account_id == acct.id, PaperPosition.status == "closed")
    if since is not None:
        q = q.where(PaperPosition.closed_at >= since)
    closed = list(db.scalars(q.order_by(PaperPosition.closed_at)))
    pnls = [p.realized_pnl or ZERO for p in closed]
    wins = [x for x in pnls if x > 0]
    losses = [x for x in pnls if x <= 0]
    gl = -sum(losses, ZERO)
    v = valuation(db, acct)
    eq_q = select(PaperEquitySnapshot).where(PaperEquitySnapshot.account_id == acct.id)
    if since is not None:
        eq_q = eq_q.where(PaperEquitySnapshot.ts >= since)
    curve = list(db.scalars(eq_q.order_by(PaperEquitySnapshot.ts)))
    max_dd = max((c.drawdown for c in curve), default=ZERO)
    n = len(pnls)
    return {
        "data_kind": "PAPER (simulated)",
        "as_of": utcnow().isoformat(),
        "methodology": "Equity = cash + unrealized P&L at latest candle close; fees 0.05%/side, slippage 0.05%/side; drawdown from equity snapshots.",
        "starting_equity": str(acct.starting_equity), "equity": str(v["equity"]), "cash": str(v["cash"]),
        "unrealized_pnl": str(v["unrealized_pnl"]), "realized_pnl": str(sum(pnls, ZERO)),
        "return_pct": str((v["equity"] / acct.starting_equity - 1) if acct.starting_equity else ZERO),
        "current_drawdown": str(v["drawdown"]), "max_drawdown_period": str(max_dd),
        "fees": str(sum((p.fees for p in closed), ZERO)),
        "trades": n, "win_rate": (len(wins) / n) if n else None,
        "profit_factor": float(sum(wins, ZERO) / gl) if gl > 0 else None,
        "expectancy": str(sum(pnls, ZERO) / n) if n else None,
        "open_positions": len(open_positions(db, acct)), "exposure_notional": str(v["notional"]),
        "stale_marks": v["stale_marks"],
        "equity_curve": [{"ts": c.ts.isoformat(), "equity": float(c.equity), "drawdown": float(c.drawdown)} for c in curve[-500:]],
    }
