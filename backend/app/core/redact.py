"""Secret redaction for logs, audit records and outbound messages."""
from __future__ import annotations

import re
from typing import Any

from app.config import SECRET_FIELD_NAMES, get_settings

_KEY_PATTERN = re.compile(r"(api[_-]?key|secret|token|password|signature|authorization)", re.I)
_TELEGRAM_TOKEN = re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b")


def _secret_values() -> list[str]:
    s = get_settings()
    vals = []
    for name in SECRET_FIELD_NAMES:
        v = getattr(s, name).get_secret_value()
        if v and len(v) >= 6:
            vals.append(v)
    return vals


def redact_text(text: str) -> str:
    for v in _secret_values():
        text = text.replace(v, "[REDACTED]")
    return _TELEGRAM_TOKEN.sub("[REDACTED]", text)


def redact(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {
            k: ("[REDACTED]" if _KEY_PATTERN.search(str(k)) else redact(v)) for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    if isinstance(obj, str):
        return redact_text(obj)
    return obj
