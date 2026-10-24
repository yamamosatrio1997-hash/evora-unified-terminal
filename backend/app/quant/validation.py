"""Out-of-sample, walk-forward, Monte Carlo, parameter sensitivity and overfitting checks."""
from __future__ import annotations

import itertools
from typing import Any

import numpy as np

from app.quant.backtest import STRATEGIES, Bars, CostModel, SizingModel, run_backtest
from app.quant.metrics import MIN_TRADES_FOR_INFERENCE, max_drawdown


def _score(m: dict[str, Any]) -> float:
    """Selection objective: net expectancy in R, penalized when the sample is tiny.
    Deliberately not win rate, which is trivially inflated by wide stops/tight targets."""
    if not m["trades"] or m["expectancy_r"] is None:
        return -1e9
    return m["expectancy_r"] * min(1.0, m["trades"] / MIN_TRADES_FOR_INFERENCE)


def param_grid(strategy: str) -> list[dict[str, Any]]:
    g = STRATEGIES[strategy].grid
    keys = list(g)
    return [dict(zip(keys, combo)) for combo in itertools.product(*(g[k] for k in keys))]


def split_evaluation(bars: Bars, strategy: str, interval: str, costs: CostModel, sizing: SizingModel) -> dict[str, Any]:
    """60/20/20 chronological split. Parameters are chosen on the in-sample segment
    only, confirmed on validation, then reported once on the untouched OOS segment."""
    n = len(bars)
    a, b = int(n * 0.6), int(n * 0.8)
    ins, val, oos = bars.slice(0, a), bars.slice(a, b), bars.slice(b, n)
    grid = param_grid(strategy)
    scored = []
    for p in grid:
        m = run_backtest(ins, strategy, p, interval, costs, sizing).metrics
        scored.append((_score(m), p, m))
    scored.sort(key=lambda x: x[0], reverse=True)
    best_p = scored[0][1]
    val_m = run_backtest(val, strategy, best_p, interval, costs, sizing).metrics
    oos_m = run_backtest(oos, strategy, best_p, interval, costs, sizing).metrics
    return {
        "selected_params": best_p,
        "configs_tried": len(grid),
        "in_sample": scored[0][2],
        "validation": val_m,
        "out_of_sample": oos_m,
        "segments": {"in_sample": [ins.time[0], ins.time[-1]] if len(ins) else None,
                     "validation": [val.time[0], val.time[-1]] if len(val) else None,
                     "out_of_sample": [oos.time[0], oos.time[-1]] if len(oos) else None},
        "_grid_scores": [(s, p) for s, p, _ in scored],
    }


def walk_forward(bars: Bars, strategy: str, interval: str, costs: CostModel, sizing: SizingModel,
                 folds: int = 4, train_frac: float = 0.6) -> dict[str, Any]:
    """Anchored-window walk-forward: for each fold, optimize on the train window and
    trade the next unseen test window. Only test-window trades are aggregated."""
    n = len(bars)
    test_len = int(n * (1 - train_frac) / folds)
    if test_len < 50:
        return {"error": "insufficient data for walk-forward", "folds": []}
    out_folds = []
    oos_r: list[float] = []
    for k in range(folds):
        train_end = int(n * train_frac) + k * test_len
        test_end = min(n, train_end + test_len)
        train, test = bars.slice(0, train_end), bars.slice(train_end, test_end)
        best = max(param_grid(strategy), key=lambda p: _score(run_backtest(train, strategy, p, interval, costs, sizing).metrics))
        res = run_backtest(test, strategy, best, interval, costs, sizing)
        oos_r.extend(t.r_multiple for t in res.trades)
        out_folds.append({"fold": k + 1, "train": [train.time[0], train.time[-1]], "test": [test.time[0], test.time[-1]],
                          "params": best, "metrics": {k2: res.metrics[k2] for k2 in
                                                      ("trades", "win_rate", "profit_factor", "expectancy_r", "max_drawdown", "return_pct")}})
    arr = np.array(oos_r)
    return {
        "folds": out_folds,
        "aggregate_oos": {
            "trades": len(arr),
            "expectancy_r": float(arr.mean()) if len(arr) else None,
            "win_rate": float((arr > 0).mean()) if len(arr) else None,
            "profitable_folds": sum(1 for f in out_folds if (f["metrics"]["return_pct"] or 0) > 0),
        },
    }


