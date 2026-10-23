"""Long-polling alternative to the webhook (for hosts without public HTTPS).

Run: python -m app.telegram.poller. Do not run while a webhook is set.
"""
from __future__ import annotations

import logging
import time

import httpx

from app.config import get_settings
from app.core.logging import configure_logging
from app.db.session import session_scope
from app.telegram.client import TelegramSender
from app.telegram.service import handle_update

log = logging.getLogger(__name__)


def main() -> None:
    s = get_settings()
    configure_logging(s.log_level)
    token = s.telegram_bot_token.get_secret_value()
    if not token:
        raise SystemExit("TELEGRAM_BOT_TOKEN not set")
    sender = TelegramSender()
    offset = 0
    with httpx.Client(timeout=40) as c:
        while True:
            try:
                r = c.get(f"{s.telegram_api_base}/bot{token}/getUpdates", params={"timeout": 30, "offset": offset})
                for upd in r.json().get("result", []):
                    offset = max(offset, upd["update_id"] + 1)
                    with session_scope() as db:
                        handle_update(db, upd, sender)
            except Exception as e:  # noqa: BLE001
                log.warning("poll error", extra={"ctx": {"error": type(e).__name__}})
                time.sleep(5)


if __name__ == "__main__":
    main()
