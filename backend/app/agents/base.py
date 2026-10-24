"""Agent framework: shared debate context, source helpers and LLM enrichment."""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.agents.llm import Budget, BudgetExceeded, LLMClient, LLMUnavailable
from app.agents.schemas import AgentOutput, Claim, SourceRef
from app.core.util import utcnow
from app.db.models import DataSnapshot

PROMPT_DIR = Path(__file__).parent / "prompts"


@lru_cache
def load_prompt(name: str) -> tuple[str, str]:
    """Return (version, body)."""
    text = (PROMPT_DIR / f"{name}.md").read_text()
    first, _, body = text.partition("\n")
    return first.removeprefix("version:").strip(), body.strip()


@dataclass
class DebateContext:
    db: Session
    snapshot: DataSnapshot
    session_id: uuid.UUID
    llm: LLMClient
    budget: Budget
    outputs: dict[str, AgentOutput] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def content(self) -> dict[str, Any]:
        return self.snapshot.content

    @property
    def symbol(self) -> str:
        return self.snapshot.symbol

    def metric(self, key: str) -> dict[str, Any] | None:
        return self.content.get("metrics", {}).get(key)

    def metric_value(self, key: str) -> float | None:
        m = self.metric(key)
        try:
            return float(m["latest"]["value"]) if m else None
        except (TypeError, ValueError):
            return None

    def metric_history(self, key: str) -> list[tuple[str, float]]:
        m = self.metric(key)
        return [(t, float(v)) for t, v in m["history"]] if m else []

    def metric_ref(self, key: str) -> SourceRef | None:
        m = self.metric(key)
        if not m:
            return None
        note = "STALE" if m.get("stale") else None
        avail = (m["latest"].get("meta") or {}).get("available_since")
        if avail:
            note = f"{note + '; ' if note else ''}public since {avail}"
        return SourceRef(id=f"metric:{key}", source=m["source"], observed_at=m["latest"]["observed_at"],
                         retrieved_at=m["latest"]["retrieved_at"], note=note)

    def candle_ref(self, interval: str) -> SourceRef | None:
        c = self.content.get("candles", {}).get(interval)
        if not c or not c.get("rows"):
            return None
        return SourceRef(id=f"candles:{interval}", source=c["source"], observed_at=c["last_close_time"],
                         note="STALE" if c.get("stale") else None)

    def is_stale(self, key: str) -> bool:
        return key in self.snapshot.quality_summary.get("stale", [])


class Agent:
    role: str = ""
    prompt_name: str | None = None

    @property
    def prompt_version(self) -> str:
        common_v, _ = load_prompt("common")
        if self.prompt_name:
            v, _ = load_prompt(self.prompt_name)
            return f"{v}+{common_v}"
        return "deterministic-v1"

    def analyze(self, ctx: DebateContext) -> AgentOutput:
        raise NotImplementedError

    def base_output(self, ctx: DebateContext, **kw: Any) -> AgentOutput:
        return AgentOutput(role=self.role, timestamp=utcnow(), snapshot_id=ctx.snapshot.id,
                           snapshot_hash=ctx.snapshot.content_hash, prompt_version=self.prompt_version, **kw)

    # ---------------------------------------------------------------- LLM layer
    def enrich_with_llm(self, ctx: DebateContext, out: AgentOutput, facts_digest: dict[str, Any]) -> AgentOutput:
        """Ask the LLM for interpretation on top of deterministic facts. Any output
        that fails validation is discarded and the deterministic result is kept."""
        if not self.prompt_name or not ctx.llm.enabled:
            if not ctx.llm.enabled:
                out.errors.append("LLM not configured: deterministic analysis only")
            return out
        _, common = load_prompt("common")
        _, persona = load_prompt(self.prompt_name)
        available = [r.id for r in out.source_references]
        user = (
            f"SYMBOL: {ctx.symbol}\nSNAPSHOT: {ctx.snapshot.id} (hash {ctx.snapshot.content_hash[:12]})\n"
            f"AVAILABLE SOURCE IDS: {json.dumps(available)}\n"
            f"DETERMINISTIC FACTS:\n{json.dumps(facts_digest, default=str)[:12000]}\n"
            f"KNOWN MISSING DATA: {json.dumps(out.missing_data)}\n"
        )
        try:
            raw = ctx.llm.complete_json(ctx.db, agent=self.role, prompt_version=self.prompt_version,
                                        system=f"{common}\n\n{persona}", user=user, budget=ctx.budget, session_id=ctx.session_id)
        except (BudgetExceeded, LLMUnavailable) as e:
            out.errors.append(f"LLM skipped: {e}")
            return out
        try:
            merged = out.model_dump()
            for k in ("stance", "conclusion", "uncertainty", "recommended_next_action"):
                if isinstance(raw.get(k), str) and raw[k].strip():
                    merged[k] = raw[k].strip()
            if isinstance(raw.get("confidence"), (int, float)):
                merged["confidence"] = min(float(raw["confidence"]), out.confidence if out.confidence is not None else 1.0)
            known = set(available)
            for k in ("supporting_evidence", "opposing_evidence"):
                for c in raw.get(k) or []:
                    claim = Claim.model_validate(c)
                    if any(s not in known for s in claim.source_refs) or (claim.kind == "fact" and not claim.source_refs):
                        merged["errors"].append(f"dropped LLM claim with invalid citation: {claim.statement[:80]}")
                        continue
                    merged[k].append(claim.model_dump())
            for k in ("assumptions", "missing_data"):
                merged[k] = list(dict.fromkeys(merged[k] + [str(x) for x in raw.get(k) or []]))
            merged.update(model=ctx.llm.model, llm_used=True)
            return AgentOutput.model_validate(merged)
        except (ValidationError, TypeError, ValueError) as e:
            out.errors.append(f"LLM output rejected by schema: {str(e)[:200]}")
            return out


def fact(statement: str, *refs: SourceRef | None) -> Claim:
    ids = [r.id for r in refs if r is not None]
    return Claim(statement=statement, kind="fact" if ids else "unknown", source_refs=ids)


def inference(statement: str, *refs: SourceRef | None) -> Claim:
    return Claim(statement=statement, kind="inference", source_refs=[r.id for r in refs if r is not None])


def uniq_refs(*refs: SourceRef | None) -> list[SourceRef]:
    seen: dict[str, SourceRef] = {}
    for r in refs:
        if r is not None and r.id not in seen:
            seen[r.id] = r
    return list(seen.values())
