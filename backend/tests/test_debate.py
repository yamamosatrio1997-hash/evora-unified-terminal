from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app.agents.base import DebateContext
from app.agents.fund_manager import decide
from app.agents.llm import Budget, LLMClient
from app.agents.schemas import AgentOutput, TradeIdea
from app.cli import seed_simulated
from app.core.util import utcnow
from app.db.models import AgentAnalysis, AuditLog, DataSnapshot, DebateMessage, DebateSession, Decision, SystemEvent
from app.debate.orchestrator import DuplicateDebate, run_debate


def test_full_debate_on_simulated_data_is_no_trade(db):
    seed_simulated(["BTCUSDT"], days=300)
    db.commit()
    sid = run_debate("BTCUSDT", "test", "k-1")
    db.expire_all()
    s = db.get(DebateSession, sid)
    assert s.status == "completed" and s.rounds_completed == 8
    assert s.final_decision == "NO TRADE"  # simulated data can never produce a trade
    roles = set(db.scalars(select(AgentAnalysis.agent_role).where(AgentAnalysis.session_id == sid)))
    assert roles == {"macro", "fundamental", "onchain", "flow", "technical", "critic", "quant", "risk", "fund_manager"}
    kinds = set(db.scalars(select(DebateMessage.kind).where(DebateMessage.session_id == sid)))
    assert {"hypothesis", "evidence", "challenge", "reply", "synthesis", "quant_validation", "decision"} <= kinds
    # replies reference specific challenges
    replies = db.scalars(select(DebateMessage).where(DebateMessage.session_id == sid, DebateMessage.kind == "reply")).all()
    assert replies and all(r.reply_to is not None for r in replies)
    # a blocking simulated-data challenge was raised
    ch = db.scalars(select(DebateMessage.content).where(DebateMessage.session_id == sid, DebateMessage.kind == "challenge")).all()
    assert any("SIMULATED" in c for c in ch)
    assert db.scalar(select(Decision.decision).where(Decision.session_id == sid)) == "NO TRADE"
    assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "debate.completed")) == 1
    # real events were emitted for each round
    rounds = db.scalars(select(SystemEvent.payload).where(SystemEvent.session_id == sid, SystemEvent.type == "debate.round_finished")).all()
    assert [p["round"] for p in rounds] == list(range(1, 9))
    # all agents cited only data present in the shared snapshot
    for a in db.scalars(select(AgentAnalysis).where(AgentAnalysis.session_id == sid)):
        assert a.output["snapshot_id"] == str(s.snapshot_id)
        assert a.status != "error", a.error


def test_duplicate_debate_rejected(db):
    seed_simulated(["ETHUSDT"], days=120)
    db.commit()
    run_debate("ETHUSDT", "test", "dup-key")
    with pytest.raises(DuplicateDebate):
        run_debate("ETHUSDT", "test", "dup-key")
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(DebateSession)) == 1


def test_no_data_debate_completes_with_no_trade(db):
    sid = run_debate("BTCUSDT", "test", "empty")
    db.expire_all()
    s = db.get(DebateSession, sid)
    assert s.final_decision == "NO TRADE"
    tech = db.scalar(select(AgentAnalysis).where(AgentAnalysis.session_id == sid, AgentAnalysis.agent_role == "technical"))
    assert tech.status == "insufficient_data"


# --- decision gate unit tests (constructed agent outputs) -----------------------

def _snap(simulated=False, stale=None):
    return DataSnapshot(id=uuid.uuid4(), symbol="BTCUSDT", content={"metrics": {}, "candles": {}}, content_hash="h",
                        quality_summary={"stale": stale or [], "missing": []}, is_simulated=simulated)


def _out(role, stance="neutral", status="completed", **kw):
    return AgentOutput(role=role, timestamp=utcnow(), snapshot_id=uuid.uuid4(), snapshot_hash="h", status=status, stance=stance,
                       conclusion=f"{role} view", uncertainty="u", recommended_next_action="n", prompt_version="t", **kw)


IDEA = TradeIdea(side="long", timeframe="4h", entry=100, entry_trigger="t", stop_loss=95, take_profit=110, invalidation="i")


def _ctx(outputs, simulated=False, stale=None):
    c = DebateContext(db=None, snapshot=_snap(simulated, stale), session_id=uuid.uuid4(), llm=LLMClient(),
                      budget=Budget(1, 0), outputs=outputs)
    return c


def _all_pass():
    return {
        "technical": _out("technical", "bullish", trade_idea=IDEA),
        "quant": _out("quant", metrics={"backtest": {"edge_verdict": "supported"}}),
        "risk": _out("risk", metrics={"risk": {"approved": True, "verdict": "APPROVED"}, "risk_decision_id": 1}),
        "critic": _out("critic", metrics={"blocking": 0}),
        "macro": _out("macro", "bearish"),
    }


def test_gate_long_when_all_mandatory_validations_pass():
    d = decide(_ctx(_all_pass()))
    assert d["decision"] == "LONG"
    assert d["dissent"] and d["dissent"][0]["agent"] == "macro"  # dissent recorded, not ignored


def test_risk_veto_cannot_be_overridden():
    o = _all_pass()
    o["risk"] = _out("risk", status="veto", metrics={"risk": {"approved": False}})
    # even with every other agent bullish, the veto decides
    for r in ("macro", "fundamental", "onchain", "flow"):
        o[r] = _out(r, "bullish")
    assert decide(_ctx(o))["decision"] == "REJECT"


def test_simulated_or_stale_or_unvalidated_never_trades():
    assert decide(_ctx(_all_pass(), simulated=True))["decision"] == "NO TRADE"
    assert decide(_ctx(_all_pass(), stale=["candles:4h"]))["decision"] == "NO TRADE"
    o = _all_pass()
    o["quant"] = _out("quant", metrics={"backtest": {"edge_verdict": "insufficient"}})
    assert decide(_ctx(o))["decision"] == "WAIT FOR CONFIRMATION"
    o["quant"] = _out("quant", metrics={"backtest": {"edge_verdict": "not_supported"}})
    assert decide(_ctx(o))["decision"] == "NO TRADE"


def test_not_a_majority_vote():
    o = _all_pass()
    o["critic"] = _out("critic", metrics={"blocking": 1})
    for r in ("fundamental", "onchain", "flow"):
        o[r] = _out(r, "bullish")
    assert decide(_ctx(o))["decision"] == "WAIT FOR CONFIRMATION"
    o2 = _all_pass()
    o2["flow"] = _out("flow", "bearish")
    assert decide(_ctx(o2))["decision"] == "WAIT FOR CONFIRMATION"  # 2 contradicting context agents


def test_no_idea_is_no_trade_or_watchlist():
    assert decide(_ctx({"technical": _out("technical", "neutral")}))["decision"] == "NO TRADE"
    assert decide(_ctx({"technical": _out("technical", "bullish")}))["decision"] == "WATCHLIST"
    _ = timedelta
