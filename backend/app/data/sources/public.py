"""Public market-data source adapters.

Endpoint contracts follow the providers' published documentation (links in
docs/DATA_SOURCES.md). They were NOT verifiable against live endpoints from the
build environment (egress blocked), so every parser validates shape and value
ranges and rejects rather than guesses when a payload deviates.
"""
from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from app.config import get_settings
from app.core.util import to_decimal, utcnow
from app.data.http import HttpFetcher
from app.data.types import CandleRow, Obs, SourceBatch, SourceUnconfigured

BINANCE_INTERVALS = {"15m", "1h", "4h", "1d"}


def _ms(ts: Any) -> datetime:
    return datetime.fromtimestamp(int(ts) / 1000, tz=UTC)


# ---------------------------------------------------------------- Binance spot

def binance_klines(fetcher: HttpFetcher, symbol: str, interval: str, limit: int = 500) -> SourceBatch:
    """GET /api/v3/klines. Each row: [openTime, open, high, low, close, volume,
    closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore].

    The still-forming candle (closeTime in the future) is dropped so that no
    downstream calculation can see an unfinished bar (look-ahead protection).
    """
    if interval not in BINANCE_INTERVALS:
        raise ValueError(f"unsupported interval {interval}")
    s = get_settings()
    res = fetcher.get_json(f"{s.binance_spot_base_url}/api/v3/klines", params={"symbol": symbol, "interval": interval, "limit": limit})
    batch = SourceBatch(source="binance", latency_ms=res.latency_ms)
    weight = res.headers.get("x-mbx-used-weight-1m")
    if weight:
        batch.rate_limit_info = {"used_weight_1m": int(weight), "limit_1m": 6000}
    if not isinstance(res.data, list):
        batch.rejected.append("klines payload is not a list")
        return batch
    now = utcnow()
    for row in res.data:
        if not isinstance(row, list) or len(row) < 7:
            batch.rejected.append(f"malformed kline row: {str(row)[:80]}")
            continue
        o, h, lo, c, v = (to_decimal(x) for x in row[1:6])
        if None in (o, h, lo, c, v):
            batch.rejected.append(f"non-numeric kline at {row[0]}")
            continue
        if min(o, h, lo, c) <= 0 or v < 0 or h < max(o, c, lo) or lo > min(o, c, h):
            batch.rejected.append(f"inconsistent OHLCV at {row[0]}")
            continue
        close_time = _ms(row[6])
        if close_time > now:
            continue  # forming candle
        batch.candles.append(CandleRow("binance", symbol, interval, _ms(row[0]), close_time, o, h, lo, c, v))
    return batch


# ------------------------------------------------------------ Binance futures

def binance_futures_context(fetcher: HttpFetcher, symbol: str) -> SourceBatch:
    """GET /fapi/v1/premiumIndex (mark/index price, last funding rate) and
    GET /fapi/v1/openInterest. USDⓈ-M perpetuals only."""
    s = get_settings()
    batch = SourceBatch(source="binance_futures")
    prem = fetcher.get_json(f"{s.binance_futures_base_url}/fapi/v1/premiumIndex", params={"symbol": symbol})
    batch.latency_ms = prem.latency_ms
    d = prem.data if isinstance(prem.data, dict) else {}
    ts = d.get("time")
    if ts is None:
        batch.rejected.append("premiumIndex missing time")
    else:
        observed = _ms(ts)
        rate = to_decimal(d.get("lastFundingRate"))
        mark = to_decimal(d.get("markPrice"))
        if rate is not None and abs(rate) < Decimal("0.05"):
            batch.observations.append(Obs("binance_futures", symbol, "funding_rate", rate, "fraction/8h", observed,
                                          meta={"next_funding_time": d.get("nextFundingTime")}))
        else:
            batch.rejected.append(f"funding rate missing or implausible: {d.get('lastFundingRate')}")
        if mark is not None and mark > 0:
            batch.observations.append(Obs("binance_futures", symbol, "mark_price", mark, "USDT", observed))
    oi = fetcher.get_json(f"{s.binance_futures_base_url}/fapi/v1/openInterest", params={"symbol": symbol})
    od = oi.data if isinstance(oi.data, dict) else {}
    oi_val = to_decimal(od.get("openInterest"))
    if oi_val is not None and oi_val >= 0 and od.get("time") is not None:
        batch.observations.append(Obs("binance_futures", symbol, "open_interest", oi_val, "contracts(base)", _ms(od["time"])))
    else:
        batch.rejected.append("openInterest missing or invalid")
    return batch


