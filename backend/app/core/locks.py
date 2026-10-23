"""Duplicate-execution prevention using a committed row-level lease.

Locks are taken in their own short transaction so that a concurrent runner sees
them immediately, independent of the caller's (possibly long) transaction.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import timedelta

from sqlalchemy import delete, text

from app.core.util import utcnow
from app.db.models import JobLock
from app.db.session import session_scope


class LockHeld(Exception):
    pass


def acquire(key: str, owner: str, ttl_seconds: int) -> bool:
    now = utcnow()
    with session_scope() as db:
        db.execute(delete(JobLock).where(JobLock.key == key, JobLock.expires_at < now))
        res = db.execute(
            text(
                "INSERT INTO job_locks (key, owner, acquired_at, expires_at) VALUES (:k, :o, :n, :e) "
                "ON CONFLICT (key) DO NOTHING"
            ),
            {"k": key, "o": owner, "n": now, "e": now + timedelta(seconds=ttl_seconds)},
        )
        return res.rowcount == 1


def release(key: str, owner: str) -> None:
    with session_scope() as db:
        db.execute(delete(JobLock).where(JobLock.key == key, JobLock.owner == owner))


@contextmanager
def job_lock(key: str, owner: str, ttl_seconds: int) -> Iterator[None]:
    if not acquire(key, owner, ttl_seconds):
        raise LockHeld(key)
    try:
        yield
    finally:
        release(key, owner)
