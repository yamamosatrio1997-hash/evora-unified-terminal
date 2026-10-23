"""MESSAGE -> AUTHORIZATION -> INTENT ROUTING -> VALIDATION -> DATA RETRIEVAL ->
REPORT -> RESPONSE VALIDATION -> TELEGRAM RESPONSE -> AUDIT LOG."""
from __future__ import annotations

import logging
import time
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.audit import audit
from app.core.events import emit
from app.core.redact import redact_text
from app.core.util import utcnow
from app.db.models import TelegramContext, TelegramRequest
from app.security.ratelimit import RateLimiter
from app.telegram.client import Sender, split_message
from app.telegram.handlers import HANDLERS
from app.telegram.intents import route

log = logging.getLogger(__name__)
_limiter: RateLimiter | None = None


def limiter() -> RateLimiter:
    global _limiter
    if _limiter is None:
        _limiter = RateLimiter(get_settings().telegram_rate_limit_per_minute, 60)
    return _limiter


def _first_seen(db: Session, update_id: int) -> bool:
    res = db.execute(text("INSERT INTO telegram_updates (update_id, received_at) VALUES (:u, now()) ON CONFLICT DO NOTHING"),
                     {"u": update_id})
    return res.rowcount == 1


def handle_update(db: Session, update: dict[str, Any], sender: Sender) -> dict[str, Any]:
    started = time.monotonic()
    update_id = update.get("update_id")
    if not isinstance(update_id, int):
        return {"status": "ignored", "reason": "no update_id"}
    if not _first_seen(db, update_id):
        return {"status": "duplicate"}  # Telegram retry: never act twice
    msg = update.get("message") or update.get("edited_message")
    if not isinstance(msg, dict) or not isinstance(msg.get("from"), dict) or not isinstance(msg.get("chat"), dict):
        return {"status": "ignored", "reason": "unsupported update type"}
    user_id, chat_id = msg["from"].get("id"), msg["chat"].get("id")
    text_in = msg.get("text") or ""
    req = TelegramRequest(update_id=update_id, user_id=user_id or 0, chat_id=chat_id or 0, authorized=False,
                          text_preview=redact_text(text_in[:120]), status="received")
    db.add(req)

    # 1) authorization before any data access
    if user_id not in get_settings().telegram_allowlist:
        req.status = "unauthorized"
        audit(db, f"telegram:{user_id}", "telegram.unauthorized", str(chat_id), {"update_id": update_id})
        try:
            sender(chat_id, "Akses ditolak. Akun ini tidak terdaftar.")
        except Exception:  # noqa: BLE001
            pass
        return {"status": "unauthorized"}
    req.authorized = True
    # 2) rate limit
    if not limiter().allow(str(user_id)):
        req.status = "rate_limited"
        try:
            sender(chat_id, "Terlalu banyak permintaan. Coba lagi dalam satu menit.")
        except Exception:  # noqa: BLE001
            pass
        return {"status": "rate_limited"}
    if not text_in or len(text_in) > 2000:
        req.status = "rejected"
        sender(chat_id, "Pesan kosong atau terlalu panjang (maks 2000 karakter).")
        return {"status": "rejected"}

    # 3) per-user context only (keyed by user id; never shared across users)
    ctx = db.get(TelegramContext, user_id)
    intent = route(text_in, ctx.last_intent if ctx else None, ctx.last_symbol if ctx else None)
    req.intent = intent.name
    emit(db, "telegram.request", intent=intent.name)
    try:
        if intent.clarify:
            reply = intent.clarify
        else:
            reply = HANDLERS[intent.name](db, intent)
        # 4) response validation: no secrets, bounded length
        reply = redact_text(reply)
        parts = split_message(reply)
        if len(parts) > 5:
            reply = "\n".join(parts[:5])[:20000] + "\n\n(Dipotong: gunakan dashboard untuk detail lengkap.)"
        sender(chat_id, reply)
        req.status, req.response_chars = "answered", len(reply)
    except Exception as e:  # noqa: BLE001
        log.exception("telegram handler failed")
        req.status, req.error = "error", redact_text(f"{type(e).__name__}: {e}")[:500]
        try:
            sender(chat_id, "Maaf, terjadi kesalahan saat memproses permintaan. Kesalahan sudah dicatat.")
        except Exception:  # noqa: BLE001
            pass
    if not intent.clarify:
        ctx = ctx or TelegramContext(user_id=user_id)
        ctx.last_intent = intent.name
        ctx.last_symbol = intent.symbol or ctx.last_symbol
        ctx.last_timeframe = intent.timeframe or ctx.last_timeframe
        ctx.updated_at = utcnow()
        db.merge(ctx)
    req.latency_ms = int((time.monotonic() - started) * 1000)
    audit(db, f"telegram:{user_id}", "telegram.request", intent.name, {"status": req.status, "chars": req.response_chars})
    return {"status": req.status, "intent": intent.name}
