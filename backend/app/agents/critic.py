"""Critical Reviewer / Red Team: deterministic challenge generation (+ optional LLM)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.agents.base import Agent, DebateContext
from app.agents.schemas import AgentOutput, Claim, SourceRef


@dataclass
class Challenge:
    to: str
    issue: str
    blocking: bool
    refs: list[str] = field(default_factory=list)


class CriticalReviewer(Agent):
    role = "critic"
    prompt_name = "critic"

    def challenges(self, ctx: DebateContext) -> list[Challenge]:
        out: list[Challenge] = []
        q = ctx.snapshot.quality_summary
        o = ctx.outputs
        if ctx.snapshot.is_simulated:
            out.append(Challenge("fund_manager", "Snapshot contains SIMULATED data; no conclusion applies to real markets.", True))
        stale_candles = [s for s in q.get("stale", []) if s.startswith("candles:")]
        if stale_candles:
            out.append(Challenge("technical", f"Price data is stale ({', '.join(stale_candles)}); setups computed on stale bars are invalid.", True, stale_candles))
        tech, quant, flow = o.get("technical"), o.get("quant"), o.get("flow")
        for role, a in o.items():
            if a.status == "insufficient_data" and role not in ("risk",):
                out.append(Challenge(role, f"{role} produced no view ({'; '.join(a.missing_data[:2]) or 'missing inputs'}); its domain is a blind spot.", False))
        idea = tech.trade_idea if tech else None
        if idea:
            refs = [r.id for r in tech.source_references if r.id.startswith("candles:4h")]
            risk = abs(idea.entry - idea.stop_loss)
            if idea.take_profit:
                rr = abs(idea.take_profit - idea.entry) / risk if risk else 0
                if rr < 1.5:
                    out.append(Challenge("technical", f"Reward:risk {rr:.2f} is below 1.5; costs erode the edge.", False, refs))
            h4 = (tech.metrics.get("timeframes") or {}).get("4h") or {}
            atr = h4.get("atr14")
            if atr and risk < atr:
                out.append(Challenge("technical", f"Stop distance {risk:.2f} is inside one 4h ATR ({atr:.2f}); likely stopped by noise.", False, refs))
            rsi = h4.get("rsi14")
            if rsi is not None and ((idea.side == "long" and rsi > 70) or (idea.side == "short" and rsi < 30)):
                out.append(Challenge("technical", f"Entering {idea.side} with 4h RSI {rsi:.1f} at an extreme chases an extended move.", False, refs))
            if quant:
                verdict = (quant.metrics.get("backtest") or {}).get("edge_verdict")
                qrefs = [r.id for r in quant.source_references]
                if verdict != "supported":
                    out.append(Challenge("technical", f"The setup has no validated out-of-sample edge (quant verdict: {verdict or quant.status}). Opinion is not evidence.", True, qrefs))
                for w in (quant.metrics.get("backtest") or {}).get("warnings", [])[:3]:
                    out.append(Challenge("quant", f"Overfitting risk: {w}", False, qrefs))
            if flow and flow.status == "completed":
                fr = (flow.metrics.get("facts") or {}).get("funding_rate_8h")
                frefs = [r.id for r in flow.source_references if "funding" in r.id]
                if fr is not None and ((idea.side == "long" and fr > 0.0005) or (idea.side == "short" and fr < -0.0003)):
                    out.append(Challenge("flow", f"Funding {fr:.4%} shows the {idea.side} side is crowded; adverse squeeze risk.", False, frefs))
            for role in ("macro", "fundamental", "onchain", "flow"):
                a = o.get(role)
                if a and a.status == "completed" and a.stance in ("bullish", "bearish"):
                    against = (idea.side == "long" and a.stance == "bearish") or (idea.side == "short" and a.stance == "bullish")
                    if against:
                        out.append(Challenge(role, f"{role} context is {a.stance}, contradicting the {idea.side} thesis. Which evidence dominates and why?", False,
                                             [r.id for r in a.source_references][:3]))
        elif tech and tech.status == "completed":
            out.append(Challenge("technical", "No aligned setup: the strongest case is to do nothing until structure resolves.", False))
        bulls = [r for r, a in o.items() if a.stance == "bullish" and a.status == "completed"]
        bears = [r for r, a in o.items() if a.stance == "bearish" and a.status == "completed"]
        if bulls and bears:
            out.append(Challenge("fund_manager", f"Unresolved disagreement: bullish {bulls} vs bearish {bears}.", False))
        return out

    def analyze(self, ctx: DebateContext) -> AgentOutput:
        chs = self.challenges(ctx)
        refs: dict[str, SourceRef] = {}
        for a in ctx.outputs.values():
            for r in a.source_references:
                refs.setdefault(r.id, r)
        claims = [Claim(statement=f"[to {c.to}{' | BLOCKING' if c.blocking else ''}] {c.issue}",
                        kind="inference" if c.refs else "hypothesis", source_refs=[x for x in c.refs if x in refs]) for c in chs]
        blocking = [c for c in chs if c.blocking]
        strongest = blocking[0].issue if blocking else (chs[0].issue if chs else "No material objection found on available data.")
        out = self.base_output(
            ctx, status="completed", stance="no_view" if blocking else "neutral",
            confidence=None,
            conclusion=f"Strongest counterargument: {strongest}",
            opposing_evidence=claims, uncertainty="Red-team review is limited to evidence present in the snapshot.",
            source_references=list(refs.values()),
            missing_data=list(dict.fromkeys(m for a in ctx.outputs.values() for m in a.missing_data))[:20],
            recommended_next_action="Resolve blocking issues before any trade" if blocking else "Address challenges in replies",
            metrics={"challenges": [c.__dict__ for c in chs], "blocking": len(blocking)},
        )
        digest: dict[str, Any] = {r: {"stance": a.stance, "status": a.status, "conclusion": a.conclusion,
                                       "missing": a.missing_data[:5]} for r, a in ctx.outputs.items()}
        digest["deterministic_challenges"] = [c.__dict__ for c in chs]
        enriched = self.enrich_with_llm(ctx, out, digest)
        enriched.metrics = out.metrics  # deterministic challenges remain authoritative for gating
        return enriched
