"""Structured agent output contract shared by every agent."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

AgentRole = Literal["macro", "fundamental", "onchain", "flow", "technical", "quant", "risk", "critic", "fund_manager"]
ClaimKind = Literal["fact", "inference", "hypothesis", "unknown"]
Stance = Literal["bullish", "bearish", "neutral", "no_view"]
Status = Literal["completed", "insufficient_data", "error", "veto"]
FinalDecision = Literal["LONG", "SHORT", "WATCHLIST", "WAIT FOR CONFIRMATION", "REJECT", "NO TRADE"]

AGENT_PERSONAS: dict[str, str] = {
    "macro": "Atlas", "fundamental": "Sage", "onchain": "Cipher", "flow": "Vortex", "technical": "Chronos",
    "quant": "Alpha", "risk": "Sentinel", "critic": "Killjoy", "fund_manager": "Odin",
}
_ROLE_TITLES = {
    "macro": "Macro Analyst",
    "fundamental": "Fundamental Analyst",
    "onchain": "On-Chain Analyst",
    "flow": "Whale & Market-Flow Analyst",
    "technical": "Technical Analyst",
    "quant": "Quant Researcher",
    "risk": "Risk Manager",
    "critic": "Critical Reviewer",
    "fund_manager": "Fund Manager",
}
AGENT_NAMES: dict[str, str] = {r: f"{AGENT_PERSONAS[r]} · {t}" for r, t in _ROLE_TITLES.items()}

CONFIDENCE_NOTE = "Heuristic evidence-strength score in [0,1]; NOT a calibrated probability (no calibration has been performed)."


class SourceRef(BaseModel):
    id: str  # e.g. "metric:BTCUSDT:funding_rate", "candles:4h", "backtest:<id>", "risk_decision:<id>"
    source: str
    observed_at: str | None = None
    retrieved_at: str | None = None
    note: str | None = None


class Claim(BaseModel):
    statement: str = Field(min_length=3, max_length=600)
    kind: ClaimKind
    source_refs: list[str] = Field(default_factory=list)


class TradeIdea(BaseModel):
    side: Literal["long", "short"]
    timeframe: str
    entry: float
    entry_trigger: str
    stop_loss: float
    take_profit: float | None
    invalidation: str

    @model_validator(mode="after")
    def _sides(self) -> "TradeIdea":
        if self.side == "long" and not self.stop_loss < self.entry:
            raise ValueError("long idea needs stop below entry")
        if self.side == "short" and not self.stop_loss > self.entry:
            raise ValueError("short idea needs stop above entry")
        return self


class AgentOutput(BaseModel):
    role: AgentRole
    timestamp: datetime
    snapshot_id: UUID
    snapshot_hash: str
    status: Status
    stance: Stance
    conclusion: str = Field(min_length=3, max_length=2000)
    confidence: float | None = Field(default=None, ge=0, le=1)
    confidence_note: str = CONFIDENCE_NOTE
    supporting_evidence: list[Claim] = Field(default_factory=list)
    opposing_evidence: list[Claim] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    uncertainty: str
    source_references: list[SourceRef] = Field(default_factory=list)
    missing_data: list[str] = Field(default_factory=list)
    recommended_next_action: str
    metrics: dict[str, Any] = Field(default_factory=dict)
    trade_idea: TradeIdea | None = None
    model: str | None = None
    prompt_version: str
    llm_used: bool = False
    errors: list[str] = Field(default_factory=list)

    @field_validator("conclusion", "uncertainty", "recommended_next_action")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @model_validator(mode="after")
    def _facts_cite_sources(self) -> "AgentOutput":
        known = {r.id for r in self.source_references}
        for c in self.supporting_evidence + self.opposing_evidence:
            missing = [s for s in c.source_refs if s not in known]
            if missing:
                raise ValueError(f"claim cites unknown source ids {missing}: {c.statement[:60]}")
            if c.kind == "fact" and not c.source_refs:
                raise ValueError(f"fact without source reference: {c.statement[:60]}")
        return self


def validate_refs_against_snapshot(out: AgentOutput, snapshot_content: dict[str, Any], extra_ids: set[str] | None = None) -> list[str]:
    """Every metric/candle reference must exist in the shared snapshot. Returns problems."""
    problems = []
    allowed = {f"metric:{k}" for k in snapshot_content.get("metrics", {})}
    allowed |= {f"candles:{iv}" for iv, c in snapshot_content.get("candles", {}).items() if c.get("rows")}
    allowed |= extra_ids or set()
    for r in out.source_references:
        if (r.id.startswith("metric:") or r.id.startswith("candles:")) and r.id not in allowed:
            problems.append(f"reference {r.id} is not in snapshot {out.snapshot_id}")
    return problems
