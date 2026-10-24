"""Freshness rules and immutable data snapshots shared by all agents in a debate."""
from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.util import canonical_json, sha256_hex, utcnow
from app.db.models import Candle, DataSnapshot, MarketObservation

INTERVAL_SECONDS = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}

# Expected maximum age of the newest observation, by timeframe. Monthly macro
# series are published weeks after the period they describe, hence 75 days.
OBS_MAX_AGE = {
    "daily": timedelta(days=4),
    "weekly": timedelta(days=10),
    "monthly": timedelta(days=75),
}


def obs_max_age(timeframe: str) -> timedelta:
    if timeframe == "point":
        return timedelta(seconds=get_settings().data_stale_after_seconds)
    return OBS_MAX_AGE.get(timeframe, timedelta(days=1))


def candle_is_stale(last_close: datetime, interval: str, now: datetime) -> bool:
    # A bar is expected every interval; allow one missed bar plus a grace period.
    return now - last_close > timedelta(seconds=2 * INTERVAL_SECONDS[interval] + 120)


# Metrics pulled into every snapshot: (asset or "{base}", metric)
SNAPSHOT_METRICS = [
    ("{symbol}", "funding_rate"),
    ("{symbol}", "open_interest"),
    ("{symbol}", "mark_price"),
    ("{base}", "price"),
    ("{base}", "market_cap"),
    ("{base}", "volume_24h"),
    ("{base}", "change_24h_pct"),
    ("CRYPTO", "btc_dominance_pct"),
    ("CRYPTO", "total_market_cap"),
    ("CRYPTO", "fear_greed_index"),
    ("DEFI", "total_tvl"),
    ("STABLECOINS", "total_supply_usd_pegged"),
    ("MACRO", "fed_funds_effective"),
    ("MACRO", "ust_10y_yield"),
    ("MACRO", "ust_2y_yield"),
    ("MACRO", "usd_broad_index"),
    ("MACRO", "cpi_all_items"),
    ("MACRO", "unemployment_rate"),
    ("MACRO", "fed_total_assets"),
    ("MACRO", "reverse_repo"),
]


def base_asset(symbol: str) -> str:
    for quote in ("USDT", "USDC", "USD"):
        if symbol.endswith(quote):
            return symbol[: -len(quote)]
    return symbol


def _series(db: Session, asset: str, metric: str, n: int) -> list[MarketObservation]:
    """Newest-first window of one metric from ONE source (the source of the newest point)."""
    newest = db.scalars(
        select(MarketObservation.source)
        .where(MarketObservation.asset == asset, MarketObservation.metric == metric)
        .order_by(MarketObservation.observed_at.desc()).limit(1)
    ).first()
    if newest is None:
        return []
    rows = db.scalars(
        select(MarketObservation)
        .where(MarketObservation.asset == asset, MarketObservation.metric == metric, MarketObservation.source == newest)
        .order_by(MarketObservation.observed_at.desc())
        .limit(n)
    ).all()
    return list(reversed(rows))


# Primary market-data source first. A source is used only while it is fresh; otherwise the
# freshest real source is used and named in the snapshot. Sources are never interleaved.
CANDLE_SOURCE_PRIORITY = ("tradingview", "binance")


def preferred_candle_source(db: Session, symbol: str, interval: str) -> str | None:
    """Real exchange data wins over synthetic; sources are never interleaved."""
    latest = dict(db.execute(
        select(Candle.source, func.max(Candle.close_time))
        .where(Candle.symbol == symbol, Candle.interval == interval).group_by(Candle.source)
    ).all())
    real = {k: v for k, v in latest.items() if k != "synthetic"}
    if real:
        now = utcnow()
        for src in CANDLE_SOURCE_PRIORITY:
            if src in real and not candle_is_stale(real[src], interval, now):
                return src
        return max(real, key=lambda k: (real[k], k))
    return "synthetic" if "synthetic" in latest else None


def latest_candles(db: Session, symbol: str, interval: str, n: int = 300, source: str | None = None) -> list[Candle]:
    source = source or preferred_candle_source(db, symbol, interval)
    if source is None:
        return []
    rows = db.scalars(
        select(Candle).where(Candle.symbol == symbol, Candle.interval == interval, Candle.source == source)
        .order_by(Candle.open_time.desc()).limit(n)
    ).all()
    return list(reversed(rows))


