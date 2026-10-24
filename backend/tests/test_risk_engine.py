from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from decimal import Decimal as D

import pytest

from app.core.util import utcnow
from app.risk.engine import (
    ContractSpec,
    OpenExposure,
    PortfolioState,
    RiskLimits,
    TradeProposal,
    evaluate,
    per_unit_loss,
)

NOW = utcnow()
LIMITS = RiskLimits(
    max_planned_risk_per_trade=D("0.03"), max_daily_loss=D("0.05"), max_portfolio_exposure=D("1.5"),
    max_correlated_risk=D("0.05"), max_drawdown_halt=D("0.20"), drawdown_risk_reduction_start=D("0.10"),
    max_leverage=D("3"), data_stale_after_seconds=900,
)
SPEC = ContractSpec("BTCUSDT", "linear", D("1"), D("0.001"), D("0.001"), D("0.1"), D("20"), D("0.0005"))
PF = PortfolioState(equity=D("10000"), available_margin=D("10000"), peak_equity=D("10000"), realized_pnl_today=D("0"))


def prop(**kw):
    base = dict(symbol="BTCUSDT", side="long", entry_price=D("60000"), stop_loss=D("58800"), take_profit=D("63000"),
                leverage=D("3"), requested_risk_fraction=D("0.01"), data_timestamp=NOW - timedelta(seconds=30),
                funding_rate_8h=D("0.0001"))
    base.update(kw)
    return TradeProposal(**base)


def codes(res):
    return [r.split(":")[0] for r in res.reasons]


def test_approved_trade_respects_budget():
    r = evaluate(prop(), PF, SPEC, LIMITS, NOW)
    assert r.approved and r.verdict == "APPROVED"
    assert r.estimated_loss <= D("100")  # 1% of 10k
    assert r.qty > 0 and r.qty % D("0.001") == 0
    # breakdown adds up to the estimate
    assert sum(r.loss_breakdown.values()) == r.estimated_loss


def test_three_percent_ceiling_is_hard():
    r = evaluate(prop(requested_risk_fraction=D("0.10")), PF, SPEC, LIMITS, NOW)
    assert r.approved and r.verdict == "RESIZED"
    assert r.estimated_loss <= D("300")
    assert r.risk_fraction <= D("0.03")


def test_ceiling_cannot_be_configured_above_three_percent():
    with pytest.raises(ValueError):
        replace(LIMITS, max_planned_risk_per_trade=D("0.05"))


@pytest.mark.parametrize("kw,code", [
    ({"stop_loss": None}, "MISSING_STOP"),
    ({"stop_loss": D("61000")}, "STOP_WRONG_SIDE"),
    ({"side": "short", "stop_loss": D("59000")}, "STOP_WRONG_SIDE"),
    ({"entry_price": D("0")}, "INVALID_PRICE"),
    ({"entry_price": D("-5")}, "INVALID_PRICE"),
    ({"stop_loss": D("-1")}, "INVALID_PRICE"),
    ({"stop_loss": D("59999.9")}, "STOP_TOO_TIGHT"),
    ({"data_timestamp": NOW - timedelta(hours=2)}, "STALE_DATA"),
    ({"data_timestamp": None}, "MISSING_DATA_TIMESTAMP"),
    ({"leverage": D("10")}, "LEVERAGE_LIMIT"),
    ({"take_profit": D("50000")}, "TAKE_PROFIT_INVALID"),
])
def test_invalid_proposals_rejected(kw, code):
    r = evaluate(prop(**kw), PF, SPEC, LIMITS, NOW)
    assert not r.approved and code in codes(r)


def test_unknown_contract_details_rejected():
    assert "UNKNOWN_CONTRACT" in codes(evaluate(prop(), PF, None, LIMITS, NOW))
    assert "UNKNOWN_CONTRACT" in codes(evaluate(prop(), PF, replace(SPEC, contract_multiplier=None), LIMITS, NOW))
    assert "INVALID_PRECISION" in codes(evaluate(prop(), PF, replace(SPEC, qty_step=None), LIMITS, NOW))
    assert "INVALID_PRECISION" in codes(evaluate(prop(), PF, replace(SPEC, price_tick=D("0")), LIMITS, NOW))


def test_emergency_stop_blocks_everything():
    r = evaluate(prop(), replace(PF, emergency_stop=True), SPEC, LIMITS, NOW)
    assert codes(r) == ["EMERGENCY_STOP"]


def test_daily_loss_limit():
    r = evaluate(prop(), replace(PF, realized_pnl_today=D("-500")), SPEC, LIMITS, NOW)
    assert "DAILY_LOSS_LIMIT" in codes(r)
    # partially used: budget shrinks to what's left
    r2 = evaluate(prop(requested_risk_fraction=D("0.03")), replace(PF, realized_pnl_today=D("-450")), SPEC, LIMITS, NOW)
    assert r2.approved and r2.estimated_loss <= D("50")