def monte_carlo(r_multiples: list[float], risk_per_trade: float, runs: int = 2000, seed: int = 7,
                dd_threshold: float = 0.10) -> dict[str, Any]:
    """Bootstrap trade outcomes (with replacement) to estimate the distribution of
    final return and max drawdown under fixed-fractional sizing. Assumes trades are
    independent, which understates risk when losses cluster."""
    if len(r_multiples) < 10:
        return {"error": f"need >= 10 trades for Monte Carlo, have {len(r_multiples)}"}
    rng = np.random.default_rng(seed)
    r = np.array(r_multiples)
    n = len(r)
    finals = np.empty(runs)
    dds = np.empty(runs)
    for i in range(runs):
        sample = rng.choice(r, size=n, replace=True)
        eq = np.cumprod(1 + sample * risk_per_trade)
        eq = np.insert(eq, 0, 1.0)
        finals[i] = eq[-1] - 1
        dds[i] = max_drawdown(eq)[0]
    pct = lambda a, q: float(np.percentile(a, q))  # noqa: E731
    return {
        "runs": runs, "trades_per_run": n, "seed": seed, "risk_per_trade": risk_per_trade,
        "final_return": {"p5": pct(finals, 5), "p50": pct(finals, 50), "p95": pct(finals, 95)},
        "max_drawdown": {"p50": pct(dds, 50), "p95": pct(dds, 95), "p99": pct(dds, 99)},
        "prob_loss": float((finals < 0).mean()),
        f"prob_drawdown_gt_{int(dd_threshold * 100)}pct": float((dds > dd_threshold).mean()),
        "histogram_final_return": np.histogram(finals, bins=30)[0].tolist(),
        "histogram_edges": [float(x) for x in np.histogram(finals, bins=30)[1]],
        "assumptions": "IID bootstrap of realized R-multiples; does not model regime change or serial correlation.",
    }


def sensitivity(grid_scores: list[tuple[float, dict[str, Any]]]) -> dict[str, Any]:
    """How much does performance depend on the exact parameter choice?"""
    scores = np.array([s for s, _ in grid_scores if s > -1e8])
    if len(scores) < 3:
        return {"error": "too few valid configurations"}
    best = scores.max()
    return {
        "configs": len(scores),
        "best": float(best),
        "median": float(np.median(scores)),
        "share_positive": float((scores > 0).mean()),
        "fragile": bool(best > 0 and np.median(scores) <= 0),
    }


def overfitting_warnings(split: dict[str, Any], wf: dict[str, Any], sens: dict[str, Any]) -> list[str]:
    w: list[str] = []
    ins, oos = split["in_sample"], split["out_of_sample"]
    if split["configs_tried"] > 10:
        w.append(f"{split['configs_tried']} parameter sets were tried; the best in-sample result is biased upward (multiple testing).")
    if (ins.get("expectancy_r") or 0) > 0 and (oos.get("expectancy_r") or 0) <= 0:
        w.append("Positive in-sample expectancy did not survive out-of-sample.")
    ipf, opf = ins.get("profit_factor"), oos.get("profit_factor")
    if ipf and opf is not None and opf < 0.5 * ipf:
        w.append(f"Out-of-sample profit factor ({opf:.2f}) is less than half of in-sample ({ipf:.2f}).")
    if oos.get("trades", 0) < MIN_TRADES_FOR_INFERENCE:
        w.append(f"Out-of-sample segment has only {oos.get('trades', 0)} trades.")
    if sens.get("fragile"):
        w.append("Only a narrow set of parameters is profitable (median configuration is not).")
    agg = wf.get("aggregate_oos") or {}
    if agg.get("trades") and (agg.get("expectancy_r") or 0) <= 0:
        w.append("Walk-forward aggregate out-of-sample expectancy is not positive.")
    return w


def full_evaluation(bars: Bars, strategy: str, interval: str, costs: CostModel | None = None,
                    sizing: SizingModel | None = None, mc_runs: int = 2000) -> dict[str, Any]:
    costs = costs or CostModel()
    sizing = sizing or SizingModel()
    full = run_backtest(bars, strategy, None, interval, costs, sizing)
    split = split_evaluation(bars, strategy, interval, costs, sizing)
    wf = walk_forward(bars, strategy, interval, costs, sizing)
    sens = sensitivity(split.pop("_grid_scores"))
    oos_bt = run_backtest(bars.slice(int(len(bars) * 0.8), len(bars)), strategy, split["selected_params"], interval, costs, sizing)
    mc = monte_carlo([t.r_multiple for t in oos_bt.trades] or [t.r_multiple for t in full.trades], sizing.risk_per_trade, runs=mc_runs)
    mc["trade_source"] = "out_of_sample" if oos_bt.trades else "full_period_default_params"
    return {
        "default_params_full_period": full.summary(),
        "split": split,
        "walk_forward": wf,
        "sensitivity": sens,
        "monte_carlo": mc,
        "overfitting_warnings": overfitting_warnings(split, wf, sens),
    }
