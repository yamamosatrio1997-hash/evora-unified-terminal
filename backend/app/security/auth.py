"""Server-side sessions with HttpOnly cookies, role checks and service-token auth."""
from __future__ import annotations

import hmac
import secrets
from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.util import sha256_hex, utcnow
from app.db.models import User, UserSession
from app.db.session import get_db

COOKIE_NAME = "tcc_session"
ROLE_RANK = {"viewer": 0, "operator": 1, "admin": 2}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@dataclass
class Principal:
    username: str
    role: str
    user_id: int | None = None

    @property
    def actor(self) -> str:
        return f"user:{self.username}" if self.user_id else self.username


def create_session(db: Session, user: User) -> str:
    token = secrets.token_urlsafe(32)
    ttl = timedelta(hours=get_settings().session_ttl_hours)
    db.add(UserSession(token_hash=sha256_hex(token), user_id=user.id, expires_at=utcnow() + ttl))
    db.execute(delete(UserSession).where(UserSession.expires_at < utcnow()))
    db.flush()
    return token


def destroy_session(db: Session, token: str) -> None:
    db.execute(delete(UserSession).where(UserSession.token_hash == sha256_hex(token)))


def current_principal(request: Request, db: Annotated[Session, Depends(get_db)]) -> Principal:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not authenticated")
    # CSRF: cookies are SameSite=Strict, and state-changing requests must also carry
    # a custom header that cross-site forms cannot set without a CORS preflight.
    if request.method not in SAFE_METHODS and request.headers.get("x-requested-with") != "tcc":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "missing CSRF header")
    row = db.execute(
        select(UserSession, User)
        .join(User, User.id == UserSession.user_id)
        .where(UserSession.token_hash == sha256_hex(token))
    ).first()
    if not row:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session invalid")
    sess, user = row
    if sess.expires_at < utcnow() or user.disabled:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session expired")
    return Principal(username=user.username, role=user.role, user_id=user.id)


def require_role(min_role: str):
    def dep(p: Annotated[Principal, Depends(current_principal)]) -> Principal:
        if ROLE_RANK.get(p.role, -1) < ROLE_RANK[min_role]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"requires role {min_role}")
        return p

    return dep


def require_service(authorization: Annotated[str | None, Header()] = None) -> Principal:
    """Bearer token for n8n -> backend calls. Constant-time comparison."""
    expected = get_settings().service_token.get_secret_value()
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "service token not configured")
    supplied = (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid service token")
    return Principal(username="service:n8n", role="operator")


def principal_or_service(request: Request, db: Annotated[Session, Depends(get_db)], authorization: Annotated[str | None, Header()] = None) -> Principal:
    """Operator-level endpoints callable from either the dashboard or n8n."""
    if authorization:
        return require_service(authorization)
    p = current_principal(request, db)
    if ROLE_RANK.get(p.role, -1) < ROLE_RANK["operator"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "requires role operator")
    return p


Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Operator = Annotated[Principal, Depends(require_role("operator"))]
Admin = Annotated[Principal, Depends(require_role("admin"))]
Service = Annotated[Principal, Depends(require_service)]
OperatorOrService = Annotated[Principal, Depends(principal_or_service)]
DB = Annotated[Session, Depends(get_db)]
