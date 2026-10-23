"""n8n monitoring.

Two sources, labeled separately in the UI:
  * callbacks: workflows POST their own outcome to /api/service/n8n/callback;
  * n8n public API (if N8N_API_KEY set): GET /api/v1/workflows and /api/v1/executions.
The n8n API key stays server-side; the browser only sees results.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.events import emit
from app.core.redact import redact_text
from app.core.util import utcnow
from app.db.models import WorkflowExecution


def record_callback(db: Session, payload: dict[str, Any]) -> WorkflowExecution | None:
    started = _dt(payload.get("started_at"))
    finished = _dt(payload.get("finished_at")) or utcnow()
    status = str(payload.get("status", "unknown"))[:32]
    vals = dict(workflow_id=str(payload.get("workflow_id", "unknown"))[:64], workflow_name=str(payload.get("workflow_name") or "")[:128] or None,
                execution_id=str(payload.get("execution_id", "unknown"))[:64], status=status, started_at=started, finished_at=finished,
                duration_ms=int((finished - started).total_seconds() * 1000) if started else None,
                error=redact_text(str(payload.get("error")))[:2000] if payload.get("error") else None, reported_by="callback")
    stmt = insert(WorkflowExecution).values(**vals).on_conflict_do_update(
        constraint="uq_wf_exec", set_={k: vals[k] for k in ("status", "finished_at", "duration_ms", "error")})
    db.execute(stmt)
    emit(db, "n8n.execution", workflow=vals["workflow_name"] or vals["workflow_id"], status=status)
    return db.scalar(select(WorkflowExecution).where(WorkflowExecution.workflow_id == vals["workflow_id"],
                                                     WorkflowExecution.execution_id == vals["execution_id"]))


def _dt(v: Any) -> datetime | None:
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def fetch_n8n_api(transport: httpx.BaseTransport | None = None) -> dict[str, Any]:
    s = get_settings()
    key = s.n8n_api_key.get_secret_value()
    if not key:
        return {"status": "not_configured", "detail": "N8N_API_KEY not set; showing callback reports only"}
    try:
        with httpx.Client(timeout=5, transport=transport, headers={"X-N8N-API-KEY": key}) as c:
            wf = c.get(f"{s.n8n_base_url}/api/v1/workflows", params={"limit": 100})
            ex = c.get(f"{s.n8n_base_url}/api/v1/executions", params={"limit": 50})
        if wf.status_code != 200 or ex.status_code != 200:
            return {"status": "error", "detail": f"n8n API HTTP {wf.status_code}/{ex.status_code}"}
        return {
            "status": "ok",
            "workflows": [{"id": w.get("id"), "name": w.get("name"), "active": w.get("active"), "updatedAt": w.get("updatedAt")}
                          for w in wf.json().get("data", [])],
            "executions": [{"id": e.get("id"), "workflowId": e.get("workflowId"), "status": e.get("status"),
                            "startedAt": e.get("startedAt"), "stoppedAt": e.get("stoppedAt"), "mode": e.get("mode")}
                           for e in ex.json().get("data", [])],
        }
    except httpx.HTTPError as e:
        return {"status": "unreachable", "detail": type(e).__name__}


def workflow_overview(db: Session, fetch_remote: bool = True) -> dict[str, Any]:
    rows = list(db.scalars(select(WorkflowExecution).order_by(WorkflowExecution.created_at.desc()).limit(200)))
    since = utcnow() - timedelta(hours=24)
    by: dict[str, dict[str, Any]] = {}
    for r in rows:
        w = by.setdefault(r.workflow_id, {"workflow_id": r.workflow_id, "workflow_name": r.workflow_name, "last_status": r.status,
                                          "last_at": (r.finished_at or r.created_at).isoformat(), "last_error": r.error,
                                          "runs_24h": 0, "errors_24h": 0, "durations": []})
        if r.created_at >= since:
            w["runs_24h"] += 1
            w["errors_24h"] += r.status == "error"
            if r.duration_ms is not None:
                w["durations"].append(r.duration_ms)
    for w in by.values():
        d = w.pop("durations")
        w["avg_duration_ms"] = int(sum(d) / len(d)) if d else None
    return {
        "by_workflow": sorted(by.values(), key=lambda x: x["last_at"], reverse=True),
        "recent": [{"workflow_id": r.workflow_id, "workflow_name": r.workflow_name, "execution_id": r.execution_id, "status": r.status,
                    "started_at": r.started_at.isoformat() if r.started_at else None, "finished_at": r.finished_at.isoformat() if r.finished_at else None,
                    "duration_ms": r.duration_ms, "error": r.error, "reported_by": r.reported_by} for r in rows[:50]],
        "remote": fetch_n8n_api() if fetch_remote else {"status": "skipped"},
    }
