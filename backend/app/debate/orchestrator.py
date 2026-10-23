"""Eight-round auditable debate.

Controls against runaway behaviour:
  * fixed round sequence with a hard cap (no open-ended loops);
  * one challenge/reply exchange per challenge, bounded by MAX_CHALLENGES;
  * token and cost budgets per session; exhausted budgets fall back to
    deterministic analysis instead of more calls;
  * idempotency key (unique) + a per-symbol job lock against duplicate runs.
"""
from __future__ import annotations

import logging
import traceback
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.agents.base import DebateContext, load_prompt
from app.agents.critic import CriticalReviewer
from app.agents.domain import FlowAnalyst, FundamentalAnalyst, MacroAnalyst, OnChainAnalyst
from app.agents.fund_manager import FundManager
from app.agents.llm import Budget, BudgetExceeded, LLMClient, LLMUnavailable
from app.agents.quant_agent import QuantResearcher
from app.agents.risk_agent import RiskManager
from app.agents.schemas import AGENT_NAMES, AgentOutput, validate_refs_against_snapshot
from app.agents.technical import TechnicalAnalyst
from app.config import get_settings
from app.core.audit import audit
from app.core.events import emit
from app.core.locks import LockHeld, job_lock
from app.core.util import jsonable, utcnow
from app.data.snapshot import build_snapshot
from app.db.models import AgentAnalysis, AppSetting, DataSnapshot, DebateMessage, DebateSession, Decision
from app.db.session import session_scope

log = logging.getLogger(__name__)

ROUND_NAMES = {
    1: "independent_research", 2: "evidence_exchange", 3: "challenge", 4: "synthesis",
    5: "quant_validation", 6: "risk_review", 7: "decision", 8: "audit",
}
TOTAL_ROUNDS = 8
MAX_CHALLENGES = 12
RESEARCH_AGENTS = (MacroAnalyst, FundamentalAnalyst, OnChainAnalyst, FlowAnalyst, TechnicalAnalyst)


class DuplicateDebate(Exception):
    def __init__(self, session_id: uuid.UUID) -> None:
        super().__init__(str(session_id))
        self.session_id = session_id


def _msg(db: Session, s: DebateSession, rnd: int, frm: str, kind: str, content: str, to: str | None = None,
         refs: list[Any] | None = None, reply_to: int | None = None) -> DebateMessage:
    m = DebateMessage(session_id=s.id, round=rnd, from_agent=frm, to_agent=to, kind=kind, content=content[:4000],
                      references=jsonable(refs or []), reply_to=reply_to)
    db.add(m)
    db.flush()
    emit(db, "debate.message", agent=frm, session_id=s.id, round=rnd, kind=kind, to=to, message_id=m.id)
    return m


def _run_agent(ctx: DebateContext, s: DebateSession, agent, rnd: int) -> AgentOutput:
    db = ctx.db
    emit(db, "agent.state", agent=agent.role, session_id=s.id, state=_state_for(agent.role, rnd), round=rnd)
    tin0, tout0 = ctx.budget.tokens_in, ctx.budget.tokens_out
    try:
        out = agent.analyze(ctx)
        problems = validate_refs_against_snapshot(out, ctx.content)
        if problems:
            out.errors.extend(problems)
            out.status = "error"
    except Exception as e:  # noqa: BLE001 - an agent failure must not crash the debate
        log.exception("agent failed", extra={"ctx": {"agent": agent.role}})
        out = AgentOutput(role=agent.role, timestamp=utcnow(), snapshot_id=ctx.snapshot.id, snapshot_hash=ctx.snapshot.content_hash,
                          status="error", stance="no_view", conclusion=f"Agent error: {type(e).__name__}",
                          uncertainty="Agent failed; its domain is unassessed.", recommended_next_action="Investigate error",
                          prompt_version=agent.prompt_version, errors=[traceback.format_exc(limit=3)[-800:]])
    ctx.outputs[agent.role] = out
    db.add(AgentAnalysis(session_id=s.id, agent_role=agent.role, round=rnd, status=out.status, output=out.model_dump(mode="json"),
                         model=out.model, prompt_version=out.prompt_version,
                         tokens_in=ctx.budget.tokens_in - tin0, tokens_out=ctx.budget.tokens_out - tout0,
                         error="; ".join(out.errors)[:2000] or None))
    db.flush()
    final_state = {"veto": "veto", "error": "error", "insufficient_data": "warning"}.get(out.status, "completed")
    emit(db, "agent.state", agent=agent.role, session_id=s.id, state=final_state, round=rnd, stance=out.stance)
    return out


