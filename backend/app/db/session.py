from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings


@lru_cache
def get_engine() -> Engine:
    s = get_settings()
    # Small pool: the target VPS has 2 vCPU / 4 GB and n8n shares the database server.
    return create_engine(s.database_url, pool_size=5, max_overflow=5, pool_pre_ping=True, pool_recycle=1800)


@lru_cache
def _factory() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False)


@contextmanager
def session_scope() -> Iterator[Session]:
    db = _factory()()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def get_db() -> Iterator[Session]:
    """FastAPI dependency."""
    with session_scope() as db:
        yield db


def reset_engine_cache() -> None:
    get_engine.cache_clear()
    _factory.cache_clear()
