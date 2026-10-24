"""Risk Manager: wraps the deterministic Risk Engine and holds an independent veto."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from app.agents.base import Agent, DebateContext
from app.agents.schemas import AgentOutput, Claim, SourceRef
from app.config import get_settings
from app.paper.engine import get_account, portfolio_state
from app.risk.engine import TradeProposal
from app.risk.service import PAPER_SPECS, evaluate_and_record


def freshest_price(ctx: DebateContext) -> tuple[Decimal | None, datetime | None, SourceRef | None]:
    """Most recent price in the snapshot: futures mark price, spot price, or last 1h close."""
    candidates = []
    for key in (f"{ctx.symbol}:mark_price", f"{ctx.content.get('base_asset')}:price"):
        m = ctx.metric(key)
        if m:
            candidates.append((datetime.fromisoformat(m["latest"]["observed_at"]), Decimal(m["latest"]["value"]), ctx.metric_ref(key)))
    c1h = (ctx.content.get("candles", {}).get("1h") or {})
    if c1h.get("rows"):
        candidates.append((datetime.fromisoformat(c1h["last_close_time"]), Decimal(c1h["rows"][-1][4]), ctx.candle_ref("1h")))
    if not candidates:
        return None, None, None
    ts, px, ref = max(candidates, key=lambda c: c[0])
    return px, ts, ref


class RiskManager(Agent):
    role = "risk"

    def analyze(self, ctx: DebateContext) -> AgentOutput:
        tech = ctx.outputs.get("technical")
        idea = tech.trade_idea if tech else None
        if idea is None:
            return self.base_output(
                ctx, status="completed", stance="no_view", confidence=None,
                conclusion="No trade proposal to evaluate; nothing to approve or veto.",
                uncertainty="n/a", recommended_next_action="None",
            )
        s = get_settings()
        px, ts, price_ref = freshest_price(ctx)
        funding = ctx.metric_value(f"{ctx.symbol}:funding_rate")
        acct = get_account(ctx.db)
        pf = portfolio_state(ctx.db, acct)
        proposal = TradeProposal(
            symbol=ctx.symbol, side=idea.side, entry_price=px, stop_loss=Decimal(str(idea.stop_loss)),
            take_profit=Decimal(str(idea.take_profit)) if idea.take_profit else None,
            leverage=min(Decimal(2), s.max_leverage), requested_risk_fraction=s.default_risk_per_trade,
            data_timestamp=ts, funding_rate_8h=Decimal(str(funding)) if funding is not None else None,
            idempotency_key=f"session:{ctx.session_id}",
        )
        result, row = evaluate_and_record(ctx.db, proposal, pf, PAPER_SPECS.get(ctx.symbol), session_id=ctx.session_id)
        ctx.extra["risk_decision_id"] = row.id
        ref = SourceRef(id=f"risk_decision:{row.id}", source="risk_engine", observed_at=row.created_at.isoformat() if row.created_at else None,
                        note=f"engine {result.engine_version}; hash {row.hash[:12]}")
        refs = [ref] + ([price_ref] if price_ref else [])
        checks = [Claim(statement=f"{c.name}: {c.detail}", kind="fact", source_refs=[ref.id]) for c in result.checks]
        if result.approved:
            return self.base_output(
                ctx, status="completed", stance="neutral", confidence=None,
                conclusion=(f"{result.verdict}: {result.qty} {ctx.symbol} ({idea.side}), est. loss at stop "
                            f"{result.estimated_loss:.2f} = {result.risk_fraction:.2%} of equity (ceiling {s.max_planned_risk_per_trade:.0%})."),
                supporting_evidence=[c for c, ch in zip(checks, result.checks) if ch.passed],
                assumptions=[result.disclosure, "Paper venue contract specifications (simulator configuration)."],
                uncertainty=result.disclosure, source_references=refs,
                recommended_next_action="Eligible for Fund Manager decision", metrics={"risk": result.to_dict(), "risk_decision_id": row.id},
            )
        return self.base_output(
            ctx, status="veto", stance="no_view", confidence=None,
            conclusion=f"VETO: {'; '.join(result.reasons)}",
            opposing_evidence=[c for c, ch in zip(checks, result.checks) if not ch.passed],
            assumptions=[result.disclosure], uncertainty=result.disclosure, source_references=refs,
            recommended_next_action="Do not trade. The veto cannot be overridden by any agent.",
            metrics={"risk": result.to_dict(), "risk_decision_id": row.id},
        )
