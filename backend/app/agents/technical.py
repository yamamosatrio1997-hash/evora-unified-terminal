"""Technical Analyst: deterministic multi-timeframe analysis from snapshot candles."""
from __future__ import annotations

from typing import Any

from app.agents.base import Agent, DebateContext, fact, inference, uniq_refs
from app.agents.schemas import AgentOutput, TradeIdea
from app.quant import indicators as ind
from app.quant.backtest import Bars

MIN_BARS = 210  # EMA200 needs history


def tf_analysis(rows: list[list[Any]]) -> dict[str, Any] | None:
    if len(rows) < MIN_BARS:
        return None
    b = Bars.from_rows(rows)
    c = b.close
    ema20, ema50, ema200 = ind.ema(c, 20), ind.ema(c, 50), ind.ema(c, 200)
    rsi = ind.rsi(c, 14)
    _, _, hist = ind.macd(c)
    atr = ind.atr(b.high, b.low, b.close, 14)
    vol_avg = ind.sma(b.volume, 20)
    hi20 = ind.rolling_max(b.high, 20)
    lo20 = ind.rolling_min(b.low, 20)
    last = len(c) - 1
    if c[last] > ema50[last] > ema200[last] and ema20[last] > ema50[last]:
        trend = "up"
    elif c[last] < ema50[last] < ema200[last] and ema20[last] < ema50[last]:
        trend = "down"
    else:
        trend = "mixed"
    return {
        "close": float(c[last]), "time": b.time[last],
        "ema20": float(ema20[last]), "ema50": float(ema50[last]), "ema200": float(ema200[last]),
        "rsi14": float(rsi[last]), "macd_hist": float(hist[last]), "macd_hist_prev": float(hist[last - 1]),
        "atr14": float(atr[last]), "atr_pct": float(atr[last] / c[last]),
        "volume_ratio": float(b.volume[last] / vol_avg[last]) if vol_avg[last] else None,
        "resistance_20": float(hi20[last - 1]), "support_20": float(lo20[last - 1]),
        "breakout_up": bool(c[last] > hi20[last - 1]), "breakdown": bool(c[last] < lo20[last - 1]),
        "trend": trend,
    }


