"""TradingView market data, pushed by the n8n orchestrator from the TradingView MCP server.

The backend never talks to TradingView itself: n8n holds the OAuth connection, calls the
MCP tools (get_ohlcv, get_symbol_data_batch) and posts the raw results here. This module
validates them exactly like the pull adapters do. Bars that are still forming are dropped
(look-ahead protection), and quotes that TradingView reports as not streaming are stored
with quality="delayed" so they are never presented as real time.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from app.config import get_settings
from app.data.types import CandleRow, Obs, SourceBatch

SOURCE = "tradingview"

# TradingView interval -> (internal interval, seconds)
TV_INTERVALS: dict[str, tuple[str, int]] = {"1h": ("1h", 3600), "4h": ("4h", 14400), "1D": ("1d", 86400), "1d": ("1d", 86400)}


def _dec(x: Any) -> Decimal | None:
    if x is None or isinstance(x, bool):
        return None
    try:
        d = Decimal(str(x))
    except (InvalidOperation, ValueError):
        return None
    return d if d.is_finite() else None


def _base(symbol: str) -> str:
    for quote in ("USDT", "USDC", "USD"):
        if symbol.endswith(quote):
            return symbol[: -len(quote)]
    return symbol


def tv_symbol(symbol: str) -> str:
    return f"{get_settings().tradingview_exchange}:{symbol}"


def quote_map() -> dict[str, list[tuple[str, str, str, str]]]:
    """TradingView ticker -> [(quote field, asset, metric, unit)].

    Only tickers whose meaning is identical to the existing metric are mapped. Perpetual mark
    price, funding, open interest, DXY (not the Fed broad USD index), TVL and stablecoin supply
    stay with their original sources.
    """
    m: dict[str, list[tuple[str, str, str, str]]] = {}
    for sym in get_settings().symbols:
        base = _base(sym)
        m[tv_symbol(sym)] = [("close", base, "price", "USDT"), ("change", base, "change_24h_pct", "percent")]
        # Coin-level (all-exchange) figures. 24h volume is derived from two TradingView fields.
        m[f"CRYPTO:{base}USD"] = [("market_cap_calc", base, "market_cap", "USD"), ("volume_24h_derived", base, "volume_24h", "USD")]
    m["CRYPTOCAP:TOTAL"] = [("close", "CRYPTO", "total_market_cap", "USD")]
    m["TVC:US10Y"] = [("close", "MACRO", "ust_10y_yield", "percent")]
    m["TVC:US02Y"] = [("close", "MACRO", "ust_2y_yield", "percent")]
    return m


# Indices read from get_ohlcv (latest bar) because the screener mis-resolves them:
# get_symbol_data_batch returned BTC's price for CRYPTOCAP:BTC.D in live testing.
INDEX_MAP: dict[str, tuple[str, str, str]] = {"CRYPTOCAP:BTC.D": ("CRYPTO", "btc_dominance_pct", "percent")}

# Plausible ranges; anything outside is rejected rather than stored.
PLAUSIBLE: dict[str, tuple[Decimal, Decimal]] = {
    "btc_dominance_pct": (Decimal(0), Decimal(100)),
    "ust_10y_yield": (Decimal(-5), Decimal(30)),
    "ust_2y_yield": (Decimal(-5), Decimal(30)),
    "change_24h_pct": (Decimal(-100), Decimal(1000)),
}


def _plausible(metric: str, val: Decimal) -> bool:
    if metric in PLAUSIBLE:
        lo, hi = PLAUSIBLE[metric]
        return lo < val < hi
    return val > 0


def parse_series(series: dict[str, Any], now: datetime) -> SourceBatch:
    """One get_ohlcv result: {symbol, tv_symbol, interval, bars: [{t, o, h, l, c, v}]}."""
    batch = SourceBatch(source=SOURCE)
    symbol = str(series.get("symbol", "")).upper()
    if symbol not in get_settings().symbols:
        batch.rejected.append(f"symbol {symbol!r} is not in WATCH_SYMBOLS")
        return batch
    if series.get("tv_symbol") != tv_symbol(symbol):
        batch.rejected.append(f"tv_symbol {series.get('tv_symbol')!r} does not match {tv_symbol(symbol)!r}")
        return batch
    iv = TV_INTERVALS.get(str(series.get("interval")))
    if iv is None:
        batch.rejected.append(f"unsupported interval {series.get('interval')!r}")
        return batch
    interval, secs = iv
    bars = series.get("bars")
    if not isinstance(bars, list):
        batch.rejected.append(f"{symbol} {interval}: bars is not a list")
        return batch
    seen: set[int] = set()
    for bar in sorted((b for b in bars if isinstance(b, dict) and isinstance(b.get("t"), int)), key=lambda b: b["t"]):
        t = bar["t"]
        if t in seen:
            continue
        seen.add(t)
        if t % secs:
            batch.rejected.append(f"{symbol} {interval}: bar {t} not aligned to the interval")
            continue
        o, h, lo, c = (_dec(bar.get(k)) for k in ("o", "h", "l", "c"))
        v = _dec(bar.get("v"))
        if None in (o, h, lo, c):
            batch.rejected.append(f"{symbol} {interval}: non-numeric bar at {t}")
            continue
        v = v if v is not None else Decimal(0)
        if min(o, h, lo, c) <= 0 or v < 0 or h < max(o, c, lo) or lo > min(o, c, h):
            batch.rejected.append(f"{symbol} {interval}: inconsistent OHLCV at {t}")
            continue
        open_time = datetime.fromtimestamp(t, UTC)
        close_time = open_time + timedelta(seconds=secs) - timedelta(milliseconds=1)
        if close_time > now:
            continue  # still forming
        batch.candles.append(CandleRow(SOURCE, symbol, interval, open_time, close_time, o, h, lo, c, v))
    return batch


def parse_quotes(quotes: list[dict[str, Any]], now: datetime) -> SourceBatch:
    """get_symbol_data_batch rows: {tv_symbol, close, change, market_cap_calc, vol_to_market_cap, update_mode}.
    Unknown tickers are rejected."""
    batch = SourceBatch(source=SOURCE)
    mapping = quote_map()
    for q in quotes:
        key = q.get("tv_symbol")
        targets = mapping.get(key) if isinstance(key, str) else None
        if not targets:
            batch.rejected.append(f"unmapped TradingView ticker {key!r}")
            continue
        mode = q.get("update_mode")
        quality = "ok" if mode == "streaming" else "delayed"
        for field, asset, metric, unit in targets:
            meta: dict[str, Any] = {"tv_symbol": key, "update_mode": mode}
            if field == "volume_24h_derived":
                ratio, mcap = _dec(q.get("vol_to_market_cap")), _dec(q.get("market_cap_calc"))
                val = ratio * mcap if ratio is not None and mcap is not None else None
                meta["derived"] = "24h_vol_to_market_cap * market_cap_calc"
            else:
                val = _dec(q.get(field))
            if val is None:
                continue  # field not provided; never substitute
            if not _plausible(metric, val):
                batch.rejected.append(f"{key} {field} implausible for {metric}: {val}")
                continue
            batch.observations.append(Obs(SOURCE, asset, metric, val, unit, now, quality=quality, meta=meta))
    return batch


def parse_indices(indices: list[dict[str, Any]], now: datetime) -> SourceBatch:
    """get_ohlcv results for index tickers: the newest bar's close is the current value."""
    batch = SourceBatch(source=SOURCE)
    for item in indices:
        key = item.get("tv_symbol")
        target = INDEX_MAP.get(key) if isinstance(key, str) else None
        if target is None:
            batch.rejected.append(f"unmapped TradingView index {key!r}")
            continue
        asset, metric, unit = target
        bars = [b for b in item.get("bars") or [] if isinstance(b, dict) and isinstance(b.get("t"), int)]
        if not bars:
            batch.rejected.append(f"{key}: no bars")
            continue
        last = max(bars, key=lambda b: b["t"])
        if datetime.fromtimestamp(last["t"], UTC) > now:
            batch.rejected.append(f"{key}: bar in the future")
            continue
        val = _dec(last.get("c"))
        if val is None or not _plausible(metric, val):
            batch.rejected.append(f"{key} close implausible for {metric}: {last.get('c')}")
            continue
        batch.observations.append(Obs(SOURCE, asset, metric, val, unit, now,
                                      meta={"tv_symbol": key, "from": "get_ohlcv latest bar", "bar_open": last["t"]}))
    return batch
