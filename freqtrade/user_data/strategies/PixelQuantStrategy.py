"""
Pixel Quant: the four Pixel Quant bots as one freqtrade strategy.

Each pair belongs to exactly one bot, so freqtrade's one-trade-per-pair rule never
makes two bots compete for the same pair.

Project rules carried over from the dashboard engine (server/engine.js):
- 4h candles, entry at the close of the signal candle (next candle open in freqtrade)
- direction follows the yearly cycle: Long only in bull years, Short only in bear years
- stop = 1.5 x ATR(14), clamped to 0.5%..3% of price
- risk 0.5% of equity per R, 10x isolated leverage
- half the position closes at +1R and the stop moves to breakeven, the rest exits at the
  bot's RR target or after 30 candles

Every entry tag reads "<bot>|p=<P(win)>|al=<0|1>|vol=<regime>" so the dashboard can
rebuild its calibration and loss-lesson views from freqtrade's trade history.
"""

from datetime import datetime

import numpy as np
from pandas import DataFrame

from freqtrade.persistence import Trade
from freqtrade.strategy import IStrategy, stoploss_from_absolute


CYCLE_BY_YEAR = {2025: "long", 2026: "short", 2027: "long"}

BOTS = {
    "trend": {"rule": "donchian", "rr": 2.4, "pairs": ["BTC/USDT:USDT", "ETH/USDT:USDT"]},
    "momentum": {"rule": "emaCross", "rr": 2.0, "pairs": ["SOL/USDT:USDT", "AVAX/USDT:USDT"]},
    "range": {"rule": "rsiFade", "rr": 1.6, "pairs": ["ARB/USDT:USDT", "DOGE/USDT:USDT"]},
    "sweep": {"rule": "sweep", "rr": 1.8, "pairs": ["XRP/USDT:USDT", "BNB/USDT:USDT"]},
}
BOT_BY_PAIR = {pair: bot for bot, cfg in BOTS.items() for pair in cfg["pairs"]}

RISK_PCT = 0.005
LEVERAGE = 10.0
SL_MIN, SL_MAX = 0.005, 0.03
TIME_STOP_CANDLES = 30


def cycle_for(ts) -> str:
    return CYCLE_BY_YEAR.get(ts.year, "long")


def parse_tag(tag: str | None) -> dict:
    out = {"bot": None}
    if not tag:
        return out
    parts = tag.split("|")
    out["bot"] = parts[0]
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            out[k] = v
    return out


