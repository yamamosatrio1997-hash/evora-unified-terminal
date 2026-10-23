"""Deterministic performance metrics with explicit sample-size caveats."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

MIN_TRADES_FOR_INFERENCE = 30
MIN_BARS_FOR_RATIO = 60


@dataclass
class Trade:
    side: str  # long | short
    entry_index: int
    exit_index: int
    entry_time: str
    exit_time: str
    entry_price: float
    exit_price: float
    qty: float
    gross_pnl: float
    fees: float
    slippage: float
    funding: float
    net_pnl: float
    risk_amount: float  # planned loss at stop incl. estimated costs
    exit_reason: str

    @property
    def r_multiple(self) -> float:
        return self.net_pnl / self.risk_amount if self.risk_amount > 0 else 0.0


def wilson_interval(wins: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    if n == 0:
        return None
    p = wins / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def max_drawdown(equity: np.ndarray) -> tuple[float, int]:
    """Return (max drawdown as a positive fraction, longest drawdown duration in bars)."""
    if len(equity) == 0:
        return 0.0, 0
    peak = np.maximum.accumulate(equity)
    dd = (peak - equity) / peak
    longest = cur = 0
    for i in range(len(equity)):
        cur = cur + 1 if equity[i] < peak[i] else 0
        longest = max(longest, cur)
    return float(np.max(dd)), longest


def _annualized_ratio(returns: np.ndarray, periods_per_year: float, downside: bool) -> float | None:
    if len(returns) < MIN_BARS_FOR_RATIO:
        return None
    mean = float(np.mean(returns))
    if downside:
        neg = np.minimum(returns, 0.0)
        sd = float(np.sqrt(np.mean(neg ** 2)))
    else:
        sd = float(np.std(returns, ddof=1))
    if sd == 0:
        return None
    return mean / sd * math.sqrt(periods_per_year)


def compute_metrics(trades: list[Trade], equity: np.ndarray, periods_per_year: float, bars_in_position: int, total_bars: int) -> dict[str, Any]:
    n = len(trades)
    net = np.array([t.net_pnl for t in trades], dtype=float)
    wins = net[net > 0]
    losses = net[net <= 0]
    gross_win = float(wins.sum())
    gross_loss = float(-losses.sum())
    mdd, dd_dur = max_drawdown(equity)
    bar_returns = np.diff(equity) / equity[:-1] if len(equity) > 1 else np.array([])
    r = np.array([t.r_multiple for t in trades], dtype=float)
    holding = [t.exit_index - t.entry_index for t in trades]
    warnings: list[str] = []
    if n < MIN_TRADES_FOR_INFERENCE:
        warnings.append(f"Only {n} trades: win rate, profit factor and expectancy are not statistically reliable (need >= {MIN_TRADES_FOR_INFERENCE}).")
    if n and gross_loss == 0:
        warnings.append("No losing trades: profit factor is undefined; treat as insufficient evidence, not as infinite edge.")
    out = {
        "trades": n,
        "win_rate": (len(wins) / n) if n else None,
        "win_rate_ci95": wilson_interval(len(wins), n),
        "profit_factor": (gross_win / gross_loss) if gross_loss > 0 else None,
        "expectancy_per_trade": float(net.mean()) if n else None,
        "expectancy_r": float(r.mean()) if n else None,
        "avg_win": float(wins.mean()) if len(wins) else None,
        "avg_loss": float(losses.mean()) if len(losses) else None,
        "gross_pnl": float(sum(t.gross_pnl for t in trades)),
        "net_pnl": float(net.sum()) if n else 0.0,
        "total_fees": float(sum(t.fees for t in trades)),
        "total_slippage": float(sum(t.slippage for t in trades)),
        "total_funding": float(sum(t.funding for t in trades)),
        "return_pct": float(equity[-1] / equity[0] - 1) if len(equity) else 0.0,
        "max_drawdown": mdd,
        "max_drawdown_duration_bars": dd_dur,
        "sharpe": _annualized_ratio(bar_returns, periods_per_year, downside=False),
        "sortino": _annualized_ratio(bar_returns, periods_per_year, downside=True),
        "exposure": bars_in_position / total_bars if total_bars else 0.0,
        "avg_holding_bars": float(np.mean(holding)) if holding else None,
        "long_trades": sum(1 for t in trades if t.side == "long"),
        "short_trades": sum(1 for t in trades if t.side == "short"),
        "warnings": warnings,
    }
    if out["sharpe"] is not None and out["sharpe"] > 3:
        warnings.append("Sharpe > 3 in a backtest is a common symptom of overfitting or unrealistic costs.")
    return out


RESEARCH_GOALS = {"win_rate": 0.70, "profit_factor": 3.0, "max_drawdown": 0.10}


def research_goal_check(m: dict[str, Any]) -> dict[str, Any]:
    """Compare against the user's research goals. These are targets, not guarantees,
    and meeting them on a small sample is not evidence of an edge."""
    reliable = (m.get("trades") or 0) >= MIN_TRADES_FOR_INFERENCE
    wr, pf, dd = m.get("win_rate"), m.get("profit_factor"), m.get("max_drawdown")
    return {
        "win_rate_gt_70pct": None if wr is None else wr > RESEARCH_GOALS["win_rate"],
        "profit_factor_gt_3": None if pf is None else pf > RESEARCH_GOALS["profit_factor"],
        "max_drawdown_lt_10pct": None if dd is None else dd < RESEARCH_GOALS["max_drawdown"],
        "sample_sufficient": reliable,
        "note": "Research goals only. Results are reported as measured; nothing is tuned to hit them.",
    }
