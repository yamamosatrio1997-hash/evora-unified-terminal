"""Outbound Telegram Bot API calls (sendMessage) with safe length handling."""
from __future__ import annotations

from collections.abc import Callable

import httpx
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.redact import redact_text
from app.db.models import Notification

MAX_LEN = 4000  # Telegram limit is 4096; leave headroom


def split_message(text: str, limit: int = MAX_LEN) -> list[str]:
    parts: list[str] = []
    while len(text) > limit:
        cut = text.rfind("\n", 0, limit)
        cut = cut if cut > limit // 2 else limit
        parts.append(text[:cut])
        text = text[cut:].lstrip("\n")
    if text:
        parts.append(text)
    return parts or [""]


Sender = Callable[[int, str], None]


class TelegramSender:
    def __init__(self, transport: httpx.BaseTransport | None = None) -> None:
        s = get_settings()
        self._token = s.telegram_bot_token.get_secret_value()
        self._base = s.telegram_api_base
        self._http = httpx.Client(timeout=10, transport=transport)

    def __call__(self, chat_id: int, text: str) -> None:
        if not self._token:
            raise RuntimeError("TELEGRAM_BOT_TOKEN not configured")
        for chunk in split_message(text):
            r = self._http.post(f"{self._base}/bot{self._token}/sendMessage",
                                json={"chat_id": chat_id, "text": chunk, "disable_web_page_preview": True})
            if r.status_code != 200:
                # never include the URL (contains the token) in the error
                raise RuntimeError(f"sendMessage HTTP {r.status_code}: {redact_text(r.text[:200])}")


def notify(db: Session, sender: Sender, chat_id: int, kind: str, text: str) -> bool:
    try:
        sender(chat_id, text)
        db.add(Notification(channel="telegram", recipient=str(chat_id), kind=kind, status="sent"))
        return True
    except Exception as e:  # noqa: BLE001 - delivery errors are recorded and surfaced
        db.add(Notification(channel="telegram", recipient=str(chat_id), kind=kind, status="error", error=redact_text(str(e))[:500]))
        return False
