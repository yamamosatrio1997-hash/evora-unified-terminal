from __future__ import annotations

import json
import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app.core.audit import audit, verify_chain
from app.db.models import AuditLog, RiskDecision, User
from app.main import create_app
from app.security.passwords import hash_password

SERVICE = {"Authorization": f"Bearer {os.environ['SERVICE_TOKEN']}"}
CSRF = {"X-Requested-With": "tcc"}


@pytest.fixture()
def client(db):
    for name, role in (("admin", "admin"), ("op", "operator"), ("viewer", "viewer")):
        db.add(User(username=name, password_hash=hash_password("correct-horse-battery"), role=role))
    db.commit()
    with TestClient(create_app()) as c:
        yield c


def login(c, name):
    r = c.post("/api/auth/login", json={"username": name, "password": "correct-horse-battery"})
    assert r.status_code == 200, r.text
    return c


def test_health_endpoints(client):
    assert client.get("/api/health").json()["status"] == "ok"
    r = client.get("/api/health/ready").json()
    assert r["status"] == "ready" and r["migration"] == "0002"


def test_security_headers(client):
    r = client.get("/api/health")
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "default-src 'none'" in r.headers["content-security-policy"]


def test_auth_required_and_login(client):
    assert client.get("/api/overview").status_code == 401
    assert client.post("/api/auth/login", json={"username": "admin", "password": "wrong"}).status_code == 401
    login(client, "viewer")
    assert client.get("/api/overview").status_code == 200
    cookie = client.cookies.get("tcc_session")
    assert cookie
    client.post("/api/auth/logout", headers=CSRF)
    # the server-side session was destroyed: replaying the old cookie fails
    client.cookies.set("tcc_session", cookie)
    assert client.get("/api/overview").status_code == 401


def test_csrf_header_required_for_mutations(client):
    login(client, "op")
    r = client.post("/api/risk/emergency-stop", json={"active": True, "reason": "test stop"})
    assert r.status_code == 403
    r = client.post("/api/risk/emergency-stop", json={"active": True, "reason": "test stop"}, headers=CSRF)
    assert r.status_code == 200


def test_rbac(client):
    login(client, "viewer")
    assert client.post("/api/risk/emergency-stop", json={"active": True, "reason": "x stop"}, headers=CSRF).status_code == 403
    assert client.get("/api/audit").status_code == 403
    login(client, "op")
    client.post("/api/risk/emergency-stop", json={"active": True, "reason": "engage"}, headers=CSRF)
    # operators can engage but not release
    assert client.post("/api/risk/emergency-stop", json={"active": False, "reason": "release"}, headers=CSRF).status_code == 403
    login(client, "admin")
    assert client.post("/api/risk/emergency-stop", json={"active": False, "reason": "release"}, headers=CSRF).status_code == 200
    assert client.get("/api/audit/verify").json()["ok"] is True


def test_service_token(client):
    assert client.post("/api/service/n8n/callback", json={}).status_code in (401, 422)
    bad = client.post("/api/service/n8n/callback", headers={"Authorization": "Bearer nope"},
                      json={"workflow_id": "w", "execution_id": "1", "status": "success"})
    assert bad.status_code == 401
    ok = client.post("/api/service/n8n/callback", headers=SERVICE,
                     json={"workflow_id": "w1", "workflow_name": "Ingest", "execution_id": "1", "status": "success",
                           "started_at": "2026-01-01T00:00:00Z", "finished_at": "2026-01-01T00:00:02Z"})
    assert ok.status_code == 200
    # duplicate callback for the same execution updates, not duplicates
    client.post("/api/service/n8n/callback", headers=SERVICE,
                json={"workflow_id": "w1", "execution_id": "1", "status": "error", "error": "boom"})
    login(client, "viewer")
    st = client.get("/api/n8n/status").json()
    assert len(st["recent"]) == 1 and st["recent"][0]["status"] == "error"
    assert st["remote"]["status"] == "not_configured"


def test_secrets_never_returned(client):
    login(client, "admin")
    body = json.dumps(client.get("/api/settings").json()) + json.dumps(client.get("/api/telegram/status").json())
    for secret in (os.environ["SERVICE_TOKEN"], os.environ["TELEGRAM_BOT_TOKEN"], os.environ["TELEGRAM_WEBHOOK_SECRET"]):
        assert secret not in body
    assert client.get("/api/settings").json()["secrets_configured"]["telegram_bot_token"] is True


def test_live_trading_flag_refused():
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError):
        Settings(live_trading_enabled=True)
    with pytest.raises(ValidationError):
        Settings(max_planned_risk_per_trade="0.04")


def test_production_requires_secrets():
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError):
        Settings(app_env="production", session_secret="short", service_token="short")


def test_audit_chain_and_immutability(db):
    audit(db, "t", "a1", details={"api_key": "should-be-redacted", "x": 1})
    audit(db, "t", "a2")
    db.commit()
    assert verify_chain(db) == (True, None)
    row = db.scalar(select(AuditLog).order_by(AuditLog.id).limit(1))
    assert row.details["api_key"] == "[REDACTED]"
    with pytest.raises(DBAPIError, match="append-only"):
        db.execute(text("UPDATE audit_logs SET action='tampered'"))
        db.flush()
    db.rollback()
    with pytest.raises(DBAPIError, match="append-only"):
        db.execute(text("DELETE FROM audit_logs"))
        db.flush()
    db.rollback()


