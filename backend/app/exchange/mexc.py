"""MEXC read-only integration.

Signing follows MEXC's published schemes (not verifiable from the build
environment, where MEXC hosts are blocked):
  * Spot v3: HMAC-SHA256(secret, query_string) appended as `signature`,
    API key in header `X-MEXC-APIKEY`, `timestamp` (ms) and `recvWindow` params.
  * Futures (contract) v1 private: HMAC-SHA256(secret, access_key + request_time +
    param_string), headers `ApiKey`, `Request-Time`, `Signature`. For GET the
    param string is the sorted query string.

Only GET endpoints for account state and public contract details are
implemented. Withdrawal and trading endpoints are deliberately absent; the API
key should be created with read-only permission and IP-restricted.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from urllib.parse import urlencode

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.events import emit
from app.core.redact import redact_text
from app.core.util import jsonable, to_decimal, utcnow
from app.db.models import ExchangeSnapshot
from app.risk.engine import ContractSpec


class MexcError(Exception):
    pass


class MexcNotConfigured(MexcError):
    pass


def sign_spot(secret: str, params: dict[str, Any]) -> str:
    return hmac.new(secret.encode(), urlencode(params).encode(), hashlib.sha256).hexdigest()


def sign_futures(secret: str, access_key: str, request_time: str, param_string: str) -> str:
    return hmac.new(secret.encode(), f"{access_key}{request_time}{param_string}".encode(), hashlib.sha256).hexdigest()


class MexcReadOnlyClient:
    def __init__(self, transport: httpx.BaseTransport | None = None, clock=time.time) -> None:
        s = get_settings()
        self._key = s.mexc_api_key.get_secret_value()
        self._secret = s.mexc_api_secret.get_secret_value()
        self._spot = s.mexc_spot_base_url
        self._fut = s.mexc_futures_base_url
        self._clock = clock
        self._http = httpx.Client(timeout=s.http_timeout_seconds, transport=transport)

    @property
    def configured(self) -> bool:
        return bool(self._key and self._secret)

    def _ms(self) -> str:
        return str(int(self._clock() * 1000))

    def _get(self, url: str, **kw: Any) -> Any:
        try:
            r = self._http.get(url, **kw)
        except httpx.HTTPError as e:
            raise MexcError(f"transport error: {type(e).__name__}") from e
        if r.status_code != 200:
            raise MexcError(f"HTTP {r.status_code}: {redact_text(r.text[:200])}")
        return r.json()

    def spot_account(self) -> dict[str, Any]:
        if not self.configured:
            raise MexcNotConfigured("MEXC_API_KEY/MEXC_API_SECRET not set")
        params: dict[str, Any] = {"timestamp": self._ms(), "recvWindow": 5000}
        params["signature"] = sign_spot(self._secret, params)
        return self._get(f"{self._spot}/api/v3/account", params=params, headers={"X-MEXC-APIKEY": self._key})

    def _futures_private(self, path: str, params: dict[str, Any] | None = None) -> Any:
        if not self.configured:
            raise MexcNotConfigured("MEXC_API_KEY/MEXC_API_SECRET not set")
        params = {k: v for k, v in (params or {}).items() if v is not None}
        ps = urlencode(sorted(params.items()))
        ts = self._ms()
        headers = {"ApiKey": self._key, "Request-Time": ts, "Signature": sign_futures(self._secret, self._key, ts, ps),
                   "Content-Type": "application/json"}
        body = self._get(f"{self._fut}{path}", params=params, headers=headers)
        if isinstance(body, dict) and body.get("success") is False:
            raise MexcError(f"MEXC error code {body.get('code')}: {body.get('message')}")
        return body

    def futures_assets(self) -> Any:
        return self._futures_private("/api/v1/private/account/assets")

    def futures_open_positions(self) -> Any:
        return self._futures_private("/api/v1/private/position/open_positions")

    def contract_detail(self, symbol: str) -> Any:
        """Public endpoint; no key needed."""
        return self._get(f"{self._fut}/api/v1/contract/detail", params={"symbol": symbol})

    def close(self) -> None:
        self._http.close()


def to_mexc_contract(symbol: str) -> str:
    return symbol.replace("USDT", "_USDT") if "_" not in symbol else symbol


def parse_contract_spec(symbol: str, payload: Any) -> ContractSpec | None:
    """Map /api/v1/contract/detail to a ContractSpec. Returns None (=> risk engine
    rejects with UNKNOWN_CONTRACT) if any required field is missing."""
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None
    mult = to_decimal(data.get("contractSize"))
    vol_unit = to_decimal(data.get("volUnit"))
    min_vol = to_decimal(data.get("minVol"))
    tick = to_decimal(data.get("priceUnit"))
    max_lev = to_decimal(data.get("maxLeverage"))
    taker = to_decimal(data.get("takerFeeRate"))
    mmr = to_decimal(data.get("maintenanceMarginRate"))
    if None in (mult, vol_unit, min_vol, tick, max_lev, taker):
        return None
    return ContractSpec(symbol, "linear", mult, vol_unit, min_vol, tick, max_lev, taker, mmr or Decimal("0.005"), source="mexc_contract_detail")


def _balances(spot: dict[str, Any]) -> list[dict[str, str]]:
    out = []
    for b in spot.get("balances", []) if isinstance(spot, dict) else []:
        free, locked = to_decimal(b.get("free")) or 0, to_decimal(b.get("locked")) or 0
        if free or locked:
            out.append({"asset": str(b.get("asset")), "free": str(free), "locked": str(locked)})
    return out


def sync_account(db: Session, client: MexcReadOnlyClient | None = None) -> dict[str, Any]:
    """Fetch read-only account state and store snapshots (actual exchange data,
    kept separate from paper data)."""
    own = client is None
    client = client or MexcReadOnlyClient()
    results: dict[str, Any] = {}
    try:
        for kind, fn, shape in (
            ("spot_account", client.spot_account, lambda p: {"balances": _balances(p), "permissions": p.get("permissions"),
                                                             "canTrade": p.get("canTrade"), "canWithdraw": p.get("canWithdraw")}),
            ("futures_assets", client.futures_assets, lambda p: {"assets": p.get("data")}),
            ("futures_positions", client.futures_open_positions, lambda p: {"positions": p.get("data")}),
        ):
            try:
                payload = shape(fn())
                db.add(ExchangeSnapshot(exchange="mexc", kind=kind, status="ok", payload=jsonable(payload)))
                results[kind] = {"status": "ok"}
                if kind == "spot_account" and payload.get("canWithdraw"):
                    results[kind]["warning"] = "API key has withdrawal permission; create a read-only key."
            except MexcNotConfigured as e:
                db.add(ExchangeSnapshot(exchange="mexc", kind=kind, status="unconfigured", error=str(e)))
                results[kind] = {"status": "unconfigured"}
            except MexcError as e:
                db.add(ExchangeSnapshot(exchange="mexc", kind=kind, status="error", error=redact_text(str(e))[:500]))
                results[kind] = {"status": "error", "error": redact_text(str(e))[:200]}
        db.flush()
        emit(db, "mexc.sync", results={k: v["status"] for k, v in results.items()})
    finally:
        if own:
            client.close()
    return results


def status(db: Session) -> dict[str, Any]:
    s = get_settings()
    latest = {}
    for kind in ("spot_account", "futures_assets", "futures_positions"):
        row = db.scalar(select(ExchangeSnapshot).where(ExchangeSnapshot.exchange == "mexc", ExchangeSnapshot.kind == kind)
                        .order_by(ExchangeSnapshot.fetched_at.desc()).limit(1))
        if row:
            age = (utcnow() - row.fetched_at).total_seconds()
            latest[kind] = {"status": row.status, "fetched_at": row.fetched_at.isoformat(), "age_seconds": int(age),
                            "stale": age > 900, "error": row.error, "payload": row.payload if row.status == "ok" else None}
        else:
            latest[kind] = {"status": "never_synced"}
    return {
        "configured": s.mexc_configured,
        "mode": "read_only",
        "live_trading_enabled": False,
        "execution": "disabled (no order submission path is enabled)",
        "data_kind": "ACTUAL exchange data (never merged with paper results)",
        "snapshots": latest,
        "verified_against_live_api": False,
        "verification_note": "Signing and endpoints follow MEXC documentation but have not been exercised against the live API from this environment.",
        "as_of": datetime.now(UTC).isoformat(),
    }