def test_drawdown_halt_and_reduction():
    halted = replace(PF, equity=D("7900"), peak_equity=D("10000"), available_margin=D("7900"))
    assert "DRAWDOWN_HALT" in codes(evaluate(prop(), halted, SPEC, LIMITS, NOW))
    reduced = replace(PF, equity=D("8500"), peak_equity=D("10000"), available_margin=D("8500"))
    r = evaluate(prop(requested_risk_fraction=D("0.02")), reduced, SPEC, LIMITS, NOW)
    assert r.approved and r.risk_fraction < D("0.02")


def test_correlated_risk_cap():
    pf = replace(PF, open_positions=(OpenExposure("ETHUSDT", "long", D("3000"), D("500")),))
    assert "CORRELATED_RISK" in codes(evaluate(prop(), pf, SPEC, LIMITS, NOW))
    # opposite direction is not added to the same-direction bucket
    pf2 = replace(PF, open_positions=(OpenExposure("ETHUSDT", "short", D("3000"), D("500")),))
    assert evaluate(prop(), pf2, SPEC, LIMITS, NOW).approved


def test_portfolio_exposure_cap():
    pf = replace(PF, open_positions=(OpenExposure("SOLUSDT", "short", D("15000"), D("10")),))
    assert "PORTFOLIO_EXPOSURE" in codes(evaluate(prop(), pf, SPEC, LIMITS, NOW))


def test_insufficient_margin_resizes_or_rejects():
    r = evaluate(prop(), replace(PF, available_margin=D("1000")), SPEC, LIMITS, NOW)
    assert r.approved and r.verdict == "RESIZED" and r.margin_required <= D("1000")
    r2 = evaluate(prop(), replace(PF, available_margin=D("5")), SPEC, LIMITS, NOW)
    assert "SIZE_BELOW_MINIMUM" in codes(r2)


def test_duplicate_prevention():
    assert "DUPLICATE_ORDER" in codes(evaluate(prop(idempotency_key="k1"), replace(PF, seen_idempotency_keys=frozenset({"k1"})), SPEC, LIMITS, NOW))
    pf = replace(PF, open_positions=(OpenExposure("BTCUSDT", "long", D("100"), D("1")),))
    assert "DUPLICATE_POSITION" in codes(evaluate(prop(), pf, SPEC, LIMITS, NOW))


def test_liquidation_before_stop_rejected():
    limits = replace(LIMITS, max_leverage=D("20"))
    # 20x long: liquidation ~5% below entry; stop 8% below is unsafe
    r = evaluate(prop(leverage=D("20"), stop_loss=D("55200")), PF, SPEC, limits, NOW)
    assert "LIQUIDATION_BEFORE_STOP" in codes(r)


def test_spot_short_rejected():
    spot = replace(SPEC, kind="spot", max_leverage=D("1"))
    r = evaluate(prop(side="short", stop_loss=D("61200"), take_profit=None, leverage=D("1")), PF, spot, LIMITS, NOW)
    assert "SHORT_NOT_SUPPORTED" in codes(r)


def test_linear_loss_formula():
    u = per_unit_loss(SPEC, "long", D("100"), D("90"), D("0.001"), D("0"), D("8"))
    assert u["price_loss"] == D("10")
    assert u["fees"] == D("100") * D("0.0005") + D("90") * D("0.0005")
    assert u["slippage"] == D("0.090")
    assert u["funding"] == 0


def test_inverse_loss_formula():
    inv = ContractSpec("BTCUSD", "inverse", D("100"), D("1"), D("1"), D("0.5"), D("20"), D("0.0005"))
    u = per_unit_loss(inv, "long", D("50000"), D("40000"), D("0"), D("0"), D("8"))
    # 100 USD contract: coin loss = 100*(1/40000-1/50000)=0.0005 BTC; at 40000 => 20 USD
    assert u["price_loss"] == D("20")
    r = evaluate(prop(symbol="BTCUSD", entry_price=D("50000"), stop_loss=D("40000"), take_profit=None, leverage=D("1")),
                 PF, inv, LIMITS, NOW)
    assert r.approved and r.estimated_loss <= D("100")


def test_adverse_funding_only():
    u_long = per_unit_loss(SPEC, "long", D("100"), D("90"), D("0"), D("0.001"), D("16"))
    u_short = per_unit_loss(SPEC, "short", D("100"), D("110"), D("0"), D("0.001"), D("16"))
    assert u_long["funding"] == D("0.2") and u_short["funding"] == 0


def test_unknown_funding_assumed_conservatively():
    r = evaluate(prop(funding_rate_8h=None), PF, SPEC, LIMITS, NOW)
    assert r.approved and any(c.name == "FUNDING_ASSUMED" for c in r.checks)
    assert r.loss_breakdown["funding"] > 0
