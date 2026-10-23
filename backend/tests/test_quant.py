from __future__ import annotations

import numpy as np
import pytest

from app.data.simulated import synthetic_rows
from app.quant import indicators as ind
from app.quant.backtest import Bars, CostModel, run_backtest
from app.quant.metrics import Trade, compute_metrics, max_drawdown, research_goal_check, wilson_interval
from app.quant.validation import full_evaluation, monte_carlo


def _trade(net, risk=100.0):
    return Trade("long", 0, 1, "t0", "t1", 100, 101, 1, net, 0, 0, 0, net, risk, "x")


def test_known_metrics():
    trades = [_trade(x) for x in (200, -100, 300, -100, 100)]
    eq = np.array([1000, 1200, 1100, 1400, 1300, 1400], dtype=float)
    m = compute_metrics(trades, eq, 365, 5, 6)
    assert m["trades"] == 5
    assert m["win_rate"] == pytest.approx(0.6)
    assert m["profit_factor"] == pytest.approx(600 / 200)
    assert m["expectancy_per_trade"] == pytest.approx(80)
    assert m["expectancy_r"] == pytest.approx(0.8)
    assert m["avg_win"] == pytest.approx(200) and m["avg_loss"] == pytest.approx(-100)
    assert m["max_drawdown"] == pytest.approx(100 / 1200)  # 1200 -> 1100 is deeper than 1400 -> 1300
    assert m["sharpe"] is None  # too few bars for a meaningful ratio
    assert any("not statistically reliable" in w for w in m["warnings"])


def test_profit_factor_undefined_without_losses():
    m = compute_metrics([_trade(10), _trade(5)], np.array([100, 110, 115.0]), 365, 2, 3)
    assert m["profit_factor"] is None


def test_drawdown_duration():
    dd, dur = max_drawdown(np.array([100, 120, 90, 100, 110, 130, 125.0]))
    assert dd == pytest.approx(0.25) and dur == 3


def test_wilson():
    lo, hi = wilson_interval(7, 10)
    assert lo < 0.7 < hi and lo > 0.35


def test_research_goals_reported_honestly():
    g = research_goal_check({"trades": 5, "win_rate": 0.8, "profit_factor": 4, "max_drawdown": 0.05})
    assert g["win_rate_gt_70pct"] is True and g["sample_sufficient"] is False


def test_indicators_are_causal():
    rng = np.random.default_rng(1)
    x = 100 + np.cumsum(rng.normal(size=300))
    full = ind.rsi(x, 14)
    for t in (50, 150, 299):
        assert full[t] == pytest.approx(ind.rsi(x[: t + 1], 14)[t])
        assert ind.ema(x, 20)[t] == pytest.approx(ind.ema(x[: t + 1], 20)[t])
        assert ind.atr(x + 1, x - 1, x, 14)[t] == pytest.approx(ind.atr(x[: t + 1] + 1, x[: t + 1] - 1, x[: t + 1], 14)[t])


def test_rsi_reference_values():
    # Monotonic rise -> RSI 100; monotonic fall -> RSI 0
    assert ind.rsi(np.arange(1, 40, dtype=float))[-1] == pytest.approx(100)
    assert ind.rsi(np.arange(40, 1, -1, dtype=float))[-1] == pytest.approx(0)


def test_no_lookahead_future_bars_do_not_change_past_trades():
    bars = Bars.from_rows(synthetic_rows("BTCUSDT", "4h", 800, seed=3))
    a = run_backtest(bars.slice(0, 600), "ema_trend", interval="4h")
    b = run_backtest(bars, "ema_trend", interval="4h")
    closed_a = [t for t in a.trades if t.exit_reason != "end_of_data"]
    assert closed_a and [(t.entry_index, t.exit_index, round(t.net_pnl, 6)) for t in closed_a] == \
        [(t.entry_index, t.exit_index, round(t.net_pnl, 6)) for t in b.trades[: len(closed_a)]]


def test_entry_is_next_bar_open_with_costs():
    bars = Bars.from_rows(synthetic_rows("BTCUSDT", "4h", 600, seed=5))
    costs = CostModel(taker_fee_bps=5, slippage_bps=3)
    res = run_backtest(bars, "donchian_breakout", interval="4h", costs=costs)
    assert res.trades
    for t in res.trades:
        raw_open = bars.open[t.entry_index]
        expected = raw_open * (1 + 3e-4) if t.side == "long" else raw_open * (1 - 3e-4)
        assert t.entry_price == pytest.approx(expected)
        assert t.fees > 0 and t.slippage > 0
        assert t.gross_pnl - t.net_pnl == pytest.approx(t.fees + t.slippage + t.funding, rel=1e-6, abs=1e-6)


def test_costs_reduce_pnl():
    bars = Bars.from_rows(synthetic_rows("BTCUSDT", "4h", 800, seed=9))
    free = run_backtest(bars, "ema_trend", interval="4h", costs=CostModel(0, 0, 0)).metrics["net_pnl"]
    costly = run_backtest(bars, "ema_trend", interval="4h", costs=CostModel(10, 10, 0.0003)).metrics["net_pnl"]
    assert costly < free


def test_backtest_reproducible():
    bars = Bars.from_rows(synthetic_rows("ETHUSDT", "1h", 700, seed=11))
    a = run_backtest(bars, "rsi_mean_reversion", interval="1h").metrics
    b = run_backtest(bars, "rsi_mean_reversion", interval="1h").metrics
    assert a == b


def test_monte_carlo_seeded_and_bounded():
    r = [1.5, -1, -1, 2, -1, 0.5, -1, 3, -1, 1, -1, 2]
    a, b = monte_carlo(r, 0.01, runs=500, seed=1), monte_carlo(r, 0.01, runs=500, seed=1)
    assert a["final_return"] == b["final_return"]
    assert 0 <= a["max_drawdown"]["p50"] <= a["max_drawdown"]["p95"] <= 1
    assert "error" in monte_carlo([1, -1], 0.01)


def test_full_evaluation_structure():
    bars = Bars.from_rows(synthetic_rows("BTCUSDT", "4h", 1200, seed=2))
    out = full_evaluation(bars, "ema_trend", "4h", mc_runs=200)
    assert out["split"]["configs_tried"] == 18
    assert len(out["walk_forward"]["folds"]) == 4
    assert isinstance(out["overfitting_warnings"], list)
    # OOS segment must be strictly after in-sample segment
    seg = out["split"]["segments"]
    assert seg["in_sample"][1] < seg["out_of_sample"][0]
