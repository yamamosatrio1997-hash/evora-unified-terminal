"""Causal technical indicators: the value at index t uses only data at or before t.

Leading values without enough history are NaN, never back-filled.
"""
from __future__ import annotations

import numpy as np

Arr = np.ndarray


def sma(x: Arr, n: int) -> Arr:
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        c = np.cumsum(np.insert(x.astype(float), 0, 0.0))
        out[n - 1:] = (c[n:] - c[:-n]) / n
    return out


def ema(x: Arr, n: int) -> Arr:
    out = np.full(len(x), np.nan)
    if len(x) < n:
        return out
    alpha = 2.0 / (n + 1)
    out[n - 1] = np.mean(x[:n])
    for i in range(n, len(x)):
        out[i] = alpha * x[i] + (1 - alpha) * out[i - 1]
    return out


def _wilder(x: Arr, n: int, start: int) -> Arr:
    """Wilder smoothing seeded with the simple mean of x[start:start+n]."""
    out = np.full(len(x), np.nan)
    if len(x) < start + n:
        return out
    out[start + n - 1] = np.mean(x[start:start + n])
    for i in range(start + n, len(x)):
        out[i] = (out[i - 1] * (n - 1) + x[i]) / n
    return out


def rsi(close: Arr, n: int = 14) -> Arr:
    out = np.full(len(close), np.nan)
    if len(close) <= n:
        return out
    d = np.diff(close.astype(float), prepend=np.nan)
    gain = np.where(d > 0, d, 0.0)
    loss = np.where(d < 0, -d, 0.0)
    ag = _wilder(gain, n, 1)
    al = _wilder(loss, n, 1)
    with np.errstate(divide="ignore", invalid="ignore"):
        rs = ag / al
        out = 100 - 100 / (1 + rs)
    out = np.where((al == 0) & ~np.isnan(ag), 100.0, out)
    return out


def macd(close: Arr, fast: int = 12, slow: int = 26, signal: int = 9) -> tuple[Arr, Arr, Arr]:
    line = ema(close, fast) - ema(close, slow)
    sig = np.full(len(close), np.nan)
    valid = ~np.isnan(line)
    if valid.sum() >= signal:
        first = int(np.argmax(valid))
        sig[first:] = ema(line[first:], signal)
    return line, sig, line - sig


def true_range(high: Arr, low: Arr, close: Arr) -> Arr:
    prev = np.roll(close, 1)
    tr = np.maximum(high - low, np.maximum(np.abs(high - prev), np.abs(low - prev)))
    tr[0] = high[0] - low[0]
    return tr


def atr(high: Arr, low: Arr, close: Arr, n: int = 14) -> Arr:
    return _wilder(true_range(high, low, close), n, 0)


def bollinger(close: Arr, n: int = 20, k: float = 2.0) -> tuple[Arr, Arr, Arr]:
    mid = sma(close, n)
    sd = np.full(len(close), np.nan)
    for i in range(n - 1, len(close)):
        sd[i] = np.std(close[i - n + 1:i + 1])
    return mid - k * sd, mid, mid + k * sd


def rolling_max(x: Arr, n: int) -> Arr:
    out = np.full(len(x), np.nan)
    for i in range(n - 1, len(x)):
        out[i] = np.max(x[i - n + 1:i + 1])
    return out


def rolling_min(x: Arr, n: int) -> Arr:
    out = np.full(len(x), np.nan)
    for i in range(n - 1, len(x)):
        out[i] = np.min(x[i - n + 1:i + 1])
    return out


def realized_vol(close: Arr, n: int, periods_per_year: float) -> Arr:
    r = np.diff(np.log(close.astype(float)), prepend=np.nan)
    out = np.full(len(close), np.nan)
    for i in range(n, len(close)):
        out[i] = np.std(r[i - n + 1:i + 1], ddof=1) * np.sqrt(periods_per_year)
    return out