def test_risk_decisions_immutable(db):
    db.add(RiskDecision(symbol="BTCUSDT", approved=False, reasons=[], inputs={}, result={}, engine_version="t", hash="h"))
    db.commit()
    with pytest.raises(DBAPIError, match="append-only"):
        db.execute(text("UPDATE risk_decisions SET approved=true"))
        db.flush()
    db.rollback()


def test_risk_evaluate_endpoint_rejects_without_data(client):
    login(client, "op")
    r = client.post("/api/risk/evaluate", headers=CSRF, json={"symbol": "BTCUSDT", "side": "long", "entry_price": "60000", "stop_loss": "59000"})
    assert r.status_code == 200
    assert r.json()["approved"] is False
    assert any("MISSING_DATA_TIMESTAMP" in x for x in r.json()["reasons"])


def test_settings_cannot_disable_risk(client):
    login(client, "admin")
    r = client.put("/api/settings/agents", headers=CSRF, json={"enabled": {"risk": False}})
    assert r.status_code == 400


def test_overview_with_no_data_is_honest(client):
    login(client, "viewer")
    o = client.get("/api/overview").json()
    assert all(m["price"] is None for m in o["markets"])
    assert o["paper"]["trades"] == 0
    assert all(a["state"] == "idle" for a in o["agents"])
    c = client.get("/api/market/candles?symbol=BTCUSDT&interval=4h").json()
    assert c["status"] == "unavailable" and c["rows"] == []


# ---------------------------------------------------------------- registration

@pytest.fixture()
def fresh_signup_limit(monkeypatch):
    import app.api.routes as r

    monkeypatch.setattr(r, "_signup_limiter", None)


def reg(c, **kw):
    body = {"username": "newtrader", "email": "New@Example.com", "password": "long-enough-pass-123", "accept_terms": True} | kw
    return c.post("/api/auth/register", json=body)


def test_register_creates_viewer_and_logs_in(client, fresh_signup_limit):
    r = reg(client)
    assert r.status_code == 201 and r.json() == {"username": "newtrader", "role": "viewer"}
    assert client.get("/api/auth/me").json()["role"] == "viewer"
    # viewers cannot mutate
    assert client.post("/api/risk/emergency-stop", json={"active": True, "reason": "x stop"}, headers=CSRF).status_code == 403
    client.cookies.clear()
    assert client.post("/api/auth/login", json={"username": "newtrader", "password": "long-enough-pass-123"}).status_code == 200


def test_register_validation(client, fresh_signup_limit):
    assert reg(client, accept_terms=False).status_code == 400
    assert reg(client, password="short").status_code == 422
    assert reg(client, username="a b").status_code == 422
    assert reg(client, email="not-an-email").status_code == 422
    assert reg(client, password="newtrader", username="newtrader").status_code in (400, 422)
    assert reg(client).status_code == 201
    dup_user = reg(client, email="other@example.com")
    dup_mail = reg(client, username="someoneelse", email="new@example.com")
    assert dup_user.status_code == dup_mail.status_code == 409
    assert dup_user.json() == dup_mail.json()  # no account enumeration


def test_register_rate_limited(client, monkeypatch):
    import app.api.routes as r
    from app.security.ratelimit import RateLimiter

    monkeypatch.setattr(r, "_signup_limiter", RateLimiter(2, 3600))
    codes = [reg(client, username=f"user{i}", email=f"u{i}@example.com").status_code for i in range(3)]
    assert codes == [201, 201, 429]


def test_register_can_be_disabled(client, monkeypatch, fresh_signup_limit):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "allow_signup", False)
    assert reg(client).status_code == 403


# ---------------------------------------------------------------- redaction

def test_strategy_internals_hidden_from_non_admin(client, db):
    from app.cli import seed_simulated
    from app.quant.service import run_backtest_job

    seed_simulated(["BTCUSDT"], days=160)
    run = run_backtest_job(db, "ema_trend", "BTCUSDT", "4h", mc_runs=100)
    db.commit()
    login(client, "viewer")
    assert all("grid" not in s and "defaults" not in s for s in client.get("/api/quant/strategies").json())
    d = client.get(f"/api/quant/backtests/{run.id}").json()
    assert d["results"]["split"]["selected_params"] == "hidden"
    assert all(f["params"] == "hidden" for f in d["results"]["walk_forward"]["folds"])
    assert "assumptions" not in d
    st = client.get("/api/settings").json()
    assert "prompt_versions" not in st and "secrets_configured" not in st and "llm" not in st
    login(client, "admin")
    assert client.get(f"/api/quant/backtests/{run.id}").json()["results"]["split"]["selected_params"] != "hidden"
    assert "prompt_versions" in client.get("/api/settings").json()


def test_telegram_ids_masked(client, db):
    from app.db.models import TelegramRequest

    db.add(TelegramRequest(user_id=123456789, chat_id=1, authorized=True, status="answered"))
    db.commit()
    login(client, "admin")
    rows = client.get("/api/telegram/status").json()["requests"]
    assert rows[0]["user_id"] == "•••789"
    assert "123456789" not in json.dumps(rows)