class PixelQuantStrategy(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "4h"
    can_short = True
    startup_candle_count = 210
    process_only_new_candles = True

    # hard floor: a 3% price move at 10x; the real stop comes from custom_stoploss
    stoploss = -SL_MAX * LEVERAGE
    use_custom_stoploss = True
    minimal_roi = {"0": 100}
    # must stay True: freqtrade only calls custom_exit (TP2, time stop) when exit signals are on;
    # populate_exit_trend sets no signals, so nothing else exits trades
    use_exit_signal = True
    position_adjustment_enable = True
    max_entry_position_adjustment = 0

    # ---------- indicators & rules ----------

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        df = dataframe
        close, high, low = df["close"], df["high"], df["low"]
        df["ema20"] = close.ewm(span=20, adjust=False).mean()
        df["ema50"] = close.ewm(span=50, adjust=False).mean()
        df["ema200"] = close.ewm(span=200, adjust=False).mean()
        prev_close = close.shift(1)
        tr = np.maximum(high - low, np.maximum((high - prev_close).abs(), (low - prev_close).abs()))
        df["atr"] = tr.ewm(alpha=1 / 14, adjust=False).mean()
        delta = close.diff()
        gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
        loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
        df["rsi"] = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
        df["don_high"] = high.rolling(20).max().shift(1)
        df["don_low"] = low.rolling(20).min().shift(1)
        atr_pct = df["atr"] / close
        median = atr_pct.rolling(100, min_periods=20).median()
        df["vol_regime"] = np.where(atr_pct > median * 1.25, "tinggi", np.where(atr_pct < median * 0.8, "rendah", "normal"))
        df["sl_pct"] = (1.5 * df["atr"] / close).clip(SL_MIN, SL_MAX)
        df["cycle"] = df["date"].map(cycle_for)
        df["aligned_long"] = (df["ema50"] >= df["ema200"]).astype(int)
        stretch = (close - df["ema50"]) / df["atr"]
        # heuristic P(win) used when no model is present; FreqAI replaces it with a learned one
        df["p_long"] = (0.5 + 0.08 * np.tanh(stretch) + np.where(df["aligned_long"] == 1, 0.04, -0.04)
                        - np.where(df["vol_regime"] == "tinggi", 0.04, 0)).clip(0.35, 0.8)
        df["p_short"] = (0.5 + 0.08 * np.tanh(-stretch) + np.where(df["aligned_long"] == 0, 0.04, -0.04)
                         - np.where(df["vol_regime"] == "tinggi", 0.04, 0)).clip(0.35, 0.8)
        return df

    @staticmethod
    def rule_signals(df: DataFrame, rule: str) -> tuple:
        c, pc = df["close"], df["close"].shift(1)
        if rule == "donchian":
            long_ = (c > df["don_high"]) & (pc <= df["don_high"]) & (df["ema20"] > df["ema50"])
            short = (c < df["don_low"]) & (pc >= df["don_low"]) & (df["ema20"] < df["ema50"])
        elif rule == "emaCross":
            diff = df["ema20"] - df["ema50"]
            long_ = (diff.shift(1) <= 0) & (diff > 0)
            short = (diff.shift(1) >= 0) & (diff < 0)
        elif rule == "rsiFade":
            long_ = (df["rsi"].shift(1) >= 30) & (df["rsi"] < 30)
            short = (df["rsi"].shift(1) <= 70) & (df["rsi"] > 70)
        elif rule == "sweep":
            long_ = (df["low"] < df["don_low"]) & (c > df["don_low"])
            short = (df["high"] > df["don_high"]) & (c < df["don_high"])
        else:
            long_ = short = c != c
        return long_.fillna(False), short.fillna(False)

    def entry_filter(self, df: DataFrame, side: str):
        """Extra gate on top of the bot rule; the FreqAI subclass narrows this."""
        return df["close"] == df["close"]

    def win_probability(self, df: DataFrame, side: str):
        return df["p_long"] if side == "long" else df["p_short"]

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        df = dataframe
        bot = BOT_BY_PAIR.get(metadata["pair"])
        if bot is None:
            return df
        long_, short = self.rule_signals(df, BOTS[bot]["rule"])
        for side, sig, col in (("long", long_, "enter_long"), ("short", short, "enter_short")):
            mask = sig & (df["cycle"] == side) & self.entry_filter(df, side)
            p = self.win_probability(df, side)
            aligned = df["aligned_long"] if side == "long" else 1 - df["aligned_long"]
            df.loc[mask, col] = 1
            df.loc[mask, "enter_tag"] = (bot + "|p=" + p[mask].round(2).astype(str) + "|al="
                                         + aligned[mask].astype(str) + "|vol=" + df.loc[mask, "vol_regime"])
        return df

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        return dataframe

    # ---------- sizing ----------

    def leverage(self, pair, current_time, current_rate, proposed_leverage, max_leverage, entry_tag, side, **kwargs):
        return min(LEVERAGE, max_leverage)

    def _signal_candle(self, pair: str, before: datetime):
        df, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        rows = df[df["date"] < before] if len(df) else df
        return rows.iloc[-1] if len(rows) else None

    def custom_stake_amount(self, pair, current_time, current_rate, proposed_stake, min_stake, max_stake,
                            leverage, entry_tag, side, **kwargs):
        row = self._signal_candle(pair, current_time)
        if row is None or not np.isfinite(row["sl_pct"]):
            return proposed_stake
        equity = self.wallets.get_total_stake_amount()
        notional = equity * RISK_PCT / row["sl_pct"]
        stake = notional / leverage
        return float(np.clip(stake, min_stake or 0, max_stake))

    # ---------- trade management ----------

    def _levels(self, trade: Trade) -> dict | None:
        lv = trade.get_custom_data("levels")
        if lv:
            return lv
        row = self._signal_candle(trade.pair, trade.open_date_utc)
        if row is None:
            return None
        bot = parse_tag(trade.enter_tag)["bot"] or BOT_BY_PAIR.get(trade.pair)
        rr = BOTS.get(bot, {"rr": 2.0})["rr"]
        s = -1 if trade.is_short else 1
        dist = trade.open_rate * float(row["sl_pct"])
        lv = {"sl": trade.open_rate - s * dist, "tp1": trade.open_rate + s * dist, "tp2": trade.open_rate + s * dist * rr}
        trade.set_custom_data("levels", lv)
        return lv

    def custom_stoploss(self, pair, trade, current_time, current_rate, current_profit, after_fill, **kwargs):
        lv = self._levels(trade)
        if lv is None:
            return None
        stop = trade.open_rate if trade.get_custom_data("tp1_done") else lv["sl"]
        return stoploss_from_absolute(stop, current_rate, is_short=trade.is_short, leverage=trade.leverage)

    def adjust_trade_position(self, trade, current_time, current_rate, current_profit, min_stake, max_stake,
                              current_entry_rate, current_exit_rate, current_entry_profit, current_exit_profit,
                              **kwargs):
        if trade.get_custom_data("tp1_done") or trade.has_open_orders:
            return None
        lv = self._levels(trade)
        if lv is None:
            return None
        reached = current_rate <= lv["tp1"] if trade.is_short else current_rate >= lv["tp1"]
        if reached:
            trade.set_custom_data("tp1_done", True)
            return -(trade.stake_amount / 2), "tp1"
        return None

    def custom_exit(self, pair, trade, current_time, current_rate, current_profit, **kwargs):
        lv = self._levels(trade)
        if lv is None:
            return None
        if (current_rate <= lv["tp2"]) if trade.is_short else (current_rate >= lv["tp2"]):
            return "tp2"
        candles = (current_time - trade.open_date_utc).total_seconds() / (4 * 3600)
        if candles >= TIME_STOP_CANDLES:
            return "time_stop"
        return None
