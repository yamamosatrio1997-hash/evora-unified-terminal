"""Backtest orchestration with point-in-time data loading and result caching."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.events import emit
from app.core.util import canonical_json, jsonable, sha256_hex, utcnow
from app.data.snapshot import preferred_candle_source
from app.db.models import BacktestRun, Candle
from app.quant.backtest import STRATEGIES, Bars, CostModel, SizingModel
from app.quant.metrics import research_goal_check
from app.quant.validation import full_evaluation

MIN_BARS_FOR_EVALUATION = 500


def load_bars(db: Session, symbol: str, interval: str, until: datetime | None = None, limit: int = 3000) -> tuple[Bars, dict[str, Any]]:
    """Only candles that had CLOSED by `until` are loaded, so a backtest run for a
    debate cannot see data from after the debate's snapshot."""
    source = preferred_candle_source(db, symbol, interval)
    q = select(Candle).where(Candle.symbol == symbol, Candle.interval == interval, Candle.source == source)
    if until is not None:
        q = q.where(Candle.close_time <= until)
    rows = list(reversed(db.scalars(q.order_by(Candle.open_time.desc()).limit(limit)).all()))
    bars = Bars.from_rows([[r.open_time.isoformat(), r.open, r.high, r.low, r.close, r.volume] for r in rows])
    meta = {
        "count": len(rows),
        "sources": sorted({r.source for r in rows}),
        "simulated": any(r.quality == "simulated" for r in rows),
        "start": rows[0].open_time if rows else None,
        "end": rows[-1].close_time if rows else None,
    }
    return bars, meta


def run_backtest_job(db: Session, strategy: str, symbol: str, interval: str, until: datetime | None = None,
                     costs: CostModel | None = None, sizing: SizingModel | None = None, mc_runs: int = 2000,
                     use_cache: bool = True) -> BacktestRun:
    if strategy not in STRATEGIES:
        raise ValueError(f"unknown strategy {strategy}")
    costs = costs or CostModel()
    sizing = sizing or SizingModel()
    bars, meta = load_bars(db, symbol, interval, until)
    cache_key = sha256_hex(canonical_json({
        "strategy": strategy, "symbol": symbol, "interval": interval, "n": meta["count"],
        "start": meta["start"], "end": meta["end"], "costs": costs.describe(), "sizing": sizing.__dict__,
        "mc": mc_runs, "defaults": STRATEGIES[strategy].defaults, "grid": STRATEGIES[strategy].grid,
    }))
    if use_cache:
        cached = db.scalar(select(BacktestRun).where(BacktestRun.cache_key == cache_key, BacktestRun.status == "completed")
                           .order_by(BacktestRun.created_at.desc()).limit(1))
        if cached:
            return cached
    run = BacktestRun(
        strategy=strategy, symbol=symbol, interval=interval,
        dataset_kind="simulated" if meta["simulated"] else "historical",
        data_source=",".join(meta["sources"]) or "none", data_start=meta["start"], data_end=meta["end"],
        params=STRATEGIES[strategy].defaults, cache_key=cache_key, status="running",
        assumptions=jsonable({"costs": costs.describe(), "sizing": sizing.__dict__,
                              "fill_model": "signal at bar close, fill at next bar open; stop assumed before target within a bar",
                              "result_type": "backtest (not paper or live)"}),
    )
    db.add(run)
    db.flush()
    emit(db, "quant.backtest_started", agent="quant", backtest_id=str(run.id), strategy=strategy, symbol=symbol)
    if meta["count"] < MIN_BARS_FOR_EVALUATION:
        run.status, run.error = "insufficient_data", f"{meta['count']} bars available; need >= {MIN_BARS_FOR_EVALUATION}"
    else:
        try:
            res = full_evaluation(bars, strategy, interval, costs, sizing, mc_runs=mc_runs)
            res["research_goals_oos"] = research_goal_check(res["split"]["out_of_sample"])
            res["dataset"] = jsonable(meta)
            run.results = jsonable(res)
            run.status = "completed"
        except Exception as e:  # noqa: BLE001 - persisted and surfaced, never swallowed silently
            run.status, run.error = "failed", f"{type(e).__name__}: {e}"
    db.flush()
    emit(db, "quant.backtest_finished", agent="quant", backtest_id=str(run.id), status=run.status)
    return run


def summarize_run(run: BacktestRun, full: bool = False) -> dict[str, Any]:
    r = run.results or {}
    oos = (r.get("split") or {}).get("out_of_sample") or {}
    out = {
        "id": str(run.id), "created_at": run.created_at.isoformat() if run.created_at else utcnow().isoformat(),
        "strategy": run.strategy, "symbol": run.symbol, "interval": run.interval, "status": run.status,
        "dataset_kind": run.dataset_kind, "data_source": run.data_source,
        "data_start": run.data_start.isoformat() if run.data_start else None,
        "data_end": run.data_end.isoformat() if run.data_end else None,
        "error": run.error,
        "oos": {k: oos.get(k) for k in ("trades", "win_rate", "win_rate_ci95", "profit_factor", "expectancy_r", "max_drawdown", "return_pct", "sharpe")},
        "warnings": r.get("overfitting_warnings", []),
    }
    if full:
        out["results"] = r
        out["assumptions"] = run.assumptions
    return out
