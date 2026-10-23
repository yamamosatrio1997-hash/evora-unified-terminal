"""TradingView push ingestion. Payloads are FIXTURES shaped like the TradingView MCP
get_ohlcv / get_symbol_data_batch responses; they are not live data."""
from __future__ import annotations

import os
import time
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.util import utcnow
from app.data.snapshot import _series, build_snapshot, latest_price, preferred_candle_source
from app.data.sources import tradingview
from app.db.models import Candle, MarketObservation, SourceHealth
from app.main import create_app

SERVICE = {"Authorization": f"Bearer {os.environ['SERVICE_TOKEN']}"}
H = 3600


def bars(n, interval=H, start_offset=1, **over):
    now = int(time.time())
    last_open = now - now % interval
    out = []
    for i in range(n, 0, -1):
        t = last_open - (i + start_offset - 1) * interval
        out.append({"t": t, "o": 100.0, "h": 101.0, "l": 99.0, "c": 100.5, "v": 12.5} | over)
    return out


def series(interval="1h", secs=H, extra=None, **kw):
    b = bars(5, secs)
    b.append({"t": b[-1]["t"] + secs, "o": 100, "h": 101, "l": 99, "c": 100, "v": 1})  # still forming
    b += extra or []
    return {"symbol": "BTCUSDT", "tv_symbol": "BINANCE:BTCUSDT", "interval": interval, "bars": b} | kw


@pytest.fixture()
def client(db):
    with TestClient(create_app()) as c:
        yield c


def test_parse_series_drops_forming_and_invalid_bars():
    now = utcnow()
    first = bars(5)[0]["t"]
    b = tradingview.parse_series(series(extra=[
        {"t": first - H, "o": 100, "h": 90, "l": 99, "c": 100, "v": 1},  # high < open
        {"t": first - H - 7, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1},  # not aligned
        {"t": first - 3 * H, "o": "x", "h": 1, "l": 1, "c": 1},  # non-numeric
    ]), now)
    assert len(b.candles) == 5
    assert all(c.close_time <= now and c.source == "tradingview" for c in b.candles)
    assert len(b.rejected) == 3
    assert b.candles[0].close_time - b.candles[0].open_time == timedelta(hours=1) - timedelta(milliseconds=1)


def test_parse_series_rejects_unknown_symbols_and_intervals():
    now = utcnow()
    assert tradingview.parse_series(series(symbol="DOGEUSDT", tv_symbol="BINANCE:DOGEUSDT"), now).rejected
    assert tradingview.parse_series(series(tv_symbol="COINBASE:BTCUSD"), now).rejected
    assert tradingview.parse_series(series(interval="15m"), now).rejected
    daily = tradingview.parse_series(series(interval="1D", secs=86400), now)
    assert {c.interval for c in daily.candles} == {"1d"}


def test_parse_quotes_maps_only_identical_metrics_and_flags_delay():
    now = utcnow()
    b = tradingview.parse_quotes([
        {"tv_symbol": "BINANCE:BTCUSDT", "close": 80649.35, "change": -0.87, "update_mode": "streaming"},
        {"tv_symbol": "CRYPTOCAP:TOTAL", "close": 2.67e12, "update_mode": "delayed_streaming_900"},
        {"tv_symbol": "TVC:US10Y", "close": 4.21, "update_mode": "streaming"},
        {"tv_symbol": "CRYPTO:BTCUSD", "market_cap_calc": 1.6e12, "vol_to_market_cap": 0.0125, "update_mode": "streaming"},
        {"tv_symbol": "TVC:DXY", "close": 101.2, "update_mode": "streaming"},  # not the Fed broad index
        {"tv_symbol": "BINANCE:BTCUSDT.P", "close": 80650, "update_mode": "streaming"},  # mark price stays with Binance futures
    ], now)
    got = {(o.asset, o.metric): o for o in b.observations}
    assert got[("BTC", "price")].value == Decimal("80649.35") and got[("BTC", "price")].quality == "ok"
    assert got[("BTC", "change_24h_pct")].value == Decimal("-0.87")
    assert got[("CRYPTO", "total_market_cap")].quality == "delayed"
    assert ("MACRO", "ust_10y_yield") in got
    assert got[("BTC", "market_cap")].value == Decimal("1.6E+12")
    assert got[("BTC", "volume_24h")].value == Decimal("0.0125") * Decimal("1.6E+12")
    assert got[("BTC", "volume_24h")].meta["derived"] == "24h_vol_to_market_cap * market_cap_calc"
    assert len(b.rejected) == 2 and all("unmapped" in r for r in b.rejected)