# ---------------------------------------------------------------- CoinGecko

COINGECKO_IDS = {"BTC": "bitcoin", "ETH": "ethereum"}


def coingecko_markets(fetcher: HttpFetcher) -> SourceBatch:
    """GET /simple/price and GET /global. A demo key (header x-cg-demo-api-key)
    is optional; keyless public access has a lower, unpublished-stable limit."""
    s = get_settings()
    headers = {}
    key = s.coingecko_api_key.get_secret_value()
    if key:
        headers["x-cg-demo-api-key"] = key
    batch = SourceBatch(source="coingecko")
    res = fetcher.get_json(
        f"{s.coingecko_base_url}/simple/price",
        params={
            "ids": ",".join(COINGECKO_IDS.values()),
            "vs_currencies": "usd",
            "include_market_cap": "true",
            "include_24hr_vol": "true",
            "include_24hr_change": "true",
            "include_last_updated_at": "true",
        },
        headers=headers,
    )
    batch.latency_ms = res.latency_ms
    data = res.data if isinstance(res.data, dict) else {}
    for asset, cg_id in COINGECKO_IDS.items():
        row = data.get(cg_id)
        if not isinstance(row, dict) or "last_updated_at" not in row:
            batch.rejected.append(f"{cg_id} missing from simple/price")
            continue
        observed = datetime.fromtimestamp(int(row["last_updated_at"]), tz=UTC)
        for field, metric, unit in (
            ("usd", "price", "USD"),
            ("usd_market_cap", "market_cap", "USD"),
            ("usd_24h_vol", "volume_24h", "USD"),
            ("usd_24h_change", "change_24h_pct", "percent"),
        ):
            val = to_decimal(row.get(field))
            if val is None or (metric != "change_24h_pct" and val <= 0):
                batch.rejected.append(f"{cg_id}.{field} invalid")
                continue
            batch.observations.append(Obs("coingecko", asset, metric, val, unit, observed))
    g = fetcher.get_json(f"{s.coingecko_base_url}/global", headers=headers)
    gd = (g.data or {}).get("data") if isinstance(g.data, dict) else None
    if isinstance(gd, dict) and gd.get("updated_at"):
        observed = datetime.fromtimestamp(int(gd["updated_at"]), tz=UTC)
        dom = to_decimal((gd.get("market_cap_percentage") or {}).get("btc"))
        total = to_decimal((gd.get("total_market_cap") or {}).get("usd"))
        if dom is not None and 0 < dom < 100:
            batch.observations.append(Obs("coingecko", "CRYPTO", "btc_dominance_pct", dom, "percent", observed))
        if total is not None and total > 0:
            batch.observations.append(Obs("coingecko", "CRYPTO", "total_market_cap", total, "USD", observed))
    else:
        batch.rejected.append("global payload missing data.updated_at")
    return batch


# ---------------------------------------------------------------- FRED

# DXY itself is an ICE index and is not on FRED; DTWEXBGS (broad trade-weighted
# USD index) is the documented proxy and is labeled as such everywhere.
FRED_SERIES: dict[str, tuple[str, str, str]] = {
    "DFF": ("fed_funds_effective", "percent", "daily"),
    "DGS10": ("ust_10y_yield", "percent", "daily"),
    "DGS2": ("ust_2y_yield", "percent", "daily"),
    "DTWEXBGS": ("usd_broad_index", "index", "daily"),
    "CPIAUCSL": ("cpi_all_items", "index_1982_84", "monthly"),
    "UNRATE": ("unemployment_rate", "percent", "monthly"),
    "WALCL": ("fed_total_assets", "usd_millions", "weekly"),
    "RRPONTSYD": ("reverse_repo", "usd_billions", "daily"),
}


