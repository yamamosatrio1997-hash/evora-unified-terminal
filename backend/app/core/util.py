from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID


def utcnow() -> datetime:
    return datetime.now(UTC)


def _default(o: Any) -> Any:
    if isinstance(o, Decimal):
        return str(o)
    if isinstance(o, datetime):
        return o.isoformat()
    if isinstance(o, UUID):
        return str(o)
    if hasattr(o, "model_dump"):
        return o.model_dump(mode="json")
    raise TypeError(f"not serializable: {type(o)!r}")


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, default=_default, sort_keys=True, separators=(",", ":"))


def jsonable(obj: Any) -> Any:
    """Round-trip through canonical JSON so Decimals/datetimes are JSONB-safe."""
    return json.loads(canonical_json(obj))


def sha256_hex(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def to_decimal(v: Any) -> Decimal | None:
    if v is None or v == "" or v == ".":
        return None
    try:
        d = Decimal(str(v))
    except Exception:
        return None
    return d if d.is_finite() else None