class TechnicalAnalyst(Agent):
    role = "technical"

    def analyze(self, ctx: DebateContext) -> AgentOutput:
        candles = ctx.content.get("candles", {})
        tfs: dict[str, dict[str, Any]] = {}
        missing, stale = [], []
        for iv in ("1h", "4h", "1d"):
            rows = (candles.get(iv) or {}).get("rows") or []
            a = tf_analysis(rows)
            if a is None:
                missing.append(f"{iv} candles (need >= {MIN_BARS}, have {len(rows)})")
            else:
                tfs[iv] = a
            if (candles.get(iv) or {}).get("stale"):
                stale.append(iv)
        refs = uniq_refs(*(ctx.candle_ref(iv) for iv in tfs))
        if "4h" not in tfs or "1d" not in tfs:
            return self.base_output(
                ctx, status="insufficient_data", stance="no_view",
                conclusion="Not enough closed candles on the 4h/1d timeframes to analyze market structure.",
                uncertainty="High: primary timeframes unavailable.", source_references=refs,
                missing_data=missing, recommended_next_action="Backfill candle history before analysis.",
                confidence=0.0, metrics={"timeframes": tfs},
            )
        h4, d1 = tfs["4h"], tfs["1d"]
        r4, rd = ctx.candle_ref("4h"), ctx.candle_ref("1d")
        sup, opp = [], []
        for name, a, ref in (("4h", h4, r4), ("1d", d1, rd)):
            sup_or_opp = sup if a["trend"] != "mixed" else opp
            sup_or_opp.append(fact(f"{name} close {a['close']:.2f}; EMA20/50/200 = {a['ema20']:.2f}/{a['ema50']:.2f}/{a['ema200']:.2f} -> trend {a['trend']}", ref))
            if a["rsi14"] > 70 or a["rsi14"] < 30:
                opp.append(fact(f"{name} RSI14 {a['rsi14']:.1f} is at an extreme ({'overbought' if a['rsi14'] > 70 else 'oversold'})", ref))
        aligned = h4["trend"] == d1["trend"] and h4["trend"] in ("up", "down")
        stance = "neutral"
        idea = None
        if aligned:
            side = "long" if h4["trend"] == "up" else "short"
            stance = "bullish" if side == "long" else "bearish"
            entry = h4["close"]
            atr = h4["atr14"]
            if side == "long":
                stop = min(entry - 1.5 * atr, h4["support_20"]) if h4["support_20"] < entry else entry - 2 * atr
                stop = max(stop, entry - 3 * atr)
                trigger = f"4h close above {max(h4['resistance_20'], entry):.2f} (20-bar high) or hold above EMA20 {h4['ema20']:.2f}"
            else:
                stop = max(entry + 1.5 * atr, h4["resistance_20"]) if h4["resistance_20"] > entry else entry + 2 * atr
                stop = min(stop, entry + 3 * atr)
                trigger = f"4h close below {min(h4['support_20'], entry):.2f} (20-bar low) or rejection at EMA20 {h4['ema20']:.2f}"
            risk = abs(entry - stop)
            tp = entry + 2 * risk if side == "long" else entry - 2 * risk
            idea = TradeIdea(side=side, timeframe="4h", entry=round(entry, 2), entry_trigger=trigger,
                             stop_loss=round(stop, 2), take_profit=round(tp, 2),
                             invalidation=f"4h close {'below' if side == 'long' else 'above'} {stop:.2f} or loss of 1d EMA50 {d1['ema50']:.2f}")
            momentum_ok = (h4["macd_hist"] > 0) if side == "long" else (h4["macd_hist"] < 0)
            (sup if momentum_ok else opp).append(fact(f"4h MACD histogram {h4['macd_hist']:.2f} ({'confirms' if momentum_ok else 'diverges from'} {side} bias)", r4))
            sup.append(inference(f"4h and 1d trends are aligned {h4['trend']}; idea: {side} with stop {stop:.2f} ({risk / entry:.2%} away) and 2R target {tp:.2f}", r4, rd))
        else:
            opp.append(inference(f"4h trend '{h4['trend']}' and 1d trend '{d1['trend']}' are not aligned; no directional setup", r4, rd))
        if h4["volume_ratio"] is not None and h4["volume_ratio"] < 0.7:
            opp.append(fact(f"4h volume is {h4['volume_ratio']:.2f}x its 20-bar average (weak participation)", r4))
        if "1h" in tfs:
            h1 = tfs["1h"]
            (sup if (h1["trend"] == h4["trend"]) else opp).append(fact(f"1h trend {h1['trend']} (RSI14 {h1['rsi14']:.1f})", ctx.candle_ref("1h")))
        confidence = 0.0 if stale else (0.6 if aligned else 0.2)
        if stale:
            missing.append(f"fresh candles for {', '.join(stale)} (data is stale)")
        return self.base_output(
            ctx, status="completed", stance=stance if not stale else "no_view",
            conclusion=(f"{ctx.symbol}: 4h/1d structure aligned {h4['trend']}; {idea.side} setup defined with explicit trigger, stop and invalidation."
                        if idea and not stale else f"{ctx.symbol}: no aligned multi-timeframe structure{' (stale data)' if stale else ''}; no setup."),
            confidence=confidence, supporting_evidence=sup, opposing_evidence=opp,
            assumptions=["Indicators are computed on closed candles only.", "Stop placement uses ATR(14) and 20-bar swing levels."],
            uncertainty="Technical patterns have no guaranteed predictive value; an edge must be confirmed by the Quant Researcher.",
            source_references=refs, missing_data=missing,
            recommended_next_action="Quant validation of the trend-following setup" if idea else "Wait for timeframe alignment",
            metrics={"timeframes": tfs}, trade_idea=idea if not stale else None,
        )

