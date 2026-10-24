from __future__ import annotations

import ast
import hashlib
import hmac
import inspect
from datetime import timedelta
from decimal import Decimal as D
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select

from app.core.util import utcnow
from app.db.models import Candle, ExchangeSnapshot, PaperOrder, PaperPosition
from app.exchange import execution, mexc
from app.paper import engine as paper
from app.risk.engine import TradeProposal
from app.risk.service import PAPER_SPECS, evaluate_and_record, set_emergency_stop


def seed_price(db, price=60000.0, age_s=30, volume=1000.0):
    now = utcnow()
    db.add(Candle(source="binance", symbol="BTCUSDT", interval="1h", open_time=now - timedelta(hours=1, seconds=age_s),
                  close_time=now - timedelta(seconds=age_s), open=price, high=price * 1.001, low=price * 0.999, close=price,
                  volume=volume, retrieved_at=now, quality="ok"))
    db.flush()


def approved_risk(db, entry=D("60000"), stop=D("58800")):
    acct = paper.get_account(db)
    p = TradeProposal("BTCUSDT", "long", entry, stop, D("62400"), D("2"), D("0.01"), utcnow() - timedelta(seconds=30), funding_rate_8h=D("0.0001"))
    res, row = evaluate_and_record(db, p, paper.portfolio_state(db, acct), PAPER_SPECS["BTCUSDT"])
    assert res.approved
    return row


def test_paper_fill_from_approved_risk(db):
    seed_price(db)
    row = approved_risk(db)
    order = paper.submit_entry_from_risk(db, row)
    assert order.status == "FILLED"
    assert order.avg_fill_price > D("60000")  # adverse slippage applied
    assert order.fee > 0
    pos = db.get(PaperPosition, order.position_id)
    assert pos.planned_risk <= D("100")


def test_paper_duplicate_submission_is_idempotent(db):
    seed_price(db)
    row = approved_risk(db)
    a = paper.submit_entry_from_risk(db, row)
    b = paper.submit_entry_from_risk(db, row)
    assert a.id == b.id
    assert len(db.scalars(select(PaperOrder)).all()) == 1


def test_paper_rejects_stale_tampered_expired_or_stopped(db):
    seed_price(db, age_s=3600 * 3)
    acct = paper.get_account(db)
    p = TradeProposal("BTCUSDT", "long", D("60000"), D("58800"), None, D("1"), D("0.01"), utcnow())
    _, row = evaluate_and_record(db, p, paper.portfolio_state(db, acct), PAPER_SPECS["BTCUSDT"])
    assert paper.submit_entry_from_risk(db, row).reject_reason == "no fresh price to simulate a fill"

    seed_price(db, age_s=10)
    row2 = approved_risk(db)
    db.expunge(row2)
    row2.result = dict(row2.result, qty="999")  # tampered in memory
    assert "integrity" in paper.submit_entry_from_risk(db, row2).reject_reason

    row3 = approved_risk(db)
    row3.created_at = utcnow() - timedelta(hours=1)
    db.expunge(row3)
    assert "expired" in paper.submit_entry_from_risk(db, row3).reject_reason

    row4 = approved_risk(db)
    set_emergency_stop(db, True, "test", "pytest")
    assert paper.submit_entry_from_risk(db, row4).reject_reason == "emergency stop active"


def test_paper_rejects_price_drift(db):
    seed_price(db, price=61000)
    row = approved_risk(db, entry=D("60000"))
    assert "price moved" in paper.submit_entry_from_risk(db, row).reject_reason


def test_partial_fill_against_liquidity(db):
    seed_price(db, volume=0.05)  # thin bar: 10% participation = 0.005 BTC
    row = approved_risk(db)
    order = paper.submit_entry_from_risk(db, row)
    assert order.status == "PARTIALLY_FILLED_CANCELED"
    assert order.filled_qty == D("0.005") < order.qty


def test_stop_hit_closes_position(db):
    seed_price(db)
    order = paper.submit_entry_from_risk(db, approved_risk(db))
    pos = db.get(PaperPosition, order.position_id)
    later = utcnow() + timedelta(hours=1)
    db.add(Candle(source="binance", symbol="BTCUSDT", interval="1h", open_time=later, close_time=later + timedelta(hours=1),
                  open=59500, high=60200, low=58000, close=58100, volume=100, retrieved_at=utcnow(), quality="ok"))
    db.flush()
    res = paper.mark_to_market(db)
    assert pos.id in res["closed_positions"]
    db.refresh(pos)
    assert pos.exit_reason == "stop_loss" and pos.realized_pnl < 0
    perf = paper.performance(db)
    assert perf["trades"] == 1 and perf["data_kind"].startswith("PAPER")


def test_paper_engine_has_no_exchange_or_network_imports():
    src = Path(inspect.getfile(paper)).read_text()
    names = {n.names[0].name if isinstance(n, ast.Import) else n.module for n in ast.walk(ast.parse(src)) if isinstance(n, (ast.Import, ast.ImportFrom))}
    assert not any(x and ("exchange" in x or "httpx" in x or "requests" in x) for x in names)


