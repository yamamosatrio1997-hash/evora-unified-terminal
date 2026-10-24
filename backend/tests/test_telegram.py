from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db.models import AuditLog, TelegramContext, TelegramRequest
from app.telegram.client import split_message
from app.telegram.intents import route
from app.telegram.service import handle_update


@pytest.fixture(autouse=True)
def _fresh_limiter(monkeypatch):
    import app.telegram.service as svc

    monkeypatch.setattr(svc, "_limiter", None)


class FakeSender:
    def __init__(self):
        self.sent: list[tuple[int, str]] = []

    def __call__(self, chat_id, text):
        self.sent.append((chat_id, text))


def upd(uid, text, update_id):
    return {"update_id": update_id, "message": {"message_id": 1, "from": {"id": uid}, "chat": {"id": uid}, "text": text}}


@pytest.mark.parametrize("text,intent,extra", [
    ("Fund Manager, buat laporan performa portfolio saya hari ini.", "report", {"period": "today"}),
    ("Bagaimana drawdown portfolio saya minggu ini?", "performance", {"period": "week"}),
    ("Analisis teknikal BTC timeframe 4 jam.", "technical", {"symbol": "BTCUSDT", "timeframe": "4h"}),
    ("Bagaimana kondisi on-chain Bitcoin?", "onchain", {}),
    ("Bandingkan pandangan Technical Analyst dan Quant Researcher.", "compare", {"agents": ("technical", "quant")}),
    ("Kenapa Risk Manager menolak trade terakhir?", "why_veto", {}),
    ("Berikan hasil backtest strategi saya.", "backtest", {}),
    ("Bagaimana status semua agen dan workflow n8n?", "agents_and_n8n", {}),
    ("Ringkas kondisi pasar kripto hari ini.", "market", {}),
    ("Bagaimana status koneksi MEXC saya?", "mexc", {}),
    ("Tolong beli BTC sekarang 1 lot", "refuse_order", {}),
    ("naikkan limit risiko jadi 10%", "refuse_settings", {}),
    ("/technical eth 1h", "technical", {"symbol": "ETHUSDT", "timeframe": "1h"}),
    ("/btc", "symbol", {"symbol": "BTCUSDT"}),
    ("/report", "report", {}),
])
def test_routing(text, intent, extra):
    it = route(text)
    assert it.name == intent
    for k, v in extra.items():
        assert getattr(it, k) == v


def test_clarification_and_followup():
    assert route("analisis teknikal dong").clarify
    it = route("bagaimana dengan ETH?", last_intent="technical", last_symbol="BTCUSDT")
    assert it.name == "technical" and it.symbol == "ETHUSDT"


def test_all_commands_answer_without_data(db):
    s = FakeSender()
    cmds = ["/start", "/help", "/status", "/market", "/btc", "/eth", "/portfolio", "/performance", "/risk", "/onchain",
            "/technical btc", "/quant", "/backtest", "/agents", "/debate", "/n8n", "/paper", "/mexc", "/report"]
    for i, c in enumerate(cmds):
        r = handle_update(db, upd(111, c, 1000 + i), s)
        assert r["status"] == "answered", (c, r)
    texts = "\n".join(t for _, t in s.sent)
    # no fabricated numbers when nothing exists
    assert "Belum ada" in texts
    assert "Mode: RISET/PAPER" in texts


def test_unauthorized_blocked_before_data(db, monkeypatch):
    import app.telegram.handlers as h

    def boom(*a, **k):
        raise AssertionError("handler must not run for unauthorized users")

    monkeypatch.setitem(h.HANDLERS, "report", boom)
    s = FakeSender()
    r = handle_update(db, upd(999, "/report", 1), s)
    assert r["status"] == "unauthorized"
    assert s.sent == [(999, "Akses ditolak. Akun ini tidak terdaftar.")]
    assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "telegram.unauthorized")) == 1


def test_retry_dedup(db):
    s = FakeSender()
    assert handle_update(db, upd(111, "/status", 42), s)["status"] == "answered"
    assert handle_update(db, upd(111, "/status", 42), s)["status"] == "duplicate"
    assert len(s.sent) == 1
    assert db.scalar(select(func.count()).select_from(TelegramRequest)) == 1


def test_context_isolated_per_user(db):
    s = FakeSender()
    assert handle_update(db, upd(111, "/technical eth 1h", 1), s)["status"] == "answered"
    assert handle_update(db, upd(222, "/technical btc 4h", 2), s)["status"] == "answered"
    db.flush()
    assert db.get(TelegramContext, 111).last_symbol == "ETHUSDT"
    assert db.get(TelegramContext, 222).last_symbol == "BTCUSDT"
    # user 222's follow-up uses its own context, not user 111's
    handle_update(db, upd(222, "analisis teknikal", 3), s)
    assert "BTCUSDT" in s.sent[-1][1]


def test_rate_limit(db, monkeypatch):
    from app.security.ratelimit import RateLimiter
    import app.telegram.service as svc

    monkeypatch.setattr(svc, "_limiter", RateLimiter(2, 60))
    s = FakeSender()
    st = [handle_update(db, upd(111, "/help", 500 + i), s)["status"] for i in range(3)]
    assert st == ["answered", "answered", "rate_limited"]


def test_secret_never_in_reply(db):
    s = FakeSender()
    handle_update(db, upd(111, "/status", 77), s)
    assert os.environ["TELEGRAM_BOT_TOKEN"] not in s.sent[-1][1]


def test_split_message():
    parts = split_message("line\n" * 2000, 4000)
    assert all(len(p) <= 4000 for p in parts) and "".join(parts).count("line") == 2000


def test_webhook_secret(db):
    from app.main import create_app

    with TestClient(create_app()) as c:
        assert c.post("/api/telegram/webhook", json=upd(111, "/help", 1)).status_code == 401
        assert c.post("/api/telegram/webhook", json=upd(111, "/help", 1), headers={"X-Telegram-Bot-Api-Secret-Token": "wrong"}).status_code == 401
