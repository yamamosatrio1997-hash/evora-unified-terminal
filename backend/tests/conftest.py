from __future__ import annotations

import os

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://tcc:tcc@localhost:5432/tcc_test")
os.environ.setdefault("SERVICE_TOKEN", "test-service-token-" + "x" * 20)
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("TELEGRAM_ALLOWED_USER_IDS", "111,222")
os.environ.setdefault("TELEGRAM_WEBHOOK_SECRET", "tg-secret-for-tests")
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "123456789:AAtesttokentesttokentesttokentest00")
os.environ.setdefault("ADMIN_BOOTSTRAP_PASSWORD", "correct-horse-battery")

import pytest  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.config import reset_settings_cache  # noqa: E402
from app.db.session import get_engine, reset_engine_cache, session_scope  # noqa: E402

PRESERVE = {"alembic_version", "risk_state"}


@pytest.fixture(scope="session", autouse=True)
def _migrated():
    reset_settings_cache()
    reset_engine_cache()
    from alembic import command
    from alembic.config import Config

    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "alembic"))
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    yield


@pytest.fixture()
def db():
    """Clean tables before each DB test. TRUNCATE does not fire the row-level
    append-only triggers, so audit/risk tables can be reset in tests."""
    eng = get_engine()
    with eng.begin() as conn:
        tables = [r[0] for r in conn.execute(text("SELECT tablename FROM pg_tables WHERE schemaname='public'"))]
        for t in tables:
            if t not in PRESERVE:
                conn.execute(text(f'TRUNCATE "{t}" RESTART IDENTITY CASCADE'))
        conn.execute(text("UPDATE risk_state SET emergency_stop=false, reason=NULL"))
    with session_scope() as s:
        yield s