# ------------------------------------------------------------------- execution adapter

def test_live_submission_always_refused(db):
    seed_price(db)
    order = execution.prepare_order(approved_risk(db))
    with pytest.raises(execution.LiveTradingDisabled):
        execution.submit(db, order, "pytest")
    assert execution.LIVE_EXECUTION_IMPLEMENTED is False


def test_reconcile_state_machine():
    o = execution.PreparedOrder("c", "BTCUSDT", "BUY", D("1"), D("1"), None, 1)
    execution.reconcile(o, "NEW", D("0"))
    assert o.state == "NEW"
    execution.reconcile(o, "PARTIALLY_FILLED", D("0.4"))
    assert o.state == "PARTIALLY_FILLED" and execution.blocks_new_orders(o)
    execution.reconcile(o, None, None)
    assert o.state == "UNKNOWN" and execution.blocks_new_orders(o)  # unknown never treated as done
    execution.reconcile(o, "FILLED", D("0.3"))  # fill decreased: inconsistent
    assert o.state == "UNKNOWN"
    execution.reconcile(o, "FILLED", D("0.6"))  # 'FILLED' but qty short -> partial
    assert o.state == "PARTIALLY_FILLED"
    execution.reconcile(o, "FILLED", D("1"))
    assert o.state == "FILLED" and not execution.blocks_new_orders(o)
    execution.reconcile(o, "CANCELED", D("1"))
    assert o.state == "FILLED"  # terminal is sticky
    r = execution.reconcile(execution.PreparedOrder("d", "BTCUSDT", "BUY", D("1"), D("1"), None, 1), "REJECTED", None)
    assert r.state == "REJECTED"


# ------------------------------------------------------------------- MEXC

def test_signatures():
    assert mexc.sign_spot("s", {"a": 1, "timestamp": "1"}) == hmac.new(b"s", b"a=1&timestamp=1", hashlib.sha256).hexdigest()
    assert mexc.sign_futures("s", "k", "123", "x=1") == hmac.new(b"s", b"k123x=1", hashlib.sha256).hexdigest()


def test_mexc_unconfigured(db):
    res = mexc.sync_account(db)
    assert all(v["status"] == "unconfigured" for v in res.values())
    st = mexc.status(db)
    assert st["configured"] is False and st["live_trading_enabled"] is False and st["verified_against_live_api"] is False


def test_mexc_sync_with_mock_never_leaks_secret(db, monkeypatch, caplog):
    from app.config import get_settings

    secret = "S" * 40
    s = get_settings()
    monkeypatch.setattr(s, "mexc_api_key", type(s.mexc_api_key)("K" * 30))
    monkeypatch.setattr(s, "mexc_api_secret", type(s.mexc_api_secret)(secret))
    seen = []

    def h(req: httpx.Request):
        seen.append(req)
        if req.url.path == "/api/v3/account":
            assert req.headers["X-MEXC-APIKEY"] == "K" * 30 and "signature" in req.url.params
            return httpx.Response(200, json={"balances": [{"asset": "USDT", "free": "100", "locked": "0"}, {"asset": "X", "free": "0", "locked": "0"}],
                                             "canTrade": False, "canWithdraw": False, "permissions": ["SPOT"]})
        if req.url.path.endswith("/assets"):
            assert req.headers["ApiKey"] and req.headers["Signature"] and req.headers["Request-Time"]
            return httpx.Response(200, json={"success": True, "data": [{"currency": "USDT", "equity": 50}]})
        return httpx.Response(401, json={"success": False, "message": f"bad key {secret}"})

    client = mexc.MexcReadOnlyClient(transport=httpx.MockTransport(h))
    res = mexc.sync_account(db, client)
    assert res["spot_account"]["status"] == "ok" and res["futures_assets"]["status"] == "ok"
    assert res["futures_positions"]["status"] == "error"
    db.flush()
    rows = db.scalars(select(ExchangeSnapshot)).all()
    dump = str([(r.payload, r.error) for r in rows]) + caplog.text + str(res)
    assert secret not in dump
    spot = next(r for r in rows if r.kind == "spot_account")
    assert spot.payload["balances"] == [{"asset": "USDT", "free": "100", "locked": "0"}]
    assert all(req.method == "GET" for req in seen)  # read-only


def test_contract_spec_parsing():
    full = {"data": {"contractSize": "0.0001", "volUnit": "1", "minVol": "1", "priceUnit": "0.1", "maxLeverage": "125",
                     "takerFeeRate": "0.0002", "maintenanceMarginRate": "0.004"}}
    spec = mexc.parse_contract_spec("BTC_USDT", full)
    assert spec and spec.contract_multiplier == D("0.0001")
    broken = {"data": {k: v for k, v in full["data"].items() if k != "contractSize"}}
    assert mexc.parse_contract_spec("BTC_USDT", broken) is None  # -> risk engine rejects UNKNOWN_CONTRACT
