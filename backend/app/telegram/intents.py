"""Deterministic intent routing for Indonesian/English requests."""
from __future__ import annotations

import re
from dataclasses import dataclass

COMMANDS = {
    "start", "help", "status", "market", "btc", "eth", "portfolio", "performance", "risk", "onchain", "technical",
    "quant", "backtest", "agents", "debate", "n8n", "paper", "mexc", "report",
}
AGENT_ALIASES = {
    "macro": "macro", "makro": "macro", "fundamental": "fundamental", "on-chain": "onchain", "onchain": "onchain",
    "whale": "flow", "flow": "flow", "technical": "technical", "teknikal": "technical", "quant": "quant",
    "risk manager": "risk", "risk": "risk", "risiko": "risk", "critic": "critic", "reviewer": "critic", "fund manager": "fund_manager",
    # mascot names
    "atlas": "macro", "sage": "fundamental", "cipher": "onchain", "vortex": "flow", "chronos": "technical",
    "alpha": "quant", "sentinel": "risk", "killjoy": "critic", "odin": "fund_manager",
}


@dataclass
class Intent:
    name: str
    symbol: str | None = None
    timeframe: str | None = None
    period: str | None = None
    agents: tuple[str, ...] = ()
    clarify: str | None = None


def extract_symbol(t: str) -> str | None:
    if re.search(r"\b(btc|bitcoin)\b", t):
        return "BTCUSDT"
    if re.search(r"\b(eth|ethereum)\b", t):
        return "ETHUSDT"
    return None


def extract_timeframe(t: str) -> str | None:
    m = re.search(r"\b(1|4)\s*(jam|j|h|hour|hours)\b", t)
    if m:
        return f"{m.group(1)}h"
    if re.search(r"\b(harian|daily|1d|1 hari)\b", t):
        return "1d"
    return None


def extract_period(t: str) -> str:
    if re.search(r"minggu|pekan|week", t):
        return "week"
    if re.search(r"bulan|month", t):
        return "month"
    return "today" if re.search(r"hari ini|today", t) else "all"


def route(text: str, last_intent: str | None = None, last_symbol: str | None = None) -> Intent:
    raw = (text or "").strip()
    t = raw.lower()
    sym = extract_symbol(t)
    tf = extract_timeframe(t)
    if t.startswith("/"):
        cmd = t[1:].split()[0].split("@")[0]
        if cmd not in COMMANDS:
            return Intent("help")
        if cmd in ("btc", "eth"):
            return Intent("symbol", symbol=f"{cmd.upper()}USDT")
        if cmd == "technical":
            s = sym or last_symbol
            if not s:
                return Intent("technical", clarify="Aset mana yang ingin dianalisis: BTC atau ETH? Contoh: /technical btc 4h")
            return Intent("technical", symbol=s, timeframe=tf or "4h")
        if cmd == "performance":
            return Intent("performance", period=extract_period(t) if len(t.split()) > 1 else "all")
        return Intent(cmd if cmd != "start" else "help", symbol=sym)

    # Requests that must never be actioned from chat.
    if re.search(r"\b(beli|jual|buy|sell|eksekusi|execute|pasang order|open posisi|buka posisi|tutup posisi|withdraw|tarik dana)\b", t):
        return Intent("refuse_order")
    if re.search(r"\b(ubah|ganti|naikkan|turunkan|set|matikan|nonaktifkan)\b.*\b(risiko|risk|limit|leverage|izin|permission|setting|pengaturan|emergency)\b", t):
        return Intent("refuse_settings")

    if re.search(r"bandingkan|compare|banding", t):
        found = []
        for alias, role in sorted(AGENT_ALIASES.items(), key=lambda kv: -len(kv[0])):
            if alias in t and role not in found:
                found.append(role)
                t_masked = t.replace(alias, " ")
                t = t_masked
        if len(found) >= 2:
            return Intent("compare", agents=tuple(found[:2]))
        return Intent("compare", clarify="Agen mana yang ingin dibandingkan? Contoh: bandingkan Technical Analyst dan Quant Researcher.")
    if re.search(r"(kenapa|mengapa|why).*(tolak|menolak|veto|reject)", t):
        return Intent("why_veto")
    if re.search(r"laporan|report", t):
        return Intent("report", period=extract_period(t))
    if "drawdown" in t or re.search(r"performa|performance|kinerja", t):
        return Intent("performance", period=extract_period(t))
    if re.search(r"teknikal|technical|analisis\s+(btc|eth|bitcoin|ethereum)", t):
        s = sym or last_symbol
        if not s:
            return Intent("technical", clarify="Aset mana yang ingin dianalisis: BTC atau ETH?")
        return Intent("technical", symbol=s, timeframe=tf or "4h")
    if re.search(r"on-?chain", t):
        return Intent("onchain", symbol=sym)
    if "backtest" in t:
        return Intent("backtest", symbol=sym)
    if "mexc" in t:
        return Intent("mexc")
    if re.search(r"status", t) and re.search(r"agen|agent|n8n|workflow|semua", t):
        return Intent("agents_and_n8n")
    if re.search(r"n8n|workflow", t):
        return Intent("n8n")
    if re.search(r"agen|agent", t):
        return Intent("agents")
    if re.search(r"ringkas|ringkasan|kondisi pasar|pasar|market|summary", t):
        return Intent("market")
    if re.search(r"portofolio|portfolio|posisi", t):
        return Intent("portfolio")
    if re.search(r"debat|debate|keputusan|decision", t):
        return Intent("debate", symbol=sym)
    if re.search(r"risiko|risk", t):
        return Intent("risk")
    # Follow-up: "bagaimana dengan ETH?" repeats the previous symbol-based intent.
    if sym and last_intent in ("technical", "symbol", "onchain", "debate", "backtest"):
        return Intent(last_intent, symbol=sym, timeframe=tf or ("4h" if last_intent == "technical" else None))
    if sym:
        return Intent("symbol", symbol=sym)
    return Intent("help", clarify="Maaf, saya belum memahami permintaan itu. Ketik /help untuk daftar perintah.")
