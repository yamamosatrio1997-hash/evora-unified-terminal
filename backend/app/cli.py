"""Operational CLI: python -m app.cli <command>."""
from __future__ import annotations

import argparse
import json
import sys
import uuid

from sqlalchemy import select

from app.config import get_settings
from app.core.audit import audit
from app.core.logging import configure_logging
from app.db.models import User
from app.db.session import session_scope


def bootstrap_admin() -> str:
    """Create the first admin from ADMIN_BOOTSTRAP_USER/PASSWORD if no users exist."""
    from app.security.passwords import hash_password

    s = get_settings()
    with session_scope() as db:
        if db.scalar(select(User.id).limit(1)):
            return "users exist; nothing to do"
        pw = s.admin_bootstrap_password.get_secret_value()
        if not pw:
            return "ADMIN_BOOTSTRAP_PASSWORD not set; no admin created"
        db.add(User(username=s.admin_bootstrap_user, password_hash=hash_password(pw), role="admin"))
        audit(db, "system:bootstrap", "user.created", s.admin_bootstrap_user, {"role": "admin"})
        return f"admin '{s.admin_bootstrap_user}' created"


def seed_simulated(symbols: list[str], days: int = 400) -> dict:
    """Insert SIMULATED candles (labeled everywhere) for UI/demo and tests."""
    from app.data.ingest import persist_batch
    from app.data.simulated import synthetic_candles
    from app.data.types import SourceBatch

    out = {}
    with session_scope() as db:
        for i, sym in enumerate(symbols):
            for iv in ("1h", "4h", "1d"):
                b = SourceBatch(source="synthetic", candles=synthetic_candles(sym, iv, days, seed=100 + i))
                out[f"{sym}:{iv}"] = persist_batch(db, b)[0]
        audit(db, "system:cli", "data.seed_simulated", None, {"symbols": symbols, "rows": out})
    return out


def main(argv: list[str] | None = None) -> int:
    configure_logging(get_settings().log_level)
    p = argparse.ArgumentParser(prog="app.cli")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("bootstrap-admin")
    sp = sub.add_parser("seed-simulated")
    sp.add_argument("--symbols", default=",".join(get_settings().symbols))
    ip = sub.add_parser("ingest")
    ip.add_argument("--sources", default="")
    dp = sub.add_parser("debate")
    dp.add_argument("symbol")
    bp = sub.add_parser("backtest")
    bp.add_argument("symbol")
    bp.add_argument("--strategy", default="ema_trend")
    bp.add_argument("--interval", default="4h")
    sub.add_parser("verify-audit")
    a = p.parse_args(argv)

    if a.cmd == "bootstrap-admin":
        print(bootstrap_admin())
    elif a.cmd == "seed-simulated":
        print(json.dumps(seed_simulated([s.strip().upper() for s in a.symbols.split(",") if s.strip()])))
    elif a.cmd == "ingest":
        from app.data.ingest import run_ingestion

        with session_scope() as db:
            print(json.dumps(run_ingestion(db, [x for x in a.sources.split(",") if x] or None), default=str, indent=2))
    elif a.cmd == "debate":
        from app.debate.orchestrator import run_debate

        print(run_debate(a.symbol.upper(), "cli", f"cli:{uuid.uuid4()}"))
    elif a.cmd == "backtest":
        from app.quant.service import run_backtest_job, summarize_run

        with session_scope() as db:
            print(json.dumps(summarize_run(run_backtest_job(db, a.strategy, a.symbol.upper(), a.interval)), default=str, indent=2))
    elif a.cmd == "verify-audit":
        from app.core.audit import verify_chain

        with session_scope() as db:
            ok, bad = verify_chain(db)
            print(json.dumps({"ok": ok, "first_bad_id": bad}))
            return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
