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
    assert r["status"] == "ready" and r["migration"] == "0001"


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
