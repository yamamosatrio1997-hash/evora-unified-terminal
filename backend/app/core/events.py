"""System events: the single source of truth for live dashboard activity."""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.core.util import jsonable
from app.db.models import SystemEvent


def emit(db: Session, type_: str, *, agent: str | None = None, session_id: uuid.UUID | None = None, **payload: Any) -> SystemEvent:
    ev = SystemEvent(type=type_, agent=agent, session_id=session_id, payload=jsonable(payload))
    db.add(ev)
    db.flush()
    return ev
