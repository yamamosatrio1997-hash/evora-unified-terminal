"""Deterministic Risk Engine.

Pure functions over Decimal. No LLM, workflow or Fund Manager input can change
its limits or override a rejection: callers receive a result; only `approved`
results can be turned into (paper) orders, and the paper engine re-checks the
recorded decision before filling.

Planned risk is an estimate. Realized loss can exceed it because of price gaps,
slippage beyond assumptions, liquidation, exchange outages or execution failures.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from decimal import ROUND_DOWN, Decimal, InvalidOperation
from typing import Any, Literal

ENGINE_VERSION = "1.0.0"
ZERO = Decimal(0)
ONE = Decimal(1)

DISCLOSURE = (
    "Planned risk is an estimate at the stop price. Realized losses can exceed it because of "
    "gaps, slippage, liquidation, outages or execution failures."
)

# Crypto majors move together; treat them as one correlation group (conservative).
CORRELATION_GROUPS = {"BTC": "crypto_beta", "ETH": "crypto_beta", "SOL": "crypto_beta", "BNB": "crypto_beta"}
DEFAULT_FUNDING_ASSUMPTION_8H = Decimal("0.0003")  # used when the live rate is unknown


@dataclass(frozen=True)
class ContractSpec:
    symbol: str
    kind: Literal["spot", "linear", "inverse"]
    contract_multiplier: Decimal | None  # linear: base units per contract; inverse: USD per contract; spot: 1
    qty_step: Decimal | None
    min_qty: Decimal | None
    price_tick: Decimal | None
    max_leverage: Decimal
    taker_fee_rate: Decimal
    maintenance_margin_rate: Decimal = Decimal("0.005")
    source: str = "config"


@dataclass(frozen=True)
class RiskLimits:
    max_planned_risk_per_trade: Decimal
    max_daily_loss: Decimal
    max_portfolio_exposure: Decimal
    max_correlated_risk: Decimal
    max_drawdown_halt: Decimal
    drawdown_risk_reduction_start: Decimal
    max_leverage: Decimal
    data_stale_after_seconds: int
    slippage_rate: Decimal = Decimal("0.0005")

    def __post_init__(self) -> None:
        if not (ZERO < self.max_planned_risk_per_trade <= Decimal("0.03")):
            raise ValueError("risk ceiling must be in (0, 3%]")


@dataclass(frozen=True)
class OpenExposure:
    symbol: str
    side: str
    notional: Decimal
    planned_risk: Decimal


@dataclass(frozen=True)
class PortfolioState:
    equity: Decimal
    available_margin: Decimal
    peak_equity: Decimal
    realized_pnl_today: Decimal
    open_positions: tuple[OpenExposure, ...] = ()
    emergency_stop: bool = False
    seen_idempotency_keys: frozenset[str] = frozenset()


@dataclass(frozen=True)
class TradeProposal:
    symbol: str
    side: Literal["long", "short"]
    entry_price: Decimal | None
    stop_loss: Decimal | None
    take_profit: Decimal | None
    leverage: Decimal
    requested_risk_fraction: Decimal | None
    data_timestamp: datetime | None
    expected_holding_hours: Decimal = Decimal(24)
    funding_rate_8h: Decimal | None = None
    idempotency_key: str | None = None


@dataclass
class Check:
    name: str
    passed: bool
    detail: str
    severity: Literal["reject", "resize", "info"] = "reject"


@dataclass
class RiskResult:
    approved: bool
    verdict: Literal["APPROVED", "RESIZED", "REJECTED"]
    symbol: str
    side: str
    qty: Decimal = ZERO
    notional: Decimal = ZERO
    margin_required: Decimal = ZERO
    estimated_loss: Decimal = ZERO
    loss_breakdown: dict[str, Decimal] = field(default_factory=dict)
    risk_fraction: Decimal = ZERO
    risk_budget: Decimal = ZERO
    reasons: list[str] = field(default_factory=list)
    checks: list[Check] = field(default_factory=list)
    disclosure: str = DISCLOSURE
    engine_version: str = ENGINE_VERSION

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _dec(x: Any) -> Decimal | None:
    if x is None:
        return None
    try:
        d = x if isinstance(x, Decimal) else Decimal(str(x))
    except (InvalidOperation, ValueError):
        return None
    return d if d.is_finite() else None


def _floor_step(q: Decimal, step: Decimal) -> Decimal:
    return (q / step).to_integral_value(rounding=ROUND_DOWN) * step


def per_unit_loss(spec: ContractSpec, side: str, entry: Decimal, stop: Decimal, slippage_rate: Decimal,
                  funding_8h: Decimal, holding_hours: Decimal) -> dict[str, Decimal]:
    """Estimated USD loss per one unit of quantity (contract or base unit) if stopped.

    linear/spot: notional = qty * mult * price; price loss = qty * mult * |entry - stop|
    inverse:     notional(USD) = qty * mult; coin loss = qty * mult * |1/stop - 1/entry|,
                 valued in USD at the stop price.
    """
    mult = spec.contract_multiplier or ONE
    fee = spec.taker_fee_rate
    if spec.kind in ("spot", "linear"):
        price_loss = mult * abs(entry - stop)
        entry_notional = mult * entry
        exit_notional = mult * stop
    else:  # inverse
        coin_loss = mult * abs(ONE / stop - ONE / entry)
        price_loss = coin_loss * stop
        entry_notional = mult
        exit_notional = mult
    fees = entry_notional * fee + exit_notional * fee
    slippage = exit_notional * slippage_rate
    funding = ZERO
    if spec.kind != "spot":
        # Only adverse funding increases loss: longs pay positive, shorts pay negative.
        adverse = funding_8h if side == "long" else -funding_8h
        if adverse > 0:
            funding = entry_notional * adverse * holding_hours / Decimal(8)
    return {"price_loss": price_loss, "fees": fees, "slippage": slippage, "funding": funding,
            "total": price_loss + fees + slippage + funding, "entry_notional": entry_notional}


def _liquidation_price(spec: ContractSpec, side: str, entry: Decimal, leverage: Decimal) -> Decimal | None:
    """Isolated-margin approximation; exchanges differ in detail, so the check keeps a buffer."""
    if spec.kind == "spot" or leverage <= ONE:
        return None
    im = ONE / leverage
    mmr = spec.maintenance_margin_rate
    if spec.kind == "linear":
        return entry * (ONE - im + mmr) if side == "long" else entry * (ONE + im - mmr)
    # inverse
    if side == "long":
        return entry / (ONE + im - mmr)
    denom = ONE - im + mmr
    return entry / denom if denom > 0 else None


def evaluate(p: TradeProposal, pf: PortfolioState, spec: ContractSpec | None, limits: RiskLimits, now: datetime) -> RiskResult:
    res = RiskResult(approved=False, verdict="REJECTED", symbol=p.symbol, side=p.side)
    checks = res.checks

    def reject(name: str, detail: str) -> RiskResult:
        checks.append(Check(name, False, detail))
        res.reasons.append(f"{name}: {detail}")
        return res

    # ---- hard gates that make sizing impossible or unsafe ---------------------
    if pf.emergency_stop:
        return reject("EMERGENCY_STOP", "emergency stop is active")
    if p.idempotency_key and p.idempotency_key in pf.seen_idempotency_keys:
        return reject("DUPLICATE_ORDER", "idempotency key already used")
    if any(o.symbol == p.symbol and o.side == p.side for o in pf.open_positions):
        return reject("DUPLICATE_POSITION", f"an open {p.side} position in {p.symbol} already exists")
    equity = _dec(pf.equity)
    if equity is None or equity <= 0:
        return reject("NON_POSITIVE_EQUITY", "equity must be positive")
    if spec is None:
        return reject("UNKNOWN_CONTRACT", "contract specification unavailable")
    if spec.contract_multiplier is None or spec.contract_multiplier <= 0:
        return reject("UNKNOWN_CONTRACT", "contract multiplier missing or non-positive")
    if spec.qty_step is None or spec.qty_step <= 0 or spec.min_qty is None or spec.min_qty <= 0:
        return reject("INVALID_PRECISION", "quantity step / minimum quantity unknown")
    if spec.price_tick is None or spec.price_tick <= 0:
        return reject("INVALID_PRECISION", "price tick unknown")
    entry, stop = _dec(p.entry_price), _dec(p.stop_loss)
    if entry is None or entry <= 0:
        return reject("INVALID_PRICE", "entry price missing, zero or negative")
    if stop is None:
        return reject("MISSING_STOP", "stop-loss is required")
    if stop <= 0:
        return reject("INVALID_PRICE", "stop-loss must be positive")
    if (p.side == "long" and stop >= entry) or (p.side == "short" and stop <= entry):
        return reject("STOP_WRONG_SIDE", f"stop {stop} is on the wrong side of entry {entry} for a {p.side}")
    if abs(entry - stop) < 2 * spec.price_tick:
        return reject("STOP_TOO_TIGHT", "stop distance is below two price ticks")
    tp = _dec(p.take_profit)
    if p.take_profit is not None and (tp is None or (p.side == "long" and tp <= entry) or (p.side == "short" and tp >= entry)):
        return reject("TAKE_PROFIT_INVALID", "take-profit is on the wrong side of entry")
    if spec.kind == "spot" and p.side == "short":
        return reject("SHORT_NOT_SUPPORTED", "spot instruments cannot be shorted")
    if p.data_timestamp is None:
        return reject("MISSING_DATA_TIMESTAMP", "price timestamp unknown")
    age = (now - p.data_timestamp).total_seconds()
    if age > limits.data_stale_after_seconds or age < -60:
        return reject("STALE_DATA", f"price data age {int(age)}s exceeds {limits.data_stale_after_seconds}s")
    checks.append(Check("DATA_FRESHNESS", True, f"price age {int(age)}s", "info"))
    lev = _dec(p.leverage) or ONE
    if lev <= 0 or lev > limits.max_leverage or lev > spec.max_leverage:
        return reject("LEVERAGE_LIMIT", f"leverage {lev} exceeds limit {min(limits.max_leverage, spec.max_leverage)}")
    if spec.kind == "spot" and lev != ONE:
        return reject("LEVERAGE_LIMIT", "spot trades must use leverage 1")

    peak = max(_dec(pf.peak_equity) or equity, equity)
    drawdown = (peak - equity) / peak
    if drawdown >= limits.max_drawdown_halt:
        return reject("DRAWDOWN_HALT", f"drawdown {drawdown:.2%} >= halt level {limits.max_drawdown_halt:.2%}")
    daily_loss = max(ZERO, -(_dec(pf.realized_pnl_today) or ZERO))
    daily_cap = limits.max_daily_loss * equity
    if daily_loss >= daily_cap:
        return reject("DAILY_LOSS_LIMIT", f"today's realized loss {daily_loss:.2f} reached the cap {daily_cap:.2f}")

    # ---- risk budget ------------------------------------------------------------
    ceiling = limits.max_planned_risk_per_trade
    requested = _dec(p.requested_risk_fraction) or ceiling
    if requested <= 0:
        return reject("INVALID_RISK_REQUEST", "requested risk must be positive")
    fraction = min(requested, ceiling)
    if requested > ceiling:
        checks.append(Check("RISK_CEILING", True, f"requested {requested:.2%} clamped to ceiling {ceiling:.2%}", "resize"))
    if drawdown > limits.drawdown_risk_reduction_start:
        span = limits.max_drawdown_halt - limits.drawdown_risk_reduction_start
        scale = max(Decimal("0.25"), ONE - (drawdown - limits.drawdown_risk_reduction_start) / span * Decimal("0.75"))
        fraction *= scale
        checks.append(Check("DRAWDOWN_REDUCTION", True, f"drawdown {drawdown:.2%}: risk scaled by {scale:.2f}", "resize"))
    budget = equity * fraction
    remaining_daily = daily_cap - daily_loss
    if budget > remaining_daily:
        budget = remaining_daily
        checks.append(Check("DAILY_LOSS_REMAINING", True, f"budget limited to remaining daily allowance {remaining_daily:.2f}", "resize"))
    group = CORRELATION_GROUPS.get(_base(p.symbol))
    if group:
        corr_used = sum((o.planned_risk for o in pf.open_positions
                         if CORRELATION_GROUPS.get(_base(o.symbol)) == group and o.side == p.side), ZERO)
        corr_room = limits.max_correlated_risk * equity - corr_used
        if corr_room <= 0:
            return reject("CORRELATED_RISK", f"{group} {p.side} risk already {corr_used:.2f} (cap {limits.max_correlated_risk:.2%})")
        if budget > corr_room:
            budget = corr_room
            checks.append(Check("CORRELATED_RISK", True, f"budget limited by correlated exposure to {corr_room:.2f}", "resize"))

    # ---- sizing -------------------------------------------------------------------
    funding = _dec(p.funding_rate_8h)
    if funding is None and spec.kind != "spot":
        funding = DEFAULT_FUNDING_ASSUMPTION_8H if p.side == "long" else -DEFAULT_FUNDING_ASSUMPTION_8H
        checks.append(Check("FUNDING_ASSUMED", True, f"funding unknown; assumed adverse {abs(funding)} per 8h", "info"))
    unit = per_unit_loss(spec, p.side, entry, stop, limits.slippage_rate, funding or ZERO, p.expected_holding_hours)
    if unit["total"] <= 0:
        return reject("SIZING_FAILED", "per-unit loss could not be computed")
    qty = _floor_step(budget / unit["total"], spec.qty_step)

    exposure_used = sum((o.notional for o in pf.open_positions), ZERO)
    exposure_room = limits.max_portfolio_exposure * equity - exposure_used
    if exposure_room <= 0:
        return reject("PORTFOLIO_EXPOSURE", f"exposure {exposure_used:.2f} at cap {limits.max_portfolio_exposure}x equity")
    max_qty_exposure = _floor_step(exposure_room / unit["entry_notional"], spec.qty_step)
    if qty > max_qty_exposure:
        qty = max_qty_exposure
        checks.append(Check("PORTFOLIO_EXPOSURE", True, "size reduced to fit portfolio exposure cap", "resize"))
    margin_per_unit = unit["entry_notional"] / lev
    max_qty_margin = _floor_step((_dec(pf.available_margin) or ZERO) / margin_per_unit, spec.qty_step)
    if qty > max_qty_margin:
        qty = max_qty_margin
        checks.append(Check("MARGIN", True, "size reduced to available margin", "resize"))
    if qty < spec.min_qty:
        return reject("SIZE_BELOW_MINIMUM", f"computed size {qty} is below the minimum {spec.min_qty}")

    liq = _liquidation_price(spec, p.side, entry, lev)
    if liq is not None:
        # Require the stop to trigger with a buffer before estimated liquidation.
        buffer = abs(entry - liq) * Decimal("0.2")
        unsafe = stop <= liq + buffer if p.side == "long" else stop >= liq - buffer
        if unsafe:
            return reject("LIQUIDATION_BEFORE_STOP", f"estimated liquidation {liq:.2f} is at or too close to stop {stop}")
        checks.append(Check("LIQUIDATION_DISTANCE", True, f"est. liquidation {liq:.2f}", "info"))

    est_loss = qty * unit["total"]
    hard_cap = equity * ceiling
    if est_loss > hard_cap:  # defensive: must be unreachable given the sizing above
        return reject("RISK_EXCEEDS_CEILING", f"estimated loss {est_loss:.2f} > ceiling {hard_cap:.2f}")

    res.qty = qty
    res.notional = qty * unit["entry_notional"]
    res.margin_required = qty * margin_per_unit
    res.estimated_loss = est_loss
    res.loss_breakdown = {k: qty * v for k, v in unit.items() if k not in ("total", "entry_notional")}
    res.risk_fraction = est_loss / equity
    res.risk_budget = budget
    resized = any(c.severity == "resize" for c in checks)
    res.verdict = "RESIZED" if resized else "APPROVED"
    res.approved = True
    checks.append(Check("RISK_CEILING", True, f"estimated loss {est_loss:.2f} ({res.risk_fraction:.2%}) <= ceiling {ceiling:.2%}", "info"))
    return res


def _base(symbol: str) -> str:
    for q in ("USDT", "USDC", "USD"):
        if symbol.endswith(q):
            return symbol[: -len(q)]
    return symbol
