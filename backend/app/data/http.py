"""HTTP fetching with timeouts, bounded retries, exponential backoff with jitter,
and explicit handling of rate-limit responses (429 / 418 / Retry-After)."""
from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)

RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


class FetchError(Exception):
    def __init__(self, message: str, *, status: int | None = None, retryable: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.retryable = retryable


@dataclass
class FetchResult:
    data: Any
    status: int
    latency_ms: int
    headers: dict[str, str] = field(default_factory=dict)


class HttpFetcher:
    """Thin wrapper so tests can inject an httpx.MockTransport."""

    def __init__(self, transport: httpx.BaseTransport | None = None, sleep=time.sleep) -> None:
        s = get_settings()
        self._client = httpx.Client(
            timeout=s.http_timeout_seconds,
            transport=transport,
            headers={"User-Agent": "ai-trading-command-center/0.1"},
        )
        self._max_retries = s.http_max_retries
        self._sleep = sleep

    def get_json(self, url: str, *, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> FetchResult:
        attempt = 0
        while True:
            started = time.monotonic()
            try:
                resp = self._client.get(url, params=params, headers=headers)
            except httpx.TimeoutException as e:
                err = FetchError(f"timeout: {type(e).__name__}", retryable=True)
            except httpx.TransportError as e:
                err = FetchError(f"transport error: {type(e).__name__}", retryable=True)
            else:
                latency = int((time.monotonic() - started) * 1000)
                if resp.status_code == 418:
                    # Binance: IP auto-banned after ignoring 429s. Retrying makes it worse.
                    raise FetchError("HTTP 418: IP banned by upstream", status=418)
                if resp.status_code == 451:
                    raise FetchError("HTTP 451: unavailable from this region", status=451)
                if resp.status_code in RETRYABLE_STATUS:
                    err = FetchError(f"HTTP {resp.status_code}", status=resp.status_code, retryable=True)
                    retry_after = resp.headers.get("retry-after")
                    if retry_after and retry_after.isdigit() and int(retry_after) > 60:
                        raise FetchError(f"HTTP {resp.status_code}; retry-after {retry_after}s exceeds budget", status=resp.status_code)
                elif resp.status_code >= 400:
                    raise FetchError(f"HTTP {resp.status_code}", status=resp.status_code)
                else:
                    try:
                        data = resp.json()
                    except ValueError as e:
                        raise FetchError("response is not valid JSON", status=resp.status_code) from e
                    return FetchResult(data=data, status=resp.status_code, latency_ms=latency, headers=dict(resp.headers))
            attempt += 1
            if attempt > self._max_retries or not err.retryable:
                raise err
            delay = min(30.0, (2 ** (attempt - 1)) + random.uniform(0, 0.5))
            log.warning("retrying fetch", extra={"ctx": {"host": httpx.URL(url).host, "attempt": attempt, "error": str(err)}})
            self._sleep(delay)

    def close(self) -> None:
        self._client.close()