def _disabled_output(agent, snap: DataSnapshot) -> AgentOutput:
    return AgentOutput(role=agent.role, timestamp=utcnow(), snapshot_id=snap.id, snapshot_hash=snap.content_hash,
                       status="insufficient_data", stance="no_view", conclusion="Agent disabled by an administrator for this run.",
                       uncertainty="Domain not assessed (agent disabled).", recommended_next_action="Re-enable in Settings if needed",
                       prompt_version=agent.prompt_version, missing_data=[f"{agent.role} analysis (agent disabled)"])


def _state_for(role: str, rnd: int) -> str:
    return {1: "analyzing", 3: "challenging", 5: "quant_review", 6: "risk_review", 7: "analyzing"}.get(rnd, "analyzing")


def _reply(ctx: DebateContext, s: DebateSession, role: str, challenge_text: str) -> tuple[str, bool]:
    """Specific reply to a specific challenge. LLM when available, otherwise a
    deterministic, evidence-based response."""
    out = ctx.outputs.get(role)
    if out is None:
        return "No analysis on record from this agent; challenge stands.", False
    if ctx.llm.enabled:
        _, persona = load_prompt("reply")
        try:
            raw = ctx.llm.complete_json(ctx.db, agent=role, prompt_version=load_prompt("reply")[0], system=persona,
                                        user=f"YOUR ANALYSIS: {out.model_dump_json()[:6000]}\nCHALLENGE: {challenge_text}",
                                        budget=ctx.budget, session_id=s.id)
            if isinstance(raw.get("reply"), str):
                return raw["reply"][:500], bool(raw.get("conclusion_changed"))
        except (BudgetExceeded, LLMUnavailable):
            pass
    if out.status == "insufficient_data":
        return f"Accepted. {AGENT_NAMES[role]} has no view because: {'; '.join(out.missing_data[:3])}.", False
    opp = [c.statement for c in out.opposing_evidence][:2]
    if opp:
        return (f"Partially accepted. My analysis already records opposing evidence: {' | '.join(opp)}. "
                f"Conclusion stands as '{out.stance}' with stated uncertainty: {out.uncertainty[:160]}"), False
    return f"Noted. Conclusion '{out.stance}' rests on: {' | '.join(c.statement for c in out.supporting_evidence[:2]) or 'limited evidence'}.", False


def run_debate(symbol: str, trigger: str, idempotency_key: str, *, llm: LLMClient | None = None,
               extra: dict[str, Any] | None = None) -> uuid.UUID:
    s_cfg = get_settings()
    if s_cfg.debate_max_rounds < TOTAL_ROUNDS:
        raise ValueError(f"DEBATE_MAX_ROUNDS must be >= {TOTAL_ROUNDS} for the full decision pipeline")
    # Fast idempotency check before taking locks.
    with session_scope() as db:
        existing = db.scalar(select(DebateSession.id).where(DebateSession.idempotency_key == idempotency_key))
        if existing:
            raise DuplicateDebate(existing)
    owner = f"debate:{uuid.uuid4()}"
    try:
        with job_lock(f"debate:{symbol}", owner, ttl_seconds=900):
            return _run_locked(symbol, trigger, idempotency_key, llm or LLMClient(), extra or {})
    except LockHeld as e:
        raise RuntimeError(f"a debate for {symbol} is already running") from e