def build_snapshot(db: Session, symbol: str, intervals: tuple[str, ...] = ("1h", "4h", "1d"), candle_count: int = 300) -> DataSnapshot:
    now = utcnow()
    base = base_asset(symbol)
    content: dict[str, Any] = {"symbol": symbol, "base_asset": base, "built_at": now.isoformat(), "candles": {}, "metrics": {}}
    quality: dict[str, Any] = {"stale": [], "missing": [], "simulated": [], "sources": {}}
    simulated = False

    for iv in intervals:
        rows = latest_candles(db, symbol, iv, candle_count)
        if not rows:
            quality["missing"].append(f"candles:{iv}")
            content["candles"][iv] = {"rows": [], "source": None}
            continue
        sources = {r.source for r in rows}
        if any(r.quality == "simulated" for r in rows):
            simulated = True
            quality["simulated"].append(f"candles:{iv}")
        stale = candle_is_stale(rows[-1].close_time, iv, now)
        if stale:
            quality["stale"].append(f"candles:{iv}")
        content["candles"][iv] = {
            "source": ",".join(sorted(sources)),
            "stale": stale,
            "last_close_time": rows[-1].close_time.isoformat(),
            "rows": [[r.open_time.isoformat(), str(r.open), str(r.high), str(r.low), str(r.close), str(r.volume)] for r in rows],
        }

    for asset_t, metric in SNAPSHOT_METRICS:
        asset = asset_t.format(symbol=symbol, base=base)
        series = _series(db, asset, metric, 30)
        key = f"{asset}:{metric}"
        if not series:
            quality["missing"].append(key)
            continue
        last = series[-1]
        stale = now - last.observed_at > obs_max_age(last.timeframe)
        if stale:
            quality["stale"].append(key)
        if last.quality == "simulated":
            simulated = True
            quality["simulated"].append(key)
        content["metrics"][key] = {
            "source": last.source,
            "unit": last.unit,
            "timeframe": last.timeframe,
            "latest": {"value": str(last.value), "observed_at": last.observed_at.isoformat(),
                       "retrieved_at": last.retrieved_at.isoformat(), "observation_id": last.id, "meta": last.meta},
            "history": [[o.observed_at.isoformat(), str(o.value)] for o in series],
            "stale": stale,
        }
        quality["sources"][last.source] = quality["sources"].get(last.source, 0) + 1

    content_hash = sha256_hex(canonical_json(content))
    snap = DataSnapshot(symbol=symbol, content=content, content_hash=content_hash, quality_summary=quality, is_simulated=simulated)
    db.add(snap)
    db.flush()
    return snap


def latest_price(db: Session, symbol: str) -> tuple[Decimal | None, datetime | None, str | None]:
    """Most recent close across intervals, with its timestamp and source."""
    source = preferred_candle_source(db, symbol, "1h") or preferred_candle_source(db, symbol, "4h")
    row = db.execute(
        select(Candle.close, Candle.close_time, Candle.source)
        .where(Candle.symbol == symbol, Candle.source == source).order_by(Candle.close_time.desc()).limit(1)
    ).first()
    if not row:
        return None, None, None
    return row[0], row[1], row[2]


def freshness_report(db: Session) -> list[dict[str, Any]]:
    now = utcnow()
    out: list[dict[str, Any]] = []
    for sym, iv, last, src, q in db.execute(
        select(Candle.symbol, Candle.interval, func.max(Candle.close_time), func.min(Candle.source), func.min(Candle.quality))
        .group_by(Candle.symbol, Candle.interval)
    ):
        out.append({"kind": "candles", "key": f"{sym}:{iv}", "source": src, "last": last.isoformat(),
                    "age_seconds": int((now - last).total_seconds()), "stale": candle_is_stale(last, iv, now), "quality": q})
    for asset, metric, src, tf, last, q in db.execute(
        select(MarketObservation.asset, MarketObservation.metric, MarketObservation.source, MarketObservation.timeframe,
               func.max(MarketObservation.observed_at), func.min(MarketObservation.quality))
        .group_by(MarketObservation.asset, MarketObservation.metric, MarketObservation.source, MarketObservation.timeframe)
    ):
        out.append({"kind": "metric", "key": f"{asset}:{metric}", "source": src, "last": last.isoformat(),
                    "age_seconds": int((now - last).total_seconds()), "stale": now - last > obs_max_age(tf), "quality": q})
    return sorted(out, key=lambda r: r["key"])
