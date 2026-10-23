"""ORM models. The migration in alembic/versions is the source of truth for DDL;
these models must stay in sync with it (tests/test_migrations.py checks this).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NUM = Numeric(38, 12)


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSONB, list[Any]: JSONB}


def ts_col(nullable: bool = False, default_now: bool = True) -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True),
        nullable=nullable,
        server_default=func.now() if default_now else None,
    )


# --- Access control ----------------------------------------------------------

class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16))  # admin | operator | viewer
    disabled: Mapped[bool] = mapped_column(Boolean, server_default="false")
    created_at: Mapped[datetime] = ts_col()


class UserSession(Base):
    __tablename__ = "user_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = ts_col()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AuditLog(Base):
    """Append-only; a DB trigger rejects UPDATE/DELETE. Rows are hash-chained."""

    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    ts: Mapped[datetime] = ts_col()
    actor: Mapped[str] = mapped_column(String(128))
    action: Mapped[str] = mapped_column(String(128), index=True)
    target: Mapped[str | None] = mapped_column(String(256))
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))


class SystemEvent(Base):
    """Real backend events. The dashboard animates only in response to these."""

    __tablename__ = "system_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    ts: Mapped[datetime] = ts_col()
    type: Mapped[str] = mapped_column(String(64), index=True)
    agent: Mapped[str | None] = mapped_column(String(32))
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")


# --- Market data -------------------------------------------------------------

class MarketObservation(Base):
    __tablename__ = "market_observations"
    __table_args__ = (
        UniqueConstraint("source", "asset", "metric", "timeframe", "observed_at", name="uq_observation"),
        Index("ix_obs_lookup", "asset", "metric", "observed_at"),
    )
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    source: Mapped[str] = mapped_column(String(32))
    asset: Mapped[str] = mapped_column(String(64))
    metric: Mapped[str] = mapped_column(String(64))
    value: Mapped[Decimal | None] = mapped_column(NUM)
    unit: Mapped[str] = mapped_column(String(32))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    retrieved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    timeframe: Mapped[str] = mapped_column(String(16), server_default="point")
    quality: Mapped[str] = mapped_column(String(16))  # ok | stale | invalid | simulated
    meta: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")


class Candle(Base):
    __tablename__ = "candles"
    __table_args__ = (
        UniqueConstraint("source", "symbol", "interval", "open_time", name="uq_candle"),
        Index("ix_candle_lookup", "symbol", "interval", "open_time"),
    )
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    source: Mapped[str] = mapped_column(String(32))
    symbol: Mapped[str] = mapped_column(String(32))
    interval: Mapped[str] = mapped_column(String(8))
    open_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    close_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    open: Mapped[Decimal] = mapped_column(NUM)
    high: Mapped[Decimal] = mapped_column(NUM)
    low: Mapped[Decimal] = mapped_column(NUM)
    close: Mapped[Decimal] = mapped_column(NUM)
    volume: Mapped[Decimal] = mapped_column(NUM)
    retrieved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    quality: Mapped[str] = mapped_column(String(16))


class SourceHealth(Base):
    __tablename__ = "source_health"
    source: Mapped[str] = mapped_column(String(32), primary_key=True)
    status: Mapped[str] = mapped_column(String(32))  # unknown|ok|degraded|down|unconfigured
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    consecutive_failures: Mapped[int] = mapped_column(Integer, server_default="0")
    last_latency_ms: Mapped[int | None] = mapped_column(Integer)
    rate_limit_info: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    updated_at: Mapped[datetime] = ts_col()


class DataSnapshot(Base):
    """Frozen, hashed view of the data every agent in a debate reasons over."""

    __tablename__ = "data_snapshots"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    created_at: Mapped[datetime] = ts_col()
    symbol: Mapped[str] = mapped_column(String(32), index=True)
    content: Mapped[dict[str, Any]] = mapped_column(JSONB)
    content_hash: Mapped[str] = mapped_column(String(64))
    quality_summary: Mapped[dict[str, Any]] = mapped_column(JSONB)
    is_simulated: Mapped[bool] = mapped_column(Boolean, server_default="false")


# --- Agents & debate -----------------------------------------------------------

class DebateSession(Base):
    __tablename__ = "debate_sessions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    created_at: Mapped[datetime] = ts_col()
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    symbol: Mapped[str] = mapped_column(String(32), index=True)
    snapshot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("data_snapshots.id"))
    status: Mapped[str] = mapped_column(String(32))  # running|completed|failed|aborted
    trigger: Mapped[str] = mapped_column(String(32))
    idempotency_key: Mapped[str] = mapped_column(String(128), unique=True)
    rounds_completed: Mapped[int] = mapped_column(Integer, server_default="0")
    max_rounds: Mapped[int] = mapped_column(Integer)
    tokens_used: Mapped[int] = mapped_column(Integer, server_default="0")
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), server_default="0")
    final_decision: Mapped[str | None] = mapped_column(String(32))
    config: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    error: Mapped[str | None] = mapped_column(Text)


class AgentAnalysis(Base):
    __tablename__ = "agent_analyses"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("debate_sessions.id", ondelete="CASCADE"), index=True)
    agent_role: Mapped[str] = mapped_column(String(32), index=True)
    round: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32))  # completed|insufficient_data|error|veto
    output: Mapped[dict[str, Any]] = mapped_column(JSONB)
    model: Mapped[str | None] = mapped_column(String(64))
    prompt_version: Mapped[str] = mapped_column(String(32))
    tokens_in: Mapped[int] = mapped_column(Integer, server_default="0")
    tokens_out: Mapped[int] = mapped_column(Integer, server_default="0")
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = ts_col()


class DebateMessage(Base):
    __tablename__ = "debate_messages"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("debate_sessions.id", ondelete="CASCADE"), index=True)
    round: Mapped[int] = mapped_column(Integer)
    from_agent: Mapped[str] = mapped_column(String(32))
    to_agent: Mapped[str | None] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(24))
    content: Mapped[str] = mapped_column(Text)
    references: Mapped[list[Any]] = mapped_column(JSONB, server_default="[]")
    reply_to: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = ts_col()


class Decision(Base):
    __tablename__ = "decisions"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("debate_sessions.id"), unique=True)
    symbol: Mapped[str] = mapped_column(String(32), index=True)
    decision: Mapped[str] = mapped_column(String(32))
    details: Mapped[dict[str, Any]] = mapped_column(JSONB)
    risk_decision_id: Mapped[int | None] = mapped_column(ForeignKey("risk_decisions.id"))
    created_at: Mapped[datetime] = ts_col()


class LlmCall(Base):
    __tablename__ = "llm_calls"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    agent: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(64))
    prompt_version: Mapped[str] = mapped_column(String(32))
    tokens_in: Mapped[int] = mapped_column(Integer, server_default="0")
    tokens_out: Mapped[int] = mapped_column(Integer, server_default="0")
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), server_default="0")
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = ts_col()


# --- Risk ----------------------------------------------------------------------

class RiskDecision(Base):
    """Immutable record of every Risk Engine evaluation (trigger-protected)."""

    __tablename__ = "risk_decisions"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    created_at: Mapped[datetime] = ts_col()
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    symbol: Mapped[str] = mapped_column(String(32))
    approved: Mapped[bool] = mapped_column(Boolean)
    reasons: Mapped[list[Any]] = mapped_column(JSONB)
    inputs: Mapped[dict[str, Any]] = mapped_column(JSONB)
    result: Mapped[dict[str, Any]] = mapped_column(JSONB)
    engine_version: Mapped[str] = mapped_column(String(16))
    hash: Mapped[str] = mapped_column(String(64))


class RiskState(Base):
    __tablename__ = "risk_state"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)  # always 1
    emergency_stop: Mapped[bool] = mapped_column(Boolean, server_default="false")
    reason: Mapped[str | None] = mapped_column(Text)
    updated_by: Mapped[str | None] = mapped_column(String(128))
    updated_at: Mapped[datetime] = ts_col()


# --- Quant -----------------------------------------------------------------------

class BacktestRun(Base):
    __tablename__ = "backtest_runs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    created_at: Mapped[datetime] = ts_col()
    strategy: Mapped[str] = mapped_column(String(64), index=True)
    symbol: Mapped[str] = mapped_column(String(32))
    interval: Mapped[str] = mapped_column(String(8))
    dataset_kind: Mapped[str] = mapped_column(String(16))  # historical | simulated
    data_source: Mapped[str] = mapped_column(String(32))
    data_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    data_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    params: Mapped[dict[str, Any]] = mapped_column(JSONB)
    assumptions: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(32))
    results: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    cache_key: Mapped[str] = mapped_column(String(64), index=True)
    error: Mapped[str | None] = mapped_column(Text)


# --- Paper trading ----------------------------------------------------------------

class PaperAccount(Base):
    __tablename__ = "paper_accounts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    starting_equity: Mapped[Decimal] = mapped_column(NUM)
    cash: Mapped[Decimal] = mapped_column(NUM)
    peak_equity: Mapped[Decimal] = mapped_column(NUM)
    created_at: Mapped[datetime] = ts_col()


class PaperOrder(Base):
    __tablename__ = "paper_orders"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("paper_accounts.id"), index=True)
    client_order_id: Mapped[str] = mapped_column(String(64), unique=True)
    symbol: Mapped[str] = mapped_column(String(32))
    side: Mapped[str] = mapped_column(String(8))
    order_type: Mapped[str] = mapped_column(String(16))
    purpose: Mapped[str] = mapped_column(String(16))  # entry | exit
    qty: Mapped[Decimal] = mapped_column(NUM)
    limit_price: Mapped[Decimal | None] = mapped_column(NUM)
    stop_loss: Mapped[Decimal | None] = mapped_column(NUM)
    take_profit: Mapped[Decimal | None] = mapped_column(NUM)
    status: Mapped[str] = mapped_column(String(32))
    filled_qty: Mapped[Decimal] = mapped_column(NUM, server_default="0")
    avg_fill_price: Mapped[Decimal | None] = mapped_column(NUM)
    fee: Mapped[Decimal] = mapped_column(NUM, server_default="0")
    slippage_cost: Mapped[Decimal] = mapped_column(NUM, server_default="0")
    risk_decision_id: Mapped[int | None] = mapped_column(ForeignKey("risk_decisions.id"))
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    position_id: Mapped[int | None] = mapped_column(BigInteger)
    reject_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = ts_col()
    updated_at: Mapped[datetime] = ts_col()


class PaperPosition(Base):
    __tablename__ = "paper_positions"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("paper_accounts.id"), index=True)
    symbol: Mapped[str] = mapped_column(String(32))
    side: Mapped[str] = mapped_column(String(8))
    qty: Mapped[Decimal] = mapped_column(NUM)
    entry_price: Mapped[Decimal] = mapped_column(NUM)
    stop_loss: Mapped[Decimal] = mapped_column(NUM)
    take_profit: Mapped[Decimal | None] = mapped_column(NUM)
    planned_risk: Mapped[Decimal] = mapped_column(NUM)
    status: Mapped[str] = mapped_column(String(32))  # open | closed
    opened_at: Mapped[datetime] = ts_col()
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    exit_price: Mapped[Decimal | None] = mapped_column(NUM)
    exit_reason: Mapped[str | None] = mapped_column(String(32))
    fees: Mapped[Decimal] = mapped_column(NUM, server_default="0")
    realized_pnl: Mapped[Decimal | None] = mapped_column(NUM)


class PaperEquitySnapshot(Base):
    __tablename__ = "paper_equity_snapshots"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("paper_accounts.id"), index=True)
    ts: Mapped[datetime] = ts_col()
    equity: Mapped[Decimal] = mapped_column(NUM)
    cash: Mapped[Decimal] = mapped_column(NUM)
    unrealized_pnl: Mapped[Decimal] = mapped_column(NUM)
    drawdown: Mapped[Decimal] = mapped_column(NUM)
    marks_stale: Mapped[bool] = mapped_column(Boolean, server_default="false")


# --- Workflows & jobs -----------------------------------------------------------

class WorkflowExecution(Base):
    __tablename__ = "workflow_executions"
    __table_args__ = (UniqueConstraint("workflow_id", "execution_id", name="uq_wf_exec"),)
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    workflow_id: Mapped[str] = mapped_column(String(64))
    workflow_name: Mapped[str | None] = mapped_column(String(128))
    execution_id: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    reported_by: Mapped[str] = mapped_column(String(16))  # callback | n8n_api
    created_at: Mapped[datetime] = ts_col()


class JobLock(Base):
    """Duplicate-execution guard: a job key can be held by one runner until expiry."""

    __tablename__ = "job_locks"
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    owner: Mapped[str] = mapped_column(String(128))
    acquired_at: Mapped[datetime] = ts_col()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# --- Telegram ----------------------------------------------------------------

class TelegramUpdate(Base):
    __tablename__ = "telegram_updates"
    update_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    received_at: Mapped[datetime] = ts_col()


class TelegramRequest(Base):
    __tablename__ = "telegram_requests"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    update_id: Mapped[int | None] = mapped_column(BigInteger)
    user_id: Mapped[int] = mapped_column(BigInteger, index=True)
    chat_id: Mapped[int] = mapped_column(BigInteger)
    authorized: Mapped[bool] = mapped_column(Boolean)
    text_preview: Mapped[str | None] = mapped_column(String(200))
    intent: Mapped[str | None] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32))
    response_chars: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = ts_col()


class TelegramContext(Base):
    __tablename__ = "telegram_context"
    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    last_intent: Mapped[str | None] = mapped_column(String(32))
    last_symbol: Mapped[str | None] = mapped_column(String(32))
    last_timeframe: Mapped[str | None] = mapped_column(String(8))
    updated_at: Mapped[datetime] = ts_col()


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    channel: Mapped[str] = mapped_column(String(16))
    recipient: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = ts_col()


# --- Exchange (actual account; never mixed with paper) -------------------------

class ExchangeSnapshot(Base):
    __tablename__ = "exchange_snapshots"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    exchange: Mapped[str] = mapped_column(String(16))
    kind: Mapped[str] = mapped_column(String(32))
    fetched_at: Mapped[datetime] = ts_col()
    status: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    error: Mapped[str | None] = mapped_column(Text)


class AppSetting(Base):
    """Runtime-editable, non-secret settings (agent config, schedules)."""

    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSONB)
    updated_by: Mapped[str | None] = mapped_column(String(128))
    updated_at: Mapped[datetime] = ts_col()
