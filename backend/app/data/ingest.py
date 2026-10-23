"""Scheduled ingestion: fetch -> validate -> deduplicate -> persist -> health."""
from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.events import emit
from app.core.util import utcnow
from app.data.http import FetchError, HttpFetcher
from app.data.sources import public
from app.data.types import SourceBatch, SourceUnconfigured
from app.db.models import Candle, MarketObservation, SourceHealth

log = logging.getLogger(__name__)

KLINE_INTERVALS = ("1h", "4h", "1d")


def _jobs(fetcher: HttpFetcher) -> dict[str, Callable[[], list[SourceBatch]]]:
    symbols = get_settings().symbols
    return {
        "binance": lambda: [public.binance_klines(fetcher, sym, iv) for sym in symbols for iv in KLINE_INTERVALS],
        "binance_futures": lambda: [public.binance_futures_context(fetcher, sym) for sym in symbols],
        "coingecko": lambda: [public.coingecko_markets(fetcher)],
        "fred": lambda: [public.fred_series(fetcher)],
        "defillama": lambda: [public.defillama_overview(fetcher)],
        "alternative_me": lambda: [public.fear_greed(fetcher)],
    }


SOURCES = ("binance", "binance_futures", "coingecko", "fred", "defillama", "alternative_me")


def persist_batch(db: Session, batch: SourceBatch) -> tuple[int, int]:
    """Insert rows, ignoring duplicates. Returns (new_candles, new_observations)."""
    now = utcnow()
    nc = no = 0
    if batch.candles:
        rows = [
            dict(source=c.source, symbol=c.symbol, interval=c.interval, open_time=c.open_time, close_time=c.close_time,
                 open=c.open, high=c.high, low=c.low, close=c.close, volume=c.volume, retrieved_at=now, quality=c.quality)
            for c in batch.candles
        ]
        for i in range(0, len(rows), 500):
            res = db.execute(insert(Candle).values(rows[i:i + 500]).on_conflict_do_nothing(constraint="uq_candle").returning(Candle.id))
            nc += len(res.all())
    if batch.observations:
        rows = [
            dict(source=o.source, asset=o.asset, metric=o.metric, value=o.value, unit=o.unit, observed_at=o.observed_at,
                 retrieved_at=now, timeframe=o.timeframe, quality=o.quality, meta=o.meta)
            for o in batch.observations
        ]
        res = db.execute(insert(MarketObservation).values(rows).on_conflict_do_nothing(constraint="uq_observation").returning(MarketObservation.id))
        no += len(res.all())
    return nc, no


def _health(db: Session, source: str) -> SourceHealth:
    h = db.get(SourceHealth, source)
    if h is None:
        h = SourceHealth(source=source, status="unknown", consecutive_failures=0, rate_limit_info={})
        db.add(h)
    return h


def run_ingestion(db: Session, sources: list[str] | None = None, fetcher: HttpFetcher | None = None) -> dict[str, Any]:
    own = fetcher is None
    fetcher = fetcher or HttpFetcher()
    jobs = _jobs(fetcher)
    summary: dict[str, Any] = {}
    try:
        for name in sources or list(SOURCES):
            if name not in jobs:
                summary[name] = {"status": "unknown_source"}
                continue
            h = _health(db, name)
            now = utcnow()
            try:
                batches = jobs[name]()
            except SourceUnconfigured as e:
                h.status, h.last_error, h.updated_at = "unconfigured", str(e), now
                summary[name] = {"status": "unconfigured", "detail": str(e)}
                continue
            except FetchError as e:
                h.consecutive_failures = (h.consecutive_failures or 0) + 1
                h.status = "down" if h.consecutive_failures >= 3 else "degraded"
                h.last_error, h.last_error_at, h.updated_at = str(e), now, now
                emit(db, "data.source_error", source=name, error=str(e), consecutive_failures=h.consecutive_failures)
                summary[name] = {"status": h.status, "error": str(e)}
                continue
            new_c = new_o = 0
            rejected: list[str] = []
            latency = 0
            rl: dict[str, Any] = {}
            for b in batches:
                c, o = persist_batch(db, b)
                new_c += c
                new_o += o
                rejected.extend(b.rejected)
                latency = max(latency, b.latency_ms)
                rl.update(b.rate_limit_info)
            h.status = "degraded" if rejected else "ok"
            h.consecutive_failures = 0
            h.last_success_at, h.updated_at, h.last_latency_ms = now, now, latency
            h.rate_limit_info = rl
            if rejected:
                h.last_error, h.last_error_at = f"{len(rejected)} rows rejected; first: {rejected[0]}", now
            emit(db, "data.ingested", source=name, new_candles=new_c, new_observations=new_o, rejected=len(rejected))
            summary[name] = {"status": h.status, "new_candles": new_c, "new_observations": new_o,
                             "rejected": len(rejected), "rejected_samples": rejected[:5]}
            db.flush()
    finally:
        if own:
            fetcher.close()
    return summary
