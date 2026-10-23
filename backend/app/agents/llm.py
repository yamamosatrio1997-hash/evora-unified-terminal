"""External LLM access with per-debate token/cost budgets.

The LLM only ever produces *text and claims* that pass schema validation. It has
no tool access, cannot size positions, cannot call the risk engine with its own
limits and cannot submit orders. Secrets are never included in prompts.
"""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import httpx
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.redact import redact_text
from app.db.models import LlmCall

log = logging.getLogger(__name__)


class BudgetExceeded(Exception):
    pass


class LLMUnavailable(Exception):
    pass


@dataclass
class Budget:
    max_tokens: int
    max_cost_usd: Decimal
    tokens_used: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: Decimal = Decimal(0)
    calls: int = 0
    skipped: list[str] = field(default_factory=list)

    def check(self, expected_tokens: int, agent: str) -> None:
        s = get_settings()
        est_cost = Decimal(expected_tokens) * s.llm_output_cost_per_mtok / Decimal(1_000_000)
        if self.tokens_used + expected_tokens > self.max_tokens or self.cost_usd + est_cost > self.max_cost_usd:
            self.skipped.append(agent)
            raise BudgetExceeded(f"budget exhausted before {agent} (tokens {self.tokens_used}/{self.max_tokens}, cost ${self.cost_usd:.4f}/${self.max_cost_usd})")

    def add(self, tin: int, tout: int) -> Decimal:
        s = get_settings()
        cost = (Decimal(tin) * s.llm_input_cost_per_mtok + Decimal(tout) * s.llm_output_cost_per_mtok) / Decimal(1_000_000)
        self.tokens_used += tin + tout
        self.tokens_in += tin
        self.tokens_out += tout
        self.cost_usd += cost
        self.calls += 1
        return cost


_JSON_BLOCK = re.compile(r"\{.*\}", re.S)


def extract_json(text: str) -> dict[str, Any]:
    m = _JSON_BLOCK.search(text)
    if not m:
        raise ValueError("no JSON object in model output")
    return json.loads(m.group(0))


class LLMClient:
    def __init__(self, transport: httpx.BaseTransport | None = None) -> None:
        self.s = get_settings()
        self._transport = transport

    @property
    def enabled(self) -> bool:
        return self.s.llm_enabled

    @property
    def model(self) -> str:
        return self.s.llm_model

    def complete_json(self, db: Session, *, agent: str, prompt_version: str, system: str, user: str,
                      budget: Budget, session_id: uuid.UUID | None) -> dict[str, Any]:
        if not self.enabled:
            raise LLMUnavailable("LLM provider not configured (LLM_PROVIDER/LLM_API_KEY)")
        max_out = self.s.llm_max_tokens_per_call
        budget.check(max_out + len(user) // 3, agent)
        started = time.monotonic()
        status, err, tin, tout = "ok", None, 0, 0
        try:
            with httpx.Client(timeout=self.s.llm_timeout_seconds, transport=self._transport) as c:
                resp = c.post(
                    f"{self.s.llm_base_url}/v1/messages",
                    headers={"x-api-key": self.s.llm_api_key.get_secret_value(), "anthropic-version": "2023-06-01",
                             "content-type": "application/json"},
                    json={"model": self.model, "max_tokens": max_out, "system": system,
                          "messages": [{"role": "user", "content": user}]},
                )
            if resp.status_code != 200:
                raise LLMUnavailable(f"LLM HTTP {resp.status_code}")
            body = resp.json()
            usage = body.get("usage", {})
            tin, tout = int(usage.get("input_tokens", 0)), int(usage.get("output_tokens", 0))
            text = "".join(b.get("text", "") for b in body.get("content", []) if b.get("type") == "text")
            return extract_json(text)
        except (httpx.HTTPError, ValueError, LLMUnavailable) as e:
            status, err = "error", redact_text(str(e))[:500]
            raise LLMUnavailable(err) from e
        finally:
            cost = budget.add(tin, tout)
            db.add(LlmCall(session_id=session_id, agent=agent, model=self.model, prompt_version=prompt_version,
                           tokens_in=tin, tokens_out=tout, cost_usd=cost,
                           latency_ms=int((time.monotonic() - started) * 1000), status=status, error=err))
            db.flush()
