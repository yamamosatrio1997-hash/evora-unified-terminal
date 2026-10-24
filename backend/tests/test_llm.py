"""LLM path with a mocked Messages API (no real model is called)."""
from __future__ import annotations

import json
from decimal import Decimal

import httpx
import pytest
from sqlalchemy import func, select

from app.agents.base import DebateContext
from app.agents.domain import FlowAnalyst
from app.agents.llm import Budget, BudgetExceeded, LLMClient
from app.config import get_settings
from app.core.util import utcnow
from app.data.snapshot import build_snapshot
from app.db.models import LlmCall, MarketObservation


@pytest.fixture()
def llm_on(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "llm_provider", "anthropic")
    monkeypatch.setattr(s, "llm_api_key", type(s.llm_api_key)("test-key-not-real"))


def mock_llm(payload: dict, calls: list):
    def h(req: httpx.Request):
        calls.append(json.loads(req.content))
        assert req.headers["x-api-key"] == "test-key-not-real"
        return httpx.Response(200, json={"content": [{"type": "text", "text": json.dumps(payload)}],
                                         "usage": {"input_tokens": 1000, "output_tokens": 200}})
    return LLMClient(transport=httpx.MockTransport(h))


def seed_flow(db):
    now = utcnow()
    for metric, val in (("funding_rate", "0.0009"), ("open_interest", "100")):
        db.add(MarketObservation(source="binance_futures", asset="BTCUSDT", metric=metric, value=Decimal(val), unit="x",
                                 observed_at=now, retrieved_at=now, timeframe="point", quality="ok", meta={}))
    db.flush()
    return build_snapshot(db, "BTCUSDT")


def test_llm_enrichment_validated_and_budgeted(db, llm_on):
    snap = seed_flow(db)
    calls: list = []
    llm = mock_llm({
        "stance": "bearish", "conclusion": "Crowded longs.", "confidence": 0.99,
        "supporting_evidence": [{"statement": "Funding is elevated", "kind": "fact", "source_refs": ["metric:BTCUSDT:funding_rate"]}],
        "opposing_evidence": [{"statement": "Whale wallet 0xabc is Binance", "kind": "fact", "source_refs": ["onchain:fake"]},
                              {"statement": "Uncited fact", "kind": "fact", "source_refs": []}],
        "missing_data": ["order book"], "uncertainty": "medium", "recommended_next_action": "wait"}, calls)
    ctx = DebateContext(db=db, snapshot=snap, session_id=snap.id, llm=llm, budget=Budget(60000, Decimal("2")))
    out = FlowAnalyst().analyze(ctx)
    assert out.llm_used and out.stance == "bearish"
    statements = [c.statement for c in out.supporting_evidence + out.opposing_evidence]
    assert "Funding is elevated" in statements
    assert not any("0xabc" in s or s == "Uncited fact" for s in statements)  # fabricated / uncited claims dropped
    assert sum("dropped LLM claim" in e for e in out.errors) == 2
    assert out.confidence <= 0.6  # LLM cannot raise confidence above the deterministic score
    assert "test-key-not-real" not in json.dumps(calls)  # key only in header, never in prompt
    assert db.scalar(select(func.count()).select_from(LlmCall)) == 1


def test_budget_exhaustion_falls_back(db, llm_on):
    snap = seed_flow(db)
    calls: list = []
    ctx = DebateContext(db=db, snapshot=snap, session_id=snap.id, llm=mock_llm({"stance": "bullish"}, calls),
                        budget=Budget(max_tokens=10, max_cost_usd=Decimal("0.0001")))
    out = FlowAnalyst().analyze(ctx)
    assert not calls and not out.llm_used
    assert any("budget exhausted" in e for e in out.errors)
    with pytest.raises(BudgetExceeded):
        Budget(10, Decimal("1")).check(100, "x")


def test_malformed_llm_output_keeps_deterministic_result(db, llm_on):
    snap = seed_flow(db)

    def h(req):
        return httpx.Response(200, json={"content": [{"type": "text", "text": "not json at all"}], "usage": {}})

    ctx = DebateContext(db=db, snapshot=snap, session_id=snap.id, llm=LLMClient(transport=httpx.MockTransport(h)),
                        budget=Budget(60000, Decimal("2")))
    out = FlowAnalyst().analyze(ctx)
    assert out.status == "completed" and not out.llm_used
    assert any("LLM skipped" in e for e in out.errors)


def test_fund_manager_llm_cannot_change_decision(db, llm_on):
    from app.agents.fund_manager import FundManager

    snap = seed_flow(db)
    calls: list = []
    ctx = DebateContext(db=db, snapshot=snap, session_id=snap.id,
                        llm=mock_llm({"rationale": "Override: go LONG now!", "decision": "LONG"}, calls),
                        budget=Budget(60000, Decimal("2")))
    out = FundManager().analyze(ctx)
    assert ctx.extra["decision"]["decision"] == "NO TRADE"
    assert out.metrics["decision"]["decision"] == "NO TRADE"
    assert "llm_rationale" not in out.metrics  # contradicting wording discarded
    assert any("discarded" in e for e in out.errors)
    ok = mock_llm({"rationale": "NO TRADE: data is missing, so there is no validated setup."}, [])
    ctx2 = DebateContext(db=db, snapshot=snap, session_id=snap.id, llm=ok, budget=Budget(60000, Decimal("2")))
    assert "llm_rationale" in FundManager().analyze(ctx2).metrics