def test_push_endpoint_requires_service_token_and_persists(client, db):
    body = {"series": [series()], "quotes": [{"tv_symbol": "BINANCE:BTCUSDT", "close": 80000, "change": 1.2, "update_mode": "streaming"}]}
    assert client.post("/api/service/ingest/tradingview", json=body).status_code == 401
    r = client.post("/api/service/ingest/tradingview", json=body, headers=SERVICE)
    assert r.status_code == 200, r.text
    assert r.json()["new_candles"] == 5 and r.json()["new_observations"] == 2
    again = client.post("/api/service/ingest/tradingview", json=body, headers=SERVICE).json()
    assert again["new_candles"] == 0  # deduplicated
    db.expire_all()
    assert db.get(SourceHealth, "tradingview").status == "ok"
    assert client.post("/api/service/ingest/tradingview", json={}, headers=SERVICE).status_code == 422
    too_many = {"series": [series()] * 21}
    assert client.post("/api/service/ingest/tradingview", json=too_many, headers=SERVICE).status_code == 422


def _add_candles(db, source, last_close_ago_h, n=3):
    now = utcnow().replace(minute=0, second=0, microsecond=0)
    for i in range(n):
        ot = now - timedelta(hours=last_close_ago_h + n - i)
        db.add(Candle(source=source, symbol="BTCUSDT", interval="1h", open_time=ot, close_time=ot + timedelta(hours=1) - timedelta(milliseconds=1),
                      open=1, high=2, low=1, close=Decimal(100 + i) if source == "tradingview" else Decimal(200 + i),
                      volume=1, retrieved_at=now, quality="ok"))
    db.flush()


def test_tradingview_is_primary_while_fresh(db):
    _add_candles(db, "binance", 0)
    _add_candles(db, "tradingview", 0)
    assert preferred_candle_source(db, "BTCUSDT", "1h") == "tradingview"
    price, _, src = latest_price(db, "BTCUSDT")
    assert src == "tradingview" and price == Decimal(102)


def test_stale_tradingview_falls_back_to_fresh_source(db):
    _add_candles(db, "tradingview", 10)  # 10 h old: stale for 1h bars
    _add_candles(db, "binance", 0)
    assert preferred_candle_source(db, "BTCUSDT", "1h") == "binance"
    snap = build_snapshot(db, "BTCUSDT", intervals=("1h",))
    assert snap.content["candles"]["1h"]["source"] == "binance"


def test_metric_series_never_interleaves_sources(db):
    now = utcnow()
    for i, src in enumerate(["coingecko", "tradingview", "coingecko", "tradingview"]):
        t = now - timedelta(minutes=10 - i)
        db.add(MarketObservation(source=src, asset="BTC", metric="price", value=100 + i, unit="USD", observed_at=t,
                                 retrieved_at=t, timeframe="point", quality="ok", meta={}))
    db.flush()
    rows = _series(db, "BTC", "price", 10)
    assert {r.source for r in rows} == {"tradingview"} and len(rows) == 2
    assert db.scalars(select(MarketObservation)).all()  # nothing deleted


def test_candles_endpoint_reports_source_and_live_quote(client, db):
    from app.db.models import User
    from app.security.passwords import hash_password

    db.add(User(username="viewer", password_hash=hash_password("correct-horse-battery"), role="viewer"))
    db.commit()
    body = {"series": [series()], "quotes": [{"tv_symbol": "BINANCE:BTCUSDT", "close": 80649.35, "change": -0.8, "update_mode": "streaming"}]}
    assert client.post("/api/service/ingest/tradingview", json=body, headers=SERVICE).status_code == 200
    client.post("/api/auth/login", json={"username": "viewer", "password": "correct-horse-battery"})
    d = client.get("/api/market/candles?symbol=BTCUSDT&interval=1h&limit=10").json()
    assert d["source"] == "tradingview" and d["status"] == "ok"
    assert d["quote"]["price"] == 80649.35 and d["quote"]["realtime"] is True


def test_btc_dominance_comes_from_ohlcv_and_screener_alias_is_rejected():
    now = utcnow()
    # Live finding: the screener returned BTC's price for CRYPTOCAP:BTC.D. It must never become "dominance".
    bad = tradingview.parse_quotes([{"tv_symbol": "CRYPTOCAP:BTC.D", "close": 80807.14, "update_mode": "streaming"}], now)
    assert not bad.observations and bad.rejected
    t = int(time.time()) // 86400 * 86400
    ok = tradingview.parse_indices([{"tv_symbol": "CRYPTOCAP:BTC.D", "bars": [
        {"t": t - 86400, "o": 60.7, "h": 60.7, "l": 60.5, "c": 60.59, "v": 1},
        {"t": t, "o": 60.6, "h": 60.7, "l": 60.4, "c": 60.63, "v": 1},
    ]}], now)
    assert ok.observations[0].metric == "btc_dominance_pct" and ok.observations[0].value == Decimal("60.63")
    alias = tradingview.parse_indices([{"tv_symbol": "CRYPTOCAP:BTC.D", "bars": [{"t": t, "o": 1, "h": 1, "l": 1, "c": 80807.14}]}], now)
    assert not alias.observations and "implausible" in alias.rejected[0]
    yields = tradingview.parse_quotes([{"tv_symbol": "TVC:US10Y", "close": 80807.14, "update_mode": "streaming"}], now)
    assert not yields.observations
