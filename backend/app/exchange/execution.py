"""Execution adapter: separates signal -> risk validation -> order preparation ->
submission -> response handling -> reconciliation -> audit.

Submission is DISABLED. `submit` always raises before any network call. Enabling
it requires a code change plus every gate in docs/LIVE_TRADING_GATES.md; the
config flag alone cannot do it (and startup refuses LIVE_TRADING_ENABLED=true).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.audit import audit
from app.db.models import RiskDecision
from app.paper.engine import verify_risk_decision

LIVE_EXECUTION_IMPLEMENTED = False

OrderState = Literal["PREPARED", "SUBMITTED", "NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "REJECTED", "UNKNOWN"]
TERMINAL = {"FILLED", "CANCELED", "REJECTED"}


class LiveTradingDisabled(Exception):
    pass


@dataclass
class PreparedOrder:
    client_order_id: str
    symbol: str
    side: str
    qty: Decimal
    stop_loss: Decimal
    take_profit: Decimal | None
    risk_decision_id: int
    state: OrderState = "PREPARED"
    filled_qty: Decimal = Decimal(0)
    history: list[dict[str, Any]] = field(default_factory=list)


def prepare_order(risk_row: RiskDecision) -> PreparedOrder:
    if not risk_row.approved:
        raise ValueError("risk decision not approved")
    if not verify_risk_decision(risk_row):
        raise ValueError("risk decision integrity check failed")
    p, r = risk_row.inputs["proposal"], risk_row.result
    return PreparedOrder(client_order_id=f"tcc-{risk_row.id}", symbol=risk_row.symbol, side="BUY" if p["side"] == "long" else "SELL",
                         qty=Decimal(r["qty"]), stop_loss=Decimal(p["stop_loss"]),
                         take_profit=Decimal(p["take_profit"]) if p.get("take_profit") else None, risk_decision_id=risk_row.id)


def submit(db: Session, order: PreparedOrder, actor: str) -> None:
    """Always refuses. Recorded in the audit log so attempts are visible."""
    audit(db, actor, "execution.submit_refused", order.client_order_id,
          {"symbol": order.symbol, "reason": "live trading disabled", "implemented": LIVE_EXECUTION_IMPLEMENTED})
    if not LIVE_EXECUTION_IMPLEMENTED or not get_settings().live_trading_enabled:
        raise LiveTradingDisabled("Live order submission is disabled. Paper trading only.")
    raise LiveTradingDisabled("unreachable")  # pragma: no cover


def reconcile(order: PreparedOrder, exchange_state: str | None, exchange_filled: Decimal | None) -> PreparedOrder:
    """Apply an exchange status report to a local order without ever guessing.

    * Unknown/missing status -> UNKNOWN; the order is treated as potentially live
      (blocks new orders for the symbol) until a definitive status arrives.
    * Filled quantity can only increase; a decrease is an inconsistency -> UNKNOWN.
    * Terminal states are sticky.
    """
    prev = order.state
    mapping = {"NEW": "NEW", "PARTIALLY_FILLED": "PARTIALLY_FILLED", "FILLED": "FILLED",
               "CANCELED": "CANCELED", "PARTIALLY_CANCELED": "CANCELED", "REJECTED": "REJECTED", "EXPIRED": "CANCELED"}
    if prev in TERMINAL:
        order.history.append({"ignored": exchange_state, "reason": "terminal state"})
        return order
    new = mapping.get((exchange_state or "").upper(), "UNKNOWN")
    if exchange_filled is not None:
        if exchange_filled < order.filled_qty or exchange_filled > order.qty:
            new = "UNKNOWN"
        else:
            order.filled_qty = exchange_filled
    if new == "FILLED" and order.filled_qty < order.qty:
        new = "PARTIALLY_FILLED"
    order.state = new  # type: ignore[assignment]
    order.history.append({"from": prev, "to": new, "exchange_state": exchange_state, "filled": str(order.filled_qty)})
    return order


def blocks_new_orders(order: PreparedOrder) -> bool:
    return order.state not in TERMINAL