def _run_locked(symbol: str, trigger: str, key: str, llm: LLMClient, extra: dict[str, Any]) -> uuid.UUID:
    settings = get_settings()
    with session_scope() as db:
        snap = build_snapshot(db, symbol)
        s = DebateSession(symbol=symbol, snapshot_id=snap.id, status="running", trigger=trigger, idempotency_key=key,
                          max_rounds=TOTAL_ROUNDS, config=jsonable({"llm_enabled": llm.enabled, "model": llm.model if llm.enabled else None,
                                                                    "token_budget": settings.debate_token_budget,
                                                                    "cost_budget_usd": settings.debate_cost_budget_usd}))
        db.add(s)
        try:
            db.flush()
        except IntegrityError as e:
            raise DuplicateDebate(uuid.UUID(int=0)) from e
        session_id = s.id
        emit(db, "debate.started", session_id=s.id, symbol=symbol, snapshot_id=str(snap.id), simulated=snap.is_simulated)
    budget = Budget(max_tokens=settings.debate_token_budget, max_cost_usd=Decimal(settings.debate_cost_budget_usd))
    try:
        # Each round commits so the dashboard sees progress as it happens.
        with session_scope() as db:
            s = db.get(DebateSession, session_id)
            snap = db.get(DataSnapshot, s.snapshot_id)
            ctx = DebateContext(db=db, snapshot=snap, session_id=session_id, llm=llm, budget=budget, extra=extra)
            _round(db, s, 1)
            setting = db.get(AppSetting, "agents")
            enabled = (setting.value.get("enabled") if setting else None) or {}
            for cls in RESEARCH_AGENTS:  # each sees only the snapshot, not peers
                agent = cls()
                if enabled.get(agent.role) is False:
                    out = _disabled_output(agent, snap)
                    ctx.outputs[out.role] = out
                    db.add(AgentAnalysis(session_id=s.id, agent_role=agent.role, round=1, status=out.status,
                                         output=out.model_dump(mode="json"), prompt_version=out.prompt_version))
                    _msg(db, s, 1, out.role, "hypothesis", f"[{out.stance}] {out.conclusion}")
                    continue
                isolated = DebateContext(db=db, snapshot=snap, session_id=session_id, llm=llm, budget=budget, extra=extra)
                out = _run_agent(isolated, s, agent, 1)
                ctx.outputs[out.role] = out
                _msg(db, s, 1, out.role, "hypothesis", f"[{out.stance}] {out.conclusion}", refs=[r.id for r in out.source_references])
            _done(db, s, 1)
        with session_scope() as db:
            s = db.get(DebateSession, session_id)
            ctx.db = db
            _round(db, s, 2)
            for role, out in list(ctx.outputs.items()):
                ev = "; ".join(c.statement for c in out.supporting_evidence[:3]) or "no supporting evidence"
                assumptions = "; ".join(out.assumptions[:2])
                _msg(db, s, 2, role, "evidence", f"Evidence: {ev}. Assumptions: {assumptions or 'none stated'}. Missing: {', '.join(out.missing_data[:3]) or 'none'}.",
                     refs=[{"id": r.id, "source": r.source, "observed_at": r.observed_at} for r in out.source_references])
            _done(db, s, 2)
        with session_scope() as db:
            s = db.get(DebateSession, session_id)
            ctx.db = db
            _round(db, s, 3)
            critic = CriticalReviewer()
            crit_out = _run_agent(ctx, s, critic, 3)
            for ch in (crit_out.metrics.get("challenges") or [])[:MAX_CHALLENGES]:
                m = _msg(db, s, 3, "critic", "challenge", ("BLOCKING: " if ch["blocking"] else "") + ch["issue"], to=ch["to"], refs=ch["refs"])
                if ch["to"] in ctx.outputs and ch["to"] not in ("critic", "fund_manager"):
                    emit(db, "agent.state", agent=ch["to"], session_id=s.id, state="exchanging", round=3)
                    text, changed = _reply(ctx, s, ch["to"], ch["issue"])
                    _msg(db, s, 3, ch["to"], "reply", text + (" [conclusion revised]" if changed else ""), to="critic", reply_to=m.id)
                    # Return the agent to its settled state so the UI never shows phantom activity.
                    settled = {"veto": "veto", "error": "error", "insufficient_data": "warning"}.get(ctx.outputs[ch["to"]].status, "completed")
                    emit(db, "agent.state", agent=ch["to"], session_id=s.id, state=settled, round=3)
            _done(db, s, 3)
        with session_scope() as db:
            s = db.get(DebateSession, session_id)
            ctx.db = db
            _round(db, s, 4)
            stances = {r: o.stance for r, o in ctx.outputs.items() if r != "critic"}
            bulls = [r for r, v in stances.items() if v == "bullish"]
            bears = [r for r, v in stances.items() if v == "bearish"]
            none = [r for r, v in stances.items() if v in ("no_view", "neutral")]
            _msg(db, s, 4, "fund_manager", "synthesis",
                 f"Cross-domain map. Bullish: {bulls or '-'}. Bearish: {bears or '-'}. Neutral/no view: {none or '-'}. "
                 f"{'Unresolved conflict recorded.' if bulls and bears else 'No directional conflict.'}",
                 refs=[{"stances": stances}])
            _done(db, s, 4)
        with session_scope() as db:
            s = db.get(DebateSession, session_id)
            ctx.db = db
            _round(db, s, 5)
            q = _run_agent(ctx, s, QuantResearcher(), 5)
            _msg(db, s, 5, "quant", "quant_validation", q.conclusion, refs=[r.id for r in q.source_references])
            _done(db, s, 5)
        with session_scope() as db:
            s = db.get(DebateSession, session_id)
            ctx.db = db
            _round(db, s, 6)
            r = _run_agent(ctx, s, RiskManager(), 6)
            _msg(db, s, 6, "risk", "veto" if r.status == "veto" else "risk_review", r.conclusion, refs=[x.id for x in r.source_references])
            _done(db, s, 6)
        with session_scope() as db:
            s = db.get(DebateSession, session_id)
            ctx.db = db
            _round(db, s, 7)
            fm = _run_agent(ctx, s, FundManager(), 7)
            d = ctx.extra["decision"]
            _msg(db, s, 7, "fund_manager", "decision", f"DECISION: {d['decision']}. {fm.conclusion}", refs=[d.get("risk_decision_id")])
            _done(db, s, 7)
        with session_scope() as db:
            s = db.get(DebateSession, session_id)
            _round(db, s, 8)
            db.add(Decision(session_id=s.id, symbol=symbol, decision=d["decision"], details=jsonable(d),
                            risk_decision_id=d.get("risk_decision_id") if d["decision"] in ("LONG", "SHORT", "REJECT") else None))
            s.status, s.finished_at, s.final_decision = "completed", utcnow(), d["decision"]
            s.tokens_used, s.cost_usd = budget.tokens_used, budget.cost_usd
            if budget.skipped:
                s.error = f"LLM budget exhausted; deterministic fallback for: {budget.skipped}"
            audit(db, "system:debate", "debate.completed", str(s.id),
                  {"symbol": symbol, "decision": d["decision"], "snapshot_hash": snap.content_hash,
                   "prompt_versions": {r: o.prompt_version for r, o in ctx.outputs.items()},
                   "llm_model": llm.model if llm.enabled else None, "tokens": budget.tokens_used, "cost_usd": str(budget.cost_usd)})
            _done(db, s, 8)
            emit(db, "debate.finished", session_id=s.id, symbol=symbol, decision=d["decision"])
        return session_id
    except Exception as e:
        with session_scope() as db:
            s = db.get(DebateSession, session_id)
            s.status, s.finished_at, s.error, s.final_decision = "failed", utcnow(), f"{type(e).__name__}: {e}"[:2000], "NO TRADE"
            audit(db, "system:debate", "debate.failed", str(session_id), {"error": str(e)[:500]})
            emit(db, "debate.failed", session_id=session_id, error=str(e)[:300])
        raise


def _round(db: Session, s: DebateSession, n: int) -> None:
    emit(db, "debate.round_started", session_id=s.id, round=n, name=ROUND_NAMES[n])


def _done(db: Session, s: DebateSession, n: int) -> None:
    s.rounds_completed = n
    emit(db, "debate.round_finished", session_id=s.id, round=n, name=ROUND_NAMES[n])
