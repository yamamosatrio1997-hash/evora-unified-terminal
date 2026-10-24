"""Synthetic OHLCV for tests and an explicitly labeled demo mode.

Every row produced here is persisted with source="synthetic" and
quality="simulated". Snapshots containing such rows are flagged
`is_simulated`, which forces the Fund Manager to NO TRADE, and the UI shows a
SIMULATED badge. This is never a substitute for missing real data.

Higher timeframes are aggregated from one base 1h series so that 1h/4h/1d
prices are mutually consistent.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import numpy as np

from app.data.snapshot import INTERVAL_SECONDS
from app.data.types import CandleRow

START_PRICE = {"BTCUSDT": 60000.0, "ETHUSDT": 3000.0}


def _base_1h(symbol: str, n: int, seed: int, end: datetime) -> list[list]:
    """Regime-switching GBM on 1h bars ending at `end` (exclusive)."""
    rng = np.random.default_rng(seed)
    start = end - timedelta(hours=n)
    price = START_PRICE.get(symbol, 100.0)
    rows = []
    drift = 0.0
    for i in range(n):
        if i % 480 == 0:  # regime change roughly every 20 days
            drift = float(rng.choice([-0.0001, 0.0, 0.00015]))
        vol = 0.006 * (1.6 if rng.random() < 0.08 else 1.0)
        o = price
        c = o * float(np.exp(drift + vol * rng.standard_normal()))
        hi = max(o, c) * float(1 + abs(rng.normal(0, vol / 2)))
        lo = min(o, c) * float(1 - abs(rng.normal(0, vol / 2)))
        v = float(abs(rng.normal(1000, 300)))
        rows.append([start + timedelta(hours=i), o, hi, lo, c, v])
        price = c
    return rows


def _aggregate(base: list[list], hours: int) -> list[list]:
    out = []
    # align buckets to multiples of the interval since epoch
    i = 0
    while i < len(base) and int(base[i][0].timestamp()) % (hours * 3600) != 0:
        i += 1
    while i + hours <= len(base):
        chunk = base[i:i + hours]
        out.append([chunk[0][0], chunk[0][1], max(r[2] for r in chunk), min(r[3] for r in chunk), chunk[-1][4], sum(r[5] for r in chunk)])
        i += hours
    return out


def synthetic_rows(symbol: str, interval: str, n: int, seed: int = 0, end: datetime | None = None) -> list[list]:
    """Return n rows [iso_time, open, high, low, close, volume] for `interval`."""
    step_h = INTERVAL_SECONDS[interval] // 3600
    if end is None:
        now = datetime.now(UTC).timestamp()
        end = datetime.fromtimestamp(now - now % 86400, tz=UTC)  # day-aligned so all intervals align
    base = _base_1h(symbol, n * step_h + 24, seed, end)
    rows = base if step_h == 1 else _aggregate(base, step_h)
    return [[r[0].isoformat(), *r[1:]] for r in rows[-n:]]


def synthetic_candles(symbol: str, interval: str, n_days: int, seed: int = 0) -> list[CandleRow]:
    """Candles covering n_days for `interval`, all derived from the same 1h path."""
    now = datetime.now(UTC).timestamp()
    end = datetime.fromtimestamp(now - now % 3600, tz=UTC)  # up to the last closed hour
    base = _base_1h(symbol, n_days * 24, seed, end)
    step_h = INTERVAL_SECONDS[interval] // 3600
    rows = base if step_h == 1 else _aggregate(base, step_h)
    step = timedelta(hours=step_h)
    q = lambda x: Decimal(str(round(x, 2)))  # noqa: E731
    return [CandleRow("synthetic", symbol, interval, r[0], r[0] + step - timedelta(milliseconds=1),
                      q(r[1]), q(r[2]), q(r[3]), q(r[4]), q(r[5]), quality="simulated") for r in rows]
