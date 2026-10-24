from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any


@dataclass
class Obs:
    source: str
    asset: str
    metric: str
    value: Decimal | None
    unit: str
    observed_at: datetime
    timeframe: str = "point"
    quality: str = "ok"
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class CandleRow:
    source: str
    symbol: str
    interval: str
    open_time: datetime
    close_time: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    quality: str = "ok"


@dataclass
class SourceBatch:
    source: str
    observations: list[Obs] = field(default_factory=list)
    candles: list[CandleRow] = field(default_factory=list)
    rejected: list[str] = field(default_factory=list)  # validation failures, human readable
    latency_ms: int = 0
    rate_limit_info: dict[str, Any] = field(default_factory=dict)


class SourceUnconfigured(Exception):
    """Source needs credentials that are not set. Not an outage."""
