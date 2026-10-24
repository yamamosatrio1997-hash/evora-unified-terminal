"""Fund Manager: deterministic decision gate. Not a vote.

Mandatory validations, in order. The first failing gate determines the outcome.
The optional LLM only phrases the rationale; it receives the decision as input
and its text cannot alter it.
"""
from __future__ import annotations

import json
import re
from typing import Any

from app.agents.base import Agent, DebateContext, load_prompt
from app.agents.llm import BudgetExceeded, LLMUnavailable
from app.agents.schemas import AgentOutput, Claim, SourceRef


def decide(ctx: DebateContext) -> dict[str, Any]:
    o = ctx.outputs
    tech, quant, risk, critic = o.get("technical"), o.get("quant"), o.get("risk"), o.get("critic")
    idea = tech.trade_idea if tech else None
    gates: list[dict[str, Any]] = []

    def gate(name: str, passed: bool, detail: str) -> bool:
        gates.append({"gate": name, "passed": passed, "detail": detail})
        return passed

    decision = None
    if not gate("real_data", not ctx.snapshot.is_simulated, "snapshot contains simulated data" if ctx.snapshot.is_simulated else "real data only"):
        decision = "NO TRADE"
    elif not gate("trade_idea", idea is not None, "technical setup defined" if idea else "no aligned setup"):
        decision = "WATCHLIST" if tech and tech.status == "completed" and tech.stance in ("bullish", "bearish") else "NO TRADE"
    elif not gate("risk_approval", bool(risk and risk.status != "veto" and risk.metrics.get("risk", {}).get("approved")),
                  risk.conclusion if risk else "risk review missing"):
        decision = "REJECT"
    else:
        stale = [s for s in ctx.snapshot.quality_summary.get("stale", []) if s.startswith("candles:")]
        blocking = (critic.metrics.get("blocking", 0) if critic else 1)
        verdict = (quant.metrics.get("backtest") or {}).get("edge_verdict") if quant else None
        if not gate("data_fresh", not stale, f"stale: {stale}" if stale else "fresh"):
            decision = "NO TRADE"
        elif not gate("quant_edge", verdict == "supported", f"edge verdict: {verdict}"):
            decision = "WAIT FOR CONFIRMATION" if verdict == "insufficient" else "NO TRADE"
        elif not gate("critic_blocking", blocking == 0, f"{blocking} blocking issue(s)"):
            decision = "WAIT FOR CONFIRMATION"
        else:
            contra = [r for r in ("macro", "fundamental", "onchain", "flow")
                      if o.get(r) and o[r].status == "completed"
                      and ((idea.side == "long" and o[r].stance == "bearish") or (idea.side == "short" and o[r].stance == "bullish"))]
            if not gate("context_conflict", len(contra) < 2, f"contradicting context agents: {contra}"):
                decision = "WAIT FOR CONFIRMATION"
            else:
                decision = "LONG" if idea.side == "long" else "SHORT"

    dissent = []
    if idea:
        for r, a in o.items():
            if a.stance in ("bullish", "bearish") and ((idea.side == "long") != (a.stance == "bullish")):
                dissent.append({"agent": r, "stance": a.stance, "conclusion": a.conclusion})
    risk_m = (risk.metrics.get("risk") if risk else None) or {}
    return {
        "decision": decision,
        "gates": gates,
        "trade": idea.model_dump() if idea and decision in ("LONG", "SHORT") else None,
        "entry_conditions": idea.entry_trigger if idea else None,
        "invalidation": idea.invalidation if idea else None,
        "risk_estimate": {k: risk_m.get(k) for k in ("verdict", "qty", "estimated_loss", "risk_fraction", "notional")} if risk_m else None,
        "risk_decision_id": risk.metrics.get("risk_decision_id") if risk else None,
        "dissent": dissent,
        "data_limitations": list(dict.fromkeys(m for a in o.values() for m in a.missing_data))[:15],
        "note": "Decision produced by deterministic gates; agents' stances are recorded, not counted as votes.",
    }


class FundManager(Agent):
    role = "fund_manager"
    prompt_name = "fund_manager"

    def analyze(self, ctx: DebateContext) -> AgentOutput:
        d = decide(ctx)
        ctx.extra["decision"] = d
        sup = [Claim(statement=f"Gate {g['gate']}: passed ({g['detail']})", kind="inference", source_refs=[]) for g in d["gates"] if g["passed"]]
        opp = [Claim(statement=f"Gate {g['gate']}: FAILED ({g['detail']})", kind="inference", source_refs=[]) for g in d["gates"] if not g["passed"]]
        opp += [Claim(statement=f"Dissent from {x['agent']} ({x['stance']}): {x['conclusion'][:300]}", kind="inference", source_refs=[]) for x in d["dissent"]]
        refs = [SourceRef(id=f"agent:{r}", source="debate", observed_at=a.timestamp.isoformat()) for r, a in ctx.outputs.items()]
        rationale = f"{d['decision']}: " + ("; ".join(g["detail"] for g in d["gates"] if not g["passed"]) or "all mandatory gates passed")
        out = self.base_output(
            ctx, status="completed", stance="no_view" if d["decision"] not in ("LONG", "SHORT") else ("bullish" if d["decision"] == "LONG" else "bearish"),
            confidence=None, conclusion=rationale, supporting_evidence=sup, opposing_evidence=opp,
            uncertainty="Decisions are research outputs in paper-trading mode; no live order is placed.",
            source_references=refs, missing_data=d["data_limitations"],
            recommended_next_action={"LONG": "Paper entry (if risk decision still valid)", "SHORT": "Paper entry (if risk decision still valid)"}.get(d["decision"], "No action"),
            metrics={"decision": d},
        )
        if ctx.llm.enabled:
            _, persona = load_prompt("fund_manager")
            try:
                raw = ctx.llm.complete_json(ctx.db, agent=self.role, prompt_version=self.prompt_version, system=persona,
                                            user=json.dumps({"decision": d, "agents": {r: a.conclusion for r, a in ctx.outputs.items()}}, default=str)[:12000],
                                            budget=ctx.budget, session_id=ctx.session_id)
                text = raw.get("rationale")
                others = {"LONG", "SHORT", "WATCHLIST", "WAIT FOR CONFIRMATION", "REJECT", "NO TRADE"} - {d["decision"]}
                upper = text.upper().replace(d["decision"], "") if isinstance(text, str) else ""
                if not isinstance(text, str):
                    out.errors.append("LLM rationale missing")
                elif any(re.search(rf"\b{w}\b", upper) for w in others):
                    # Wording that names a different decision would mislead readers; discard it.
                    out.errors.append("LLM rationale discarded: it referenced a decision other than the gate's")
                else:
                    out.metrics["llm_rationale"] = text[:2000]
                    out.llm_used, out.model = True, ctx.llm.model
            except (BudgetExceeded, LLMUnavailable) as e:
                out.errors.append(f"LLM rationale skipped: {e}")
        return out
