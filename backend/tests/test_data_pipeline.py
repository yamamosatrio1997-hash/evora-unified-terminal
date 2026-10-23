"""Ingestion tests. Payloads are FIXTURES shaped after the providers' documented
responses; they are not live data and are never persisted outside the test DB."""
from __future__ import annotations

import time
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import func, select

from app.core.util import utcnow
from app.data.http import FetchError, HttpFetcher
from app.data.ingest import run_ingestion
from app.data.snapshot import build_snapshot
from app.data.sources import public
from app.db.models import Candle, MarketObservation, SourceHealth

NOW_MS = int(time.time() * 1000)
H = 3_600_000


def kline(i, o=100.0, h=101.0, lo=99.0, c=100.5, v=10.0, interval_ms=H):
    open_t = NOW_MS - (NOW_MS % interval_ms) - (i + 1) * interval_ms
    return [open_t, str(o), str(h), str(lo), str(c), str(v), open_t + interval_ms - 1, "0", 0, "0", "0", "0"]


def handler(req: httpx.Request) -> httpx.Response:
    p = req.url.path
    if p.endswith("/api/v3/klines"):
        iv = {"1h": H, "4h": 4 * H, "1d": 24 * H}[req.url.params["interval"]]
        rows = [kline(i, interval_ms=iv) for i in range(5, 0, -1)]
        rows.append(kline(-1, interval_ms=iv))  # still-forming candle (closes in future)
        rows.append(kline(10, o=100, h=90, lo=99, c=100, interval_ms=iv))  # inconsistent: high < open
        rows.append([1, "x"])  # malformed
        return httpx.Response(200, json=rows, headers={"x-mbx-used-weight-1m": "12"})
    if p.endswith("/fapi/v1/premiumIndex"):
        return httpx.Response(200, json={"symbol": "BTCUSDT", "markPrice": "60000.1", "lastFundingRate": "0.0001",
                                         "nextFundingTime": NOW_MS + H, "time": NOW_MS})
    if p.endswith("/fapi/v1/openInterest"):
        return httpx.Response(200, json={"symbol": "BTCUSDT", "openInterest": "80000.5", "time": NOW_MS})
    if p.endswith("/simple/price"):
        return httpx.Response(200, json={
            "bitcoin": {"usd": 60000, "usd_market_cap": 1.2e12, "usd_24h_vol": 3e10, "usd_24h_change": -1.2, "last_updated_at": NOW_MS // 1000},
            "ethereum": {"usd": 3000, "usd_market_cap": -5, "usd_24h_vol": 1e10, "usd_24h_change": 0.5, "last_updated_at": NOW_MS // 1000}})
    if p.endswith("/global"):
        return httpx.Response(200, json={"data": {"market_cap_percentage": {"btc": 55.1}, "total_market_cap": {"usd": 2.2e12}, "updated_at": NOW_MS // 1000}})
    if p.endswith("/v2/historicalChainTvl"):
        return httpx.Response(200, json=[{"date": NOW_MS // 1000 - 86400 * i, "tvl": 9e10 + i} for i in range(10, 0, -1)])
    if p.endswith("/stablecoincharts/all"):
        return httpx.Response(200, json=[{"date": NOW_MS // 1000 - 86400 * i, "totalCirculatingUSD": {"peggedUSD": 1.6e11}} for i in range(10, 0, -1)])
    if p.endswith("/fng/"):
        return httpx.Response(200, json={"data": [{"value": "44", "value_classification": "Fear", "timestamp": str(NOW_MS // 1000)},
                                                  {"value": "180", "value_classification": "bad", "timestamp": str(NOW_MS // 1000 - 86400)}]})
    return httpx.Response(404)


def fetcher(h=handler):
    return HttpFetcher(transport=httpx.MockTransport(h), sleep=lambda s: None)


def test_binance_klines_validation():
    b = public.binance_klines(fetcher(), "BTCUSDT", "1h")
    assert len(b.candles) == 5  # forming, inconsistent and malformed rows excluded
    assert len(b.rejected) == 2
    assert all(c.close_time <= utcnow() for c in b.candles)
    assert b.rate_limit_info["used_weight_1m"] == 12


def test_full_ingestion_dedup_and_health(db):
    s1 = run_ingestion(db, fetcher=fetcher())
    db.commit()
    assert s1["binance"]["new_candles"] == 2 * 3 * 5
    assert s1["binance"]["status"] == "degraded"  # rows rejected -> visible, not silent
    assert s1["fred"]["status"] == "unconfigured"
    assert s1["coingecko"]["rejected"] >= 1  # negative market cap rejected
    assert s1["alternative_me"]["rejected"] == 1  # 180 out of range
    s2 = run_ingestion(db, fetcher=fetcher())
    db.commit()
    assert s2["binance"]["new_candles"] == 0  # deduplicated
    assert db.scalar(select(func.count()).select_from(Candle)) == 30
    h = db.get(SourceHealth, "fred")
    assert h.status == "unconfigured"
    obs = db.scalar(select(MarketObservation).where(MarketObservation.metric == "funding_rate"))
    assert obs.source == "binance_futures" and obs.retrieved_at is not None and obs.observed_at is not None


def test_outage_marks_source_down(db):
    def down(req):
        return httpx.Response(503)

    for _ in range(3):
        run_ingestion(db, ["coingecko"], fetcher=fetcher(down))
    db.commit()
    h = db.get(SourceHealth, "coingecko")
    assert h.status == "down" and h.consecutive_failures == 3


def test_retry_then_success():
    calls = {"n": 0}

    def flaky(req):
        calls["n"] += 1
        return httpx.Response(429) if calls["n"] < 3 else handler(req)

    b = public.fear_greed(fetcher(flaky))
    assert calls["n"] == 3 and b.observations


def test_418_not_retried():
    calls = {"n": 0}

    def banned(req):
        calls["n"] += 1
        return httpx.Response(418)

    with pytest.raises(FetchError):
        public.fear_greed(fetcher(banned))
    assert calls["n"] == 1


def test_malformed_payloads_rejected():
    b = public.fear_greed(fetcher(lambda r: httpx.Response(200, json={"unexpected": True})))
    assert not b.observations and b.rejected
    b = public.coingecko_markets(fetcher(lambda r: httpx.Response(200, json=[1, 2, 3])))
    assert not b.observations and len(b.rejected) >= 2


def test_fred_requires_key_and_skips_missing(monkeypatch):
    from app.config import get_settings
    from app.data.types import SourceUnconfigured

    with pytest.raises(SourceUnconfigured):
        public.fred_series(fetcher())
    monkeypatch.setattr(get_settings(), "fred_api_key", type(get_settings().fred_api_key)("k" * 32))

    def fred(req):
        assert req.url.params["api_key"] == "k" * 32
        return httpx.Response(200, json={"observations": [
            {"date": "2026-10-01", "value": "4.1", "realtime_start": "2026-10-02"},
            {"date": "2026-09-30", "value": ".", "realtime_start": "2026-10-01"}]})

    b = public.fred_series(fetcher(fred), ["DGS10"])
    assert len(b.observations) == 1  # "." means missing: skipped, never filled
    assert b.observations[0].meta["available_since"] == "2026-10-02"


def test_snapshot_detects_stale_and_missing(db):
    run_ingestion(db, ["binance", "binance_futures"], fetcher=fetcher())
    old = utcnow() - timedelta(days=3)
    db.add(MarketObservation(source="coingecko", asset="BTC", metric="price", value=1, unit="USD", observed_at=old,
                             retrieved_at=old, timeframe="point", quality="ok", meta={}))
    db.flush()
    snap = build_snapshot(db, "BTCUSDT")
    q = snap.quality_summary
    assert "BTC:price" in q["stale"]
    assert "MACRO:ust_10y_yield" in q["missing"]
    assert not snap.is_simulated
    assert len(snap.content_hash) == 64
    assert snap.content["metrics"]["BTCUSDT:funding_rate"]["latest"]["observation_id"]