def fred_series(fetcher: HttpFetcher, series_ids: list[str] | None = None, limit: int = 30) -> SourceBatch:
    """GET /series/observations?series_id=..&api_key=..&file_type=json.

    FRED's `date` is the observation period, not the release time. The vintage
    date (`realtime_start`) is stored in meta as `available_since` so agents can
    cite when the value became public.
    """
    s = get_settings()
    key = s.fred_api_key.get_secret_value()
    if not key:
        raise SourceUnconfigured("FRED_API_KEY not set")
    batch = SourceBatch(source="fred")
    for sid in series_ids or list(FRED_SERIES):
        metric, unit, freq = FRED_SERIES[sid]
        res = fetcher.get_json(
            f"{s.fred_base_url}/series/observations",
            params={"series_id": sid, "api_key": key, "file_type": "json", "sort_order": "desc", "limit": limit},
        )
        batch.latency_ms = max(batch.latency_ms, res.latency_ms)
        obs = res.data.get("observations") if isinstance(res.data, dict) else None
        if not isinstance(obs, list):
            batch.rejected.append(f"{sid}: observations missing")
            continue
        for o in obs:
            val = to_decimal(o.get("value"))
            if val is None:
                continue  # FRED uses "." for missing; skip, never fill
            try:
                observed = datetime.strptime(o["date"], "%Y-%m-%d").replace(tzinfo=UTC)
            except (KeyError, ValueError):
                batch.rejected.append(f"{sid}: bad date {o.get('date')}")
                continue
            batch.observations.append(Obs("fred", "MACRO", metric, val, unit, observed, timeframe=freq,
                                          meta={"series_id": sid, "available_since": o.get("realtime_start")}))
    return batch


# ---------------------------------------------------------------- DefiLlama

def defillama_overview(fetcher: HttpFetcher) -> SourceBatch:
    """GET api.llama.fi/v2/historicalChainTvl (total DeFi TVL, daily) and
    GET stablecoins.llama.fi/stablecoincharts/all (total stablecoin supply)."""
    s = get_settings()
    batch = SourceBatch(source="defillama")
    tvl = fetcher.get_json(f"{s.defillama_base_url}/v2/historicalChainTvl")
    batch.latency_ms = tvl.latency_ms
    if isinstance(tvl.data, list) and tvl.data:
        for row in tvl.data[-14:]:
            val = to_decimal(row.get("tvl")) if isinstance(row, dict) else None
            if val is None or val <= 0 or "date" not in row:
                batch.rejected.append("tvl row invalid")
                continue
            batch.observations.append(Obs("defillama", "DEFI", "total_tvl", val, "USD",
                                          datetime.fromtimestamp(int(row["date"]), tz=UTC), timeframe="daily"))
    else:
        batch.rejected.append("historicalChainTvl empty or malformed")
    st = fetcher.get_json(f"{s.defillama_stablecoins_url}/stablecoincharts/all")
    if isinstance(st.data, list) and st.data:
        for row in st.data[-14:]:
            circ = (row.get("totalCirculatingUSD") or {}).get("peggedUSD") if isinstance(row, dict) else None
            val = to_decimal(circ)
            if val is None or val <= 0 or "date" not in row:
                batch.rejected.append("stablecoin row invalid")
                continue
            batch.observations.append(Obs("defillama", "STABLECOINS", "total_supply_usd_pegged", val, "USD",
                                          datetime.fromtimestamp(int(row["date"]), tz=UTC), timeframe="daily"))
    else:
        batch.rejected.append("stablecoincharts empty or malformed")
    return batch


# ------------------------------------------------------------ Alternative.me

def fear_greed(fetcher: HttpFetcher, limit: int = 7) -> SourceBatch:
    """GET /fng/?limit=N. Values 0-100, daily."""
    s = get_settings()
    res = fetcher.get_json(f"{s.alternative_me_url}/fng/", params={"limit": limit})
    batch = SourceBatch(source="alternative_me", latency_ms=res.latency_ms)
    rows = res.data.get("data") if isinstance(res.data, dict) else None
    if not isinstance(rows, list):
        batch.rejected.append("fng payload missing data")
        return batch
    for r in rows:
        val = to_decimal(r.get("value"))
        if val is None or not (0 <= val <= 100) or "timestamp" not in r:
            batch.rejected.append(f"fng row invalid: {str(r)[:60]}")
            continue
        batch.observations.append(Obs("alternative_me", "CRYPTO", "fear_greed_index", val, "index_0_100",
                                      datetime.fromtimestamp(int(r["timestamp"]), tz=UTC), timeframe="daily",
                                      meta={"classification": r.get("value_classification")}))
    return batch
