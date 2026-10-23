"""Append-only, hash-chained audit log."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.redact import redact
from app.core.util import canonical_json, jsonable, sha256_hex, utcnow
from app.db.models import AuditLog

GENESIS = "0" * 64


def audit(db: Session, actor: str, action: str, target: str | None = None, details: dict[str, Any] | None = None) -> AuditLog:
    # Serialize chain appends so concurrent writers cannot fork the chain.
    db.execute(text("SELECT pg_advisory_xact_lock(727001)"))
    prev = db.scalar(select(AuditLog.hash).order_by(AuditLog.id.desc()).limit(1)) or GENESIS
    clean = jsonable(redact(details or {}))
    ts = utcnow()
    digest = sha256_hex(canonical_json({"prev": prev, "ts": ts, "actor": actor, "action": action, "target": target, "details": clean}))
    row = AuditLog(ts=ts, actor=actor, action=action, target=target, details=clean, prev_hash=prev, hash=digest)
    db.add(row)
    db.flush()
    return row


def verify_chain(db: Session) -> tuple[bool, int | None]:
    """Return (ok, first_bad_id)."""
    prev = GENESIS
    for row in db.scalars(select(AuditLog).order_by(AuditLog.id)):
        expected = sha256_hex(canonical_json({
            "prev": prev, "ts": row.ts, "actor": row.actor, "action": row.action,
            "target": row.target, "details": row.details,
        }))
        if row.prev_hash != prev or row.hash != expected:
            return False, row.id
        prev = row.hash
    return True, None
