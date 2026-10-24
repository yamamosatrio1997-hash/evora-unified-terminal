"""Bar-by-bar backtester.

Look-ahead protection:
  * signals are computed from indicators that are causal (value at t uses <= t);
  * a signal formed on bar t's close is filled at bar t+1's open (plus slippage);
  * stops/targets are evaluated from bar t+1 onward using that bar's high/low;
  * when stop and target are both inside one bar, the stop is assumed first
    (the conservative choice, since intrabar order is unknown).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np

from app.quant import indicators as ind
from app.quant.metrics import Trade, compute_metrics

BARS_PER_YEAR = {"15m": 35040, "1h": 8760, "4h": 2190, "1d": 365}


@dataclass
class Bars:
    time: list[str]
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray

    def __len__(self) -> int:
        return len(self.close)

    def slice(self, a: int, b: int) -> "Bars":
        return Bars(self.time[a:b], self.open[a:b], self.high[a:b], self.low[a:b], self.close[a:b], self.volume[a:b])

    @classmethod
    def from_rows(cls, rows: list[list[Any]]) -> "Bars":
        """rows: [time, open, high, low, close, volume] (strings or numbers)."""
        arr = np.array([[float(x) for x in r[1:6]] for r in rows], dtype=float) if rows else np.zeros((0, 5))
        return cls([str(r[0]) for r in rows], arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 3], arr[:, 4])


@dataclass
class CostModel:
    taker_fee_bps: float = 5.0  # per side
    slippage_bps: float = 3.0  # per side, adverse
    funding_rate_per_8h: float = 0.0001  # applied to perp notional; longs pay when positive
    apply_funding: bool = True

    def describe(self) -> dict[str, Any]:
        return asdict(self) | {
            "notes": "Fees and slippage charged on entry and exit notional. Funding is a constant "
                     "assumption unless historical funding is supplied; longs pay positive funding, shorts receive it."
        }


@dataclass
class SizingModel:
    risk_per_trade: float = 0.01
    max_leverage: float = 3.0


@dataclass
class Signal:
    direction: int  # +1 long, -1 short
    stop_distance: float
    take_profit_r: float | None


StrategyFn = Callable[[dict[str, np.ndarray], Bars, int, dict[str, Any]], Signal | None]


# ------------------------------------------------------------------ strategies

def _prep_ema_trend(b: Bars, p: dict[str, Any]) -> dict[str, np.ndarray]:
    return {"fast": ind.ema(b.close, p["fast"]), "slow": ind.ema(b.close, p["slow"]), "atr": ind.atr(b.high, b.low, b.close, 14)}


def _sig_ema_trend(f: dict[str, np.ndarray], b: Bars, t: int, p: dict[str, Any]) -> Signal | None:
    if t < 1 or np.isnan(f["slow"][t - 1]) or np.isnan(f["atr"][t]):
        return None
    up = f["fast"][t - 1] <= f["slow"][t - 1] and f["fast"][t] > f["slow"][t]
    dn = f["fast"][t - 1] >= f["slow"][t - 1] and f["fast"][t] < f["slow"][t]
    if not (up or dn) or (dn and not p.get("allow_short", True)):
        return None
    return Signal(1 if up else -1, p["atr_mult"] * f["atr"][t], p.get("take_profit_r"))


def _prep_rsi_mr(b: Bars, p: dict[str, Any]) -> dict[str, np.ndarray]:
    return {"rsi": ind.rsi(b.close, 14), "trend": ind.sma(b.close, p["trend_len"]), "atr": ind.atr(b.high, b.low, b.close, 14)}


def _sig_rsi_mr(f: dict[str, np.ndarray], b: Bars, t: int, p: dict[str, Any]) -> Signal | None:
    if np.isnan(f["trend"][t]) or np.isnan(f["rsi"][t]) or np.isnan(f["atr"][t]):
        return None
    if b.close[t] > f["trend"][t] and f["rsi"][t] < p["oversold"]:
        return Signal(1, p["atr_mult"] * f["atr"][t], p.get("take_profit_r"))
    if p.get("allow_short", True) and b.close[t] < f["trend"][t] and f["rsi"][t] > 100 - p["oversold"]:
        return Signal(-1, p["atr_mult"] * f["atr"][t], p.get("take_profit_r"))
    return None


def _prep_donchian(b: Bars, p: dict[str, Any]) -> dict[str, np.ndarray]:
    n = p["lookback"]
    # Channel through t-1 so the breakout bar is compared to prior extremes only.
    hi = np.roll(ind.rolling_max(b.high, n), 1)
    lo = np.roll(ind.rolling_min(b.low, n), 1)
    hi[0] = lo[0] = np.nan
    return {"hi": hi, "lo": lo, "atr": ind.atr(b.high, b.low, b.close, 14)}


def _sig_donchian(f: dict[str, np.ndarray], b: Bars, t: int, p: dict[str, Any]) -> Signal | None:
    if np.isnan(f["hi"][t]) or np.isnan(f["atr"][t]):
        return None
    if b.close[t] > f["hi"][t]:
        return Signal(1, p["atr_mult"] * f["atr"][t], p.get("take_profit_r"))
    if p.get("allow_short", True) and b.close[t] < f["lo"][t]:
        return Signal(-1, p["atr_mult"] * f["atr"][t], p.get("take_profit_r"))
    return None


@dataclass
class StrategySpec:
    name: str
    description: str
    prep: Callable[[Bars, dict[str, Any]], dict[str, np.ndarray]]
    signal: StrategyFn
    defaults: dict[str, Any]
    grid: dict[str, list[Any]] = field(default_factory=dict)


STRATEGIES: dict[str, StrategySpec] = {
    "ema_trend": StrategySpec(
        "ema_trend", "EMA fast/slow crossover, ATR stop, fixed-R target",
        _prep_ema_trend, _sig_ema_trend,
        {"fast": 20, "slow": 50, "atr_mult": 2.0, "take_profit_r": 2.0, "allow_short": True},
        {"fast": [10, 20, 30], "slow": [50, 100], "atr_mult": [1.5, 2.0, 3.0]},
    ),
    "rsi_mean_reversion": StrategySpec(
        "rsi_mean_reversion", "RSI(14) pullback in direction of SMA trend, ATR stop",
        _prep_rsi_mr, _sig_rsi_mr,
        {"trend_len": 200, "oversold": 30, "atr_mult": 1.5, "take_profit_r": 1.5, "allow_short": True},
        {"trend_len": [100, 200], "oversold": [25, 30, 35], "atr_mult": [1.0, 1.5, 2.0]},
    ),
    "donchian_breakout": StrategySpec(
        "donchian_breakout", "N-bar channel breakout, ATR stop",
        _prep_donchian, _sig_donchian,
        {"lookback": 20, "atr_mult": 2.0, "take_profit_r": 3.0, "allow_short": True},
        {"lookback": [20, 55], "atr_mult": [1.5, 2.0, 3.0], "take_profit_r": [2.0, 3.0]},
    ),
}


# ------------------------------------------------------------------ engine

@dataclass
class BacktestResult:
    trades: list[Trade]
    equity: np.ndarray
    metrics: dict[str, Any]

    def summary(self, max_curve_points: int = 400) -> dict[str, Any]:
        step = max(1, len(self.equity) // max_curve_points)
        return {
            "metrics": self.metrics,
            "equity_curve": [round(float(x), 2) for x in self.equity[::step]],
            "trades": [asdict(t) | {"r_multiple": t.r_multiple} for t in self.trades[-200:]],
        }


def run_backtest(bars: Bars, strategy: str, params: dict[str, Any] | None = None, interval: str = "4h",
                 costs: CostModel | None = None, sizing: SizingModel | None = None, starting_equity: float = 10000.0) -> BacktestResult:
    spec = STRATEGIES[strategy]
    p = spec.defaults | (params or {})
    costs = costs or CostModel()
    sizing = sizing or SizingModel()
    feats = spec.prep(bars, p)
    fee = costs.taker_fee_bps / 1e4
    slip = costs.slippage_bps / 1e4
    bars_per_8h = {"15m": 32, "1h": 8, "4h": 2, "1d": 1 / 3}.get(interval, 2)

    equity = starting_equity
    curve = np.empty(len(bars))
    trades: list[Trade] = []
    pos: dict[str, Any] | None = None
    pending: Signal | None = None
    in_pos_bars = 0

    for t in range(len(bars)):
        # 1) fill a pending entry at this bar's open
        if pending is not None and pos is None:
            d = pending.direction
            entry = bars.open[t] * (1 + slip * d)
            stop = entry - d * pending.stop_distance
            if pending.stop_distance > 0 and stop > 0:
                per_unit_loss = pending.stop_distance + entry * fee + abs(stop) * fee + abs(stop) * slip
                qty = (equity * sizing.risk_per_trade) / per_unit_loss
                qty = min(qty, equity * sizing.max_leverage / entry)
                if qty > 0:
                    tp = entry + d * pending.take_profit_r * pending.stop_distance if pending.take_profit_r else None
                    pos = {"d": d, "entry": entry, "raw_entry": bars.open[t], "stop": stop, "tp": tp, "qty": qty, "i": t,
                           "risk": qty * per_unit_loss, "entry_fee": qty * entry * fee,
                           "entry_slip": qty * bars.open[t] * slip}
            pending = None
        # 2) manage an open position on this bar
        if pos is not None:
            in_pos_bars += 1
            d = pos["d"]
            hit_stop = (bars.low[t] <= pos["stop"]) if d == 1 else (bars.high[t] >= pos["stop"])
            hit_tp = pos["tp"] is not None and ((bars.high[t] >= pos["tp"]) if d == 1 else (bars.low[t] <= pos["tp"]))
            exit_px = reason = None
            if hit_stop:
                # gap through the stop fills at the open, not at the stop
                raw = min(pos["stop"], bars.open[t]) if d == 1 else max(pos["stop"], bars.open[t])
                exit_px, reason = raw, "stop"
            elif hit_tp:
                exit_px, reason = pos["tp"], "take_profit"
            elif t == len(bars) - 1:
                exit_px, reason = bars.close[t], "end_of_data"
            if exit_px is not None:
                fill = exit_px * (1 - slip * d)
                qty = pos["qty"]
                gross = d * (exit_px - pos["raw_entry"]) * qty
                fees = pos["entry_fee"] + qty * fill * fee
                slippage = pos["entry_slip"] + qty * exit_px * slip
                held = t - pos["i"] + 1
                funding = (costs.funding_rate_per_8h * d * qty * pos["entry"] * held / bars_per_8h) if costs.apply_funding else 0.0
                net = d * (fill - pos["entry"]) * qty - fees - funding
                trades.append(Trade(
                    "long" if d == 1 else "short", pos["i"], t, bars.time[pos["i"]], bars.time[t],
                    pos["entry"], fill, qty, gross, fees, slippage, funding, net, pos["risk"], reason,
                ))
                equity += net
                pos = None
        # 3) mark-to-market
        mtm = equity
        if pos is not None:
            mtm += pos["d"] * (bars.close[t] - pos["entry"]) * pos["qty"] - pos["entry_fee"]
        curve[t] = mtm
        # 4) form a signal on this bar's close for next bar's open
        if pos is None and pending is None and t < len(bars) - 1 and equity > 0:
            pending = spec.signal(feats, bars, t, p)

    metrics = compute_metrics(trades, curve, BARS_PER_YEAR.get(interval, 2190), in_pos_bars, len(bars))
    return BacktestResult(trades, curve, metrics)
