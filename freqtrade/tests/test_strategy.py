"""Unit tests for the Pixel Quant freqtrade strategies.

Run from the repo root with the freqtrade virtualenv:
    python -m unittest discover -s freqtrade/tests
"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "user_data" / "strategies"))

from PixelQuantFreqAI import label_wins  # noqa: E402
from PixelQuantStrategy import BOT_BY_PAIR, PixelQuantStrategy, parse_tag  # noqa: E402


def candles(n=1200, start="2025-09-01", vol=0.006, seed=1):
    rng = np.random.default_rng(seed)
    dates = pd.date_range(start, periods=n, freq="4h", tz="UTC")
    c = 100 * np.exp(np.cumsum(rng.normal(0, vol, n)))
    o = np.r_[c[0], c[:-1]]
    return pd.DataFrame({"date": dates, "open": o, "high": np.maximum(o, c) * 1.002,
                         "low": np.minimum(o, c) * 0.998, "close": c, "volume": 1.0})


class FakeTrade:
    def __init__(self, pair, open_rate, is_short, open_date, tag="trend|p=0.6|al=1|vol=normal"):
        self.pair, self.open_rate, self.is_short = pair, open_rate, is_short
        self.open_date_utc, self.enter_tag = open_date, tag
        self.leverage, self.stake_amount, self.has_open_orders = 10.0, 100.0, False
        self._data = {}

    def get_custom_data(self, key, default=None):
        return self._data.get(key, default)

    def set_custom_data(self, key, value):
        self._data[key] = value


class FakeDP:
    def __init__(self, df):
        self.df = df

    def get_analyzed_dataframe(self, pair, timeframe):
        return self.df, None


def make_strategy(df):
    s = PixelQuantStrategy.__new__(PixelQuantStrategy)
    s.dp = FakeDP(df)
    return s


class StrategyTests(unittest.TestCase):
    def setUp(self):
        self.df = PixelQuantStrategy.populate_indicators(PixelQuantStrategy.__new__(PixelQuantStrategy), candles(), {})

    def test_entries_follow_cycle_and_tag_format(self):
        s = make_strategy(self.df)
        seen = {"long": 0, "short": 0}
        for pair in BOT_BY_PAIR:
            out = s.populate_entry_trend(self.df.copy(), {"pair": pair})
            longs = out[out.get("enter_long", 0) == 1]
            shorts = out[out.get("enter_short", 0) == 1]
            self.assertTrue((longs["date"].dt.year != 2026).all(), "no longs in the 2026 bear cycle")
            self.assertTrue((shorts["date"].dt.year == 2026).all(), "shorts only in 2026")
            for tag in pd.concat([longs, shorts])["enter_tag"]:
                t = parse_tag(tag)
                self.assertEqual(t["bot"], BOT_BY_PAIR[pair])
                self.assertTrue(0 < float(t["p"]) < 1 and t["al"] in ("0", "1") and t["vol"])
            seen["long"] += len(longs)
            seen["short"] += len(shorts)
        self.assertGreater(seen["long"], 0, "the sample spans 2025, so some longs must fire")
        self.assertGreater(seen["short"], 0, "the sample spans 2026, so some shorts must fire")

    def test_stop_distance_is_atr_based_and_capped(self):
        sl = self.df["sl_pct"].dropna()
        self.assertTrue(((sl >= 0.005) & (sl <= 0.03)).all())
        self.assertLess(sl.median(), 0.03, "on calm data the stop should come from ATR, not the cap")

    def test_levels_breakeven_and_time_stop(self):
        s = make_strategy(self.df)
        row = self.df.iloc[300]
        open_date = row["date"].to_pydatetime() + timedelta(hours=4)
        trade = FakeTrade("BTC/USDT:USDT", float(row["close"]), False, open_date)
        lv = s._levels(trade)
        d = trade.open_rate * float(row["sl_pct"])
        self.assertAlmostEqual(lv["sl"], trade.open_rate - d)
        self.assertAlmostEqual(lv["tp2"], trade.open_rate + 2.4 * d)  # trend bot RR
        # initial stop: distance to lv["sl"], scaled by leverage
        sl_ratio = s.custom_stoploss(trade.pair, trade, open_date, trade.open_rate, 0, False)
        self.assertAlmostEqual(sl_ratio, float(row["sl_pct"]) * 10, places=6)
        # TP1 reached: half the stake comes off once, then the stop sits at breakeven
        adj = s.adjust_trade_position(trade, open_date, lv["tp1"], 0, None, 1e9, 0, 0, 0, 0)
        self.assertEqual(adj, (-50.0, "tp1"))
        self.assertIsNone(s.adjust_trade_position(trade, open_date, lv["tp1"], 0, None, 1e9, 0, 0, 0, 0))
        price = trade.open_rate * 1.002
        be = s.custom_stoploss(trade.pair, trade, open_date, price, 0, False)
        self.assertAlmostEqual(be, (1 - trade.open_rate / price) * 10, places=9)
        # exits
        self.assertEqual(s.custom_exit(trade.pair, trade, open_date, lv["tp2"], 0), "tp2")
        self.assertIsNone(s.custom_exit(trade.pair, trade, open_date + timedelta(hours=4 * 29), trade.open_rate, 0))
        self.assertEqual(s.custom_exit(trade.pair, trade, open_date + timedelta(hours=4 * 30), trade.open_rate, 0), "time_stop")

    def test_short_levels_mirror(self):
        s = make_strategy(self.df)
        row = self.df.iloc[350]
        trade = FakeTrade("XRP/USDT:USDT", float(row["close"]), True, row["date"].to_pydatetime() + timedelta(hours=4), "sweep|p=0.5|al=0|vol=normal")
        lv = s._levels(trade)
        self.assertGreater(lv["sl"], trade.open_rate)
        self.assertLess(lv["tp2"], lv["tp1"])
        self.assertEqual(s.custom_exit(trade.pair, trade, trade.open_date_utc, lv["tp2"] * 0.999, 0), "tp2")


class LabelTests(unittest.TestCase):
    def test_label_wins(self):
        close = np.array([100.0, 100.0, 100.0, 100.0])
        sl = np.full(4, 0.01)
        # +1R (101) reached on the next candle
        y = label_wins(np.array([100, 101.5, 100, 100.0]), np.array([100, 99.5, 100, 100.0]), close, sl, np.ones(4), 2)
        self.assertEqual(y[0], 1.0)
        # stop wins a candle that touches both
        y = label_wins(np.array([100, 101.5, 100, 100.0]), np.array([100, 98.5, 100, 100.0]), close, sl, np.ones(4), 2)
        self.assertEqual(y[0], 0.0)
        # short side mirrors
        y = label_wins(np.array([100, 100.5, 100, 100.0]), np.array([100, 98.9, 100, 100.0]), close, sl, -np.ones(4), 2)
        self.assertEqual(y[0], 1.0)
        # unknown future stays NaN, a full window without +1R is a loss
        y = label_wins(np.full(4, 100.2), np.full(4, 99.8), close, sl, np.ones(4), 2)
        self.assertEqual(y[0], 0.0)
        self.assertTrue(np.isnan(y[2]) and np.isnan(y[3]))


if __name__ == "__main__":
    unittest.main()
