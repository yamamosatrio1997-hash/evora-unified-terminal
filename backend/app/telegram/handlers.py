"""Telegram responses (Indonesian). Every number comes from persisted backend data
or deterministic calculation; missing data is stated, never filled in."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.agents.schemas import AGENT_NAMES
from app.agents.technical import tf_analysis
from app.core.util import utcnow
from app.data.snapshot import latest_candles
from app.exchange import mexc
from app.paper.engine import get_account, open_positions, performance
from app.quant.service import summarize_run
from app.services import queries
from app.telegram.intents import Intent

DISCLAIMER = "Mode: RISET/PAPER. Bukan saran keuangan. Tidak ada order live."


def _ts() -> str:
    return utcnow().strftime("%Y-%m-%d %H:%M UTC")


def _pct(x: Any) -> str:
    try:
        return f"{float(x) * 100:.2f}%"
    except (TypeError, ValueError):
        return "n/a"


def _sim(flag: bool) -> str:
    return " [DATA SIMULASI]" if flag else ""


def h_help(db: Session, it: Intent) -> str:
    return (
        "Halo, saya Fund Manager AI (asisten AI, bukan manusia) untuk sistem riset trading ini.\n\n"
        "Perintah: /status /market /btc /eth /portfolio /performance /risk /onchain /technical /quant /backtest "
        "/agents /debate /n8n /paper /mexc /report\n\n"
        "Anda juga bisa bertanya bebas, misalnya: \"Analisis teknikal BTC timeframe 4 jam\" atau "
        "\"Kenapa Risk Manager menolak trade terakhir?\"\n\n" + DISCLAIMER
    )


def h_status(db: Session, it: Intent) -> str:
    st = queries.system_status(db)
    src = ", ".join(f"{x['source']}={x['status']}" for x in st["sources"])
    return (f"Status sistem per {_ts()}\nMode: {st['mode']} | Emergency stop: {'AKTIF' if st['emergency_stop'] else 'tidak aktif'}\n"
            f"Database: {st['database']} | LLM: {st['llm']} | MEXC: {st['mexc']} | n8n API: {st['n8n_api']}\n"
            f"Sumber data: {src}\nSeri data basi: {len(st['stale_series'])} dari {st['series_tracked']}"
            f"{' | ADA DATA SIMULASI' if st['simulated_data_present'] else ''}\n"
            f"Error workflow 24 jam: {st['workflow_errors_24h']}")


def h_symbol(db: Session, it: Intent) -> str:
    m = queries.market_snapshot(db, it.symbol or "BTCUSDT")
    if m["price"] is None:
        return f"Belum ada data harga untuk {it.symbol}. Ingestion data mungkin belum berjalan atau sumber tidak dapat dijangkau."
    lines = [f"{m['symbol']}{_sim(m.get('simulated', False))}",
             f"Harga (close 1h terakhir): {float(m['price']):,.2f} pada {m['price_time'][:16]} UTC, sumber {m['price_source']}"
             f"{' — DATA BASI' if m['age_seconds'] > 7200 else ''}"]
    if m.get("change_24h_pct") is not None:
        lines.append(f"Perubahan 24 jam: {_pct(m['change_24h_pct'])}")
    for k, v in m["metrics"].items():
        lines.append(f"{k}: {v['value']} {v['unit']} ({v['source']}, {v['observed_at'][:16]})")
    if not m["metrics"]:
        lines.append("Funding rate / open interest: belum tersedia.")
    return "\n".join(lines)


def h_market(db: Session, it: Intent) -> str:
    parts = [f"Ringkasan pasar per {_ts()}"]
    for sym in ("BTCUSDT", "ETHUSDT"):
        parts.append(h_symbol(db, Intent("symbol", symbol=sym)))
    ctx = queries.market_context(db)
    avail = [f"{k.split(':')[1]}: {v['value']} ({v['source']}, {v['observed_at'][:10]})" for k, v in ctx.items() if v]
    parts.append("Konteks: " + ("; ".join(avail) if avail else "belum ada data makro/sentimen."))
    reg = queries.market_regime(db)
    parts.append(f"Rezim (dari analisis teknikal terakhir): {reg['label']} — dasar: {reg['basis']}")
    return "\n\n".join(parts)


def _period_start(period: str | None):
    now = utcnow()
    return {"today": now.replace(hour=0, minute=0, second=0, microsecond=0),
            "week": now - timedelta(days=7), "month": now - timedelta(days=30)}.get(period or "all")


def h_performance(db: Session, it: Intent) -> str:
    since = _period_start(it.period)
    p = performance(db, since=since)
    label = {"today": "hari ini", "week": "7 hari terakhir", "month": "30 hari terakhir"}.get(it.period or "", "sejak awal")
    if p["trades"] == 0 and not p["equity_curve"]:
        return (f"Belum ada catatan paper trading ({label}). Tidak ada angka performa yang bisa dilaporkan.\n"
                f"Jenis data: {p['data_kind']}.")
    return (f"Performa portofolio PAPER ({label}) per {_ts()}\n"
            f"Ekuitas awal: {float(p['starting_equity']):,.2f} | Ekuitas kini: {float(p['equity']):,.2f} | Return: {_pct(p['return_pct'])}\n"
            f"P&L terealisasi: {float(p['realized_pnl']):,.2f} | Belum terealisasi: {float(p['unrealized_pnl']):,.2f} | Biaya: {float(p['fees']):,.2f}\n"
            f"Drawdown saat ini: {_pct(p['current_drawdown'])} | Drawdown maks periode: {_pct(p['max_drawdown_period'])}\n"
            f"Trade selesai: {p['trades']} | Win rate: {_pct(p['win_rate']) if p['win_rate'] is not None else 'n/a'} | "
            f"Profit factor: {p['profit_factor'] if p['profit_factor'] is not None else 'n/a'} | Expectancy: {p['expectancy'] or 'n/a'}\n"
            f"Posisi terbuka: {p['open_positions']} | Eksposur notional: {float(p['exposure_notional']):,.2f}\n"
            f"Metodologi: {p['methodology']}\nJenis data: {p['data_kind']} — bukan saldo exchange."
            + ("\nCatatan: sampel trade kecil, metrik belum bermakna secara statistik." if 0 < p["trades"] < 30 else "")
            + (f"\nPeringatan: harga mark basi untuk {p['stale_marks']}." if p["stale_marks"] else ""))


def h_portfolio(db: Session, it: Intent) -> str:
    text = h_performance(db, Intent("performance", period="all"))
    ms = mexc.status(db)
    sa = ms["snapshots"].get("spot_account", {})
    if not ms["configured"]:
        text += "\n\nAkun MEXC (data AKTUAL): belum dikonfigurasi."
    elif sa.get("status") == "ok":
        bals = ", ".join(f"{b['asset']} {b['free']}" for b in (sa.get("payload") or {}).get("balances", [])[:8]) or "kosong"
        text += f"\n\nAkun MEXC (data AKTUAL, terpisah dari paper) per {sa['fetched_at'][:16]}{' — BASI' if sa['stale'] else ''}: {bals}"
    else:
        text += f"\n\nAkun MEXC: status sinkronisasi {sa.get('status')}."
    return text


def h_risk(db: Session, it: Intent) -> str:
    from app.config import get_settings
    from app.paper.engine import portfolio_state

    s = get_settings()
    pf = portfolio_state(db, get_account(db))
    veto = queries.latest_veto(db)
    lines = [f"Status risiko per {_ts()}",
             f"Batas risiko per trade (plafon keras): {_pct(s.max_planned_risk_per_trade)} | default: {_pct(s.default_risk_per_trade)}",
             f"Batas kerugian harian: {_pct(s.max_daily_loss)} | Halt drawdown: {_pct(s.max_drawdown_halt)} | Leverage maks: {s.max_leverage}x",
             f"Emergency stop: {'AKTIF' if pf.emergency_stop else 'tidak aktif'}",
             f"Ekuitas paper: {float(pf.equity):,.2f} | P&L terealisasi hari ini: {float(pf.realized_pnl_today):,.2f} | Posisi terbuka: {len(pf.open_positions)}"]
    if veto:
        lines.append(f"Veto terakhir ({veto['created_at'][:16]}, {veto['symbol']}): {'; '.join(veto['reasons'][:3])}")
    lines.append("Catatan: risiko terencana adalah estimasi; kerugian nyata bisa lebih besar karena gap, slippage, likuidasi, atau gangguan.")
    return "\n".join(lines)


def h_why_veto(db: Session, it: Intent) -> str:
    v = queries.latest_veto(db)
    if v is None:
        return "Belum ada trade yang ditolak Risk Manager dalam catatan."
    p = v.get("proposal") or {}
    return (f"Penolakan terakhir oleh Risk Manager (#{v['id']}, {v['created_at'][:16]} UTC, {v['symbol']}):\n"
            + "\n".join(f"- {r}" for r in v["reasons"])
            + f"\nProposal: {p.get('side')} entry {p.get('entry_price')} stop {p.get('stop_loss')}"
            + "\nVeto Risk Manager bersifat final dan tidak dapat dibatalkan oleh Fund Manager atau LLM.")


def _agent_line(a: dict[str, Any]) -> str:
    la = a["last_analysis"]
    if not la:
        return f"- {a['name']}: belum pernah berjalan"
    return f"- {a['name']}: {la['status']}, sikap {la['stance']} ({la['created_at'][:16]}) — {la['conclusion'][:160]}"


def h_agents(db: Session, it: Intent) -> str:
    return f"Status agen per {_ts()}\n" + "\n".join(_agent_line(a) for a in queries.agent_statuses(db))


def h_agent_role(db: Session, role: str, title: str) -> str:
    a = next(x for x in queries.agent_statuses(db) if x["role"] == role)
    la = a["last_analysis"]
    if not la:
        return f"{title}: belum ada analisis."
    missing = "; ".join(la["missing_data"]) or "tidak ada"
    return (f"{title} — analisis {la['created_at'][:16]} UTC (sesi {la['session_id'][:8]})\nStatus: {la['status']} | Sikap: {la['stance']}\n"
            f"{la['conclusion']}\nData yang tidak tersedia: {missing}")


def h_onchain(db: Session, it: Intent) -> str:
    return h_agent_role(db, "onchain", "On-Chain Analyst")


def h_quant(db: Session, it: Intent) -> str:
    return h_agent_role(db, "quant", "Quant Researcher")


def h_technical(db: Session, it: Intent) -> str:
    sym, tf = it.symbol or "BTCUSDT", it.timeframe or "4h"
    rows = latest_candles(db, sym, tf, 300)
    if not rows:
        return f"Belum ada data candle {tf} untuk {sym}; analisis teknikal tidak bisa dibuat."
    a = tf_analysis([[r.open_time.isoformat(), r.open, r.high, r.low, r.close, r.volume] for r in rows])
    if a is None:
        return f"Data candle {tf} {sym} belum cukup ({len(rows)} bar; butuh >= 210)."
    stale = (utcnow() - rows[-1].close_time).total_seconds() > 2 * {"1h": 3600, "4h": 14400, "1d": 86400}[tf] + 120
    return (f"Analisis teknikal {sym} {tf}{_sim(rows[-1].quality == 'simulated')} — candle tertutup terakhir {a['time'][:16]} UTC, "
            f"sumber {rows[-1].source}{' — DATA BASI' if stale else ''}\n"
            f"Close: {a['close']:,.2f} | Tren (EMA20/50/200): {a['trend']}\n"
            f"EMA20 {a['ema20']:,.2f} | EMA50 {a['ema50']:,.2f} | EMA200 {a['ema200']:,.2f}\n"
            f"RSI14: {a['rsi14']:.1f} | MACD hist: {a['macd_hist']:.2f} | ATR14: {a['atr14']:,.2f} ({_pct(a['atr_pct'])})\n"
            f"Support 20-bar: {a['support_20']:,.2f} | Resistance 20-bar: {a['resistance_20']:,.2f}\n"
            f"Breakout: {'ya' if a['breakout_up'] else 'tidak'} | Breakdown: {'ya' if a['breakdown'] else 'tidak'}\n"
            "Ini fakta indikator, bukan sinyal trading. Keputusan trade hanya lewat debat penuh + validasi kuant + Risk Engine.")


def h_compare(db: Session, it: Intent) -> str:
    st = {a["role"]: a for a in queries.agent_statuses(db)}
    out = [f"Perbandingan pandangan per {_ts()}"]
    for role in it.agents:
        a = st.get(role)
        la = a and a["last_analysis"]
        out.append(f"{AGENT_NAMES.get(role, role)}: " + (f"{la['stance']} ({la['status']}, {la['created_at'][:16]}) — {la['conclusion'][:300]}" if la else "belum ada analisis"))
    stances = [st[r]["last_analysis"]["stance"] for r in it.agents if st.get(r) and st[r]["last_analysis"]]
    if len(stances) == 2:
        out.append("Kesimpulan: " + ("searah." if stances[0] == stances[1] else "berbeda; lihat Debate Room untuk argumen dan bantahan."))
    return "\n".join(out)


def h_backtest(db: Session, it: Intent) -> str:
    runs = queries.latest_backtests(db, 3)
    if not runs:
        return "Belum ada backtest yang tersimpan."
    lines = []
    for r in runs:
        s = summarize_run(r)
        o = s["oos"]
        lines.append(f"{s['strategy']} {s['symbol']} {s['interval']} ({s['created_at'][:16]}), data {s['dataset_kind'].upper()} {s['data_source']}, status {s['status']}\n"
                     f"  Out-of-sample: {o.get('trades')} trade, win rate {_pct(o.get('win_rate')) if o.get('win_rate') is not None else 'n/a'}, "
                     f"PF {o.get('profit_factor') if o.get('profit_factor') is not None else 'n/a'}, expectancy {o.get('expectancy_r')}R, max DD {_pct(o.get('max_drawdown'))}"
                     + (f"\n  Peringatan: {s['warnings'][0]}" if s["warnings"] else ""))
    return "Hasil BACKTEST (bukan hasil paper/live):\n" + "\n".join(lines)


def h_debate(db: Session, it: Intent) -> str:
    ds = queries.recent_debates(db, 1, it.symbol)
    if not ds:
        return "Belum ada sesi debat."
    d = queries.debate_detail(db, ds[0]["id"])
    s = d["session"]
    dec = d["decision"]
    lines = [f"Debat terakhir {s['symbol']} ({s['created_at'][:16]} UTC): status {s['status']}, ronde {s['rounds_completed']}/{s['max_rounds']}",
             f"Keputusan: {s['final_decision']}" + (" [snapshot SIMULASI]" if d["snapshot"] and d["snapshot"]["simulated"] else "")]
    if dec:
        failed = [g for g in dec["details"].get("gates", []) if not g["passed"]]
        if failed:
            lines.append("Gerbang yang gagal: " + "; ".join(f"{g['gate']} ({g['detail']})" for g in failed))
        if dec["details"].get("dissent"):
            lines.append("Dissent: " + ", ".join(x["agent"] for x in dec["details"]["dissent"]))
    ch = [m for m in d["messages"] if m["kind"] == "challenge"][:3]
    for m in ch:
        lines.append(f"Tantangan → {m['to']}: {m['content'][:150]}")
    return "\n".join(lines)


def h_n8n(db: Session, it: Intent) -> str:
    from app.n8n.monitor import workflow_overview

    ov = workflow_overview(db, fetch_remote=False)
    if not ov["recent"]:
        return "Belum ada laporan eksekusi workflow n8n yang diterima backend."
    lines = [f"Workflow n8n (laporan terakhir yang diterima backend), per {_ts()}"]
    for w in ov["by_workflow"][:10]:
        lines.append(f"- {w['workflow_name'] or w['workflow_id']}: terakhir {w['last_status']} ({w['last_at'][:16]}), error 24j: {w['errors_24h']}")
    return "\n".join(lines)


def h_agents_and_n8n(db: Session, it: Intent) -> str:
    return h_agents(db, it) + "\n\n" + h_n8n(db, it)


def h_paper(db: Session, it: Intent) -> str:
    acct = get_account(db)
    pos = open_positions(db, acct)
    if not pos:
        return "Tidak ada posisi paper yang terbuka. (Simulasi; tidak terkait saldo exchange.)"
    return "Posisi PAPER terbuka:\n" + "\n".join(
        f"- {p.symbol} {p.side} qty {p.qty} @ {float(p.entry_price):,.2f}, stop {float(p.stop_loss):,.2f}, "
        f"TP {float(p.take_profit):,.2f}" if p.take_profit else f"- {p.symbol} {p.side} qty {p.qty} @ {float(p.entry_price):,.2f}, stop {float(p.stop_loss):,.2f}"
        for p in pos)


def h_mexc(db: Session, it: Intent) -> str:
    ms = mexc.status(db)
    if not ms["configured"]:
        return "Koneksi MEXC: belum dikonfigurasi (API key read-only belum diset di server). Eksekusi live: NONAKTIF."
    lines = [f"Koneksi MEXC (mode read-only, eksekusi live NONAKTIF) per {_ts()}"]
    for k, v in ms["snapshots"].items():
        lines.append(f"- {k}: {v['status']}" + (f", {v['fetched_at'][:16]}{' BASI' if v.get('stale') else ''}" if v.get("fetched_at") else "")
                     + (f", error: {v['error'][:80]}" if v.get("error") else ""))
    lines.append("Catatan: integrasi belum diverifikasi terhadap API live dari lingkungan build.")
    return "\n".join(lines)


def h_report(db: Session, it: Intent) -> str:
    return "\n\n".join([f"LAPORAN FUND MANAGER — {_ts()}", h_performance(db, Intent("performance", period=it.period or "today")),
                        h_market(db, it), h_debate(db, Intent("debate")), h_risk(db, it), DISCLAIMER])


def h_refuse_order(db: Session, it: Intent) -> str:
    return ("Saya tidak dapat membuka, menutup, atau mengeksekusi order dari percakapan. Sistem berjalan dalam mode riset/paper; "
            "keputusan trade hanya dihasilkan melalui debat penuh, validasi kuant, dan Risk Engine, dan eksekusi live dinonaktifkan.")


def h_refuse_settings(db: Session, it: Intent) -> str:
    return "Perubahan pengaturan risiko, izin, atau keamanan tidak dapat dilakukan lewat Telegram. Gunakan dashboard dengan akun admin."


HANDLERS = {
    "help": h_help, "status": h_status, "symbol": h_symbol, "market": h_market, "portfolio": h_portfolio,
    "performance": h_performance, "risk": h_risk, "why_veto": h_why_veto, "agents": h_agents, "onchain": h_onchain,
    "quant": h_quant, "technical": h_technical, "compare": h_compare, "backtest": h_backtest, "debate": h_debate,
    "n8n": h_n8n, "agents_and_n8n": h_agents_and_n8n, "paper": h_paper, "mexc": h_mexc, "report": h_report,
    "refuse_order": h_refuse_order, "refuse_settings": h_refuse_settings,
}
