"""
Pixel Quant + FreqAI: the same four bots, with a learned P(win) gate (meta-labelling).

The bots still decide WHEN and WHICH WAY to trade. FreqAI learns, from the bots' own
setup geometry, the probability that a trade taken at a candle reaches +1R before -1R
within the time stop, and only signals whose predicted P(win) clears the threshold are taken.
This keeps P(win) separate from P(direction): the model never predicts the next candle.

Run with a classifier, e.g.:
    freqtrade backtesting -c user_data/config.json -c user_data/config-freqai.json \
        --strategy PixelQuantFreqAI --freqaimodel LightGBMClassifier --timerange 20260101-
"""

import numpy as np
from pandas import DataFrame

from PixelQuantStrategy import SL_MAX, SL_MIN, TIME_STOP_CANDLES, PixelQuantStrategy, cycle_for


def label_wins(high: np.ndarray, low: np.ndarray, close: np.ndarray, sl_pct: np.ndarray,
               sides: np.ndarray, horizon: int) -> np.ndarray:
    """1.0 if a trade opened at close[i] in direction sides[i] (+1/-1) touches +1R before -1R
    within `horizon` candles, 0.0 if the stop is hit first or time runs out, NaN when the
    future is not yet known. The stop wins ties inside a candle, as in the backtest engine."""
    n = len(close)
    out = np.full(n, np.nan)
    for i in range(n - 1):
        d = close[i] * sl_pct[i]
        if not np.isfinite(d) or d <= 0:
            continue
        s = sides[i]
        end = min(n, i + 1 + horizon)
        res = np.nan
        for j in range(i + 1, end):
            adverse = (low[j] <= close[i] - d) if s > 0 else (high[j] >= close[i] + d)
            favour = (high[j] >= close[i] + d) if s > 0 else (low[j] <= close[i] - d)
            if adverse:
                res = 0.0
                break
            if favour:
                res = 1.0
                break
        if np.isnan(res) and end - i - 1 == horizon:
            res = 0.0  # time stop without reaching +1R
        out[i] = res
    return out


class PixelQuantFreqAI(PixelQuantStrategy):
    # minimum predicted P(win) for a bot signal to be taken
    pwin_threshold = 0.55

    def feature_engineering_expand_all(self, dataframe: DataFrame, period: int, metadata: dict, **kwargs) -> DataFrame:
        df = dataframe
        close = df["close"]
        delta = close.diff()
        gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
        loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
        df["%-rsi-period"] = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
        tr = np.maximum(df["high"] - df["low"], np.maximum((df["high"] - close.shift()).abs(), (df["low"] - close.shift()).abs()))
        df["%-atr_pct-period"] = tr.ewm(alpha=1 / period, adjust=False).mean() / close
        df["%-roc-period"] = close.pct_change(period)
        ema = close.ewm(span=period, adjust=False).mean()
        df["%-ema_dist-period"] = (close - ema) / ema
        hi, lo = df["high"].rolling(period).max(), df["low"].rolling(period).min()
        df["%-range_pos-period"] = (close - lo) / (hi - lo).replace(0, np.nan)
        df["%-vol_z-period"] = (df["volume"] - df["volume"].rolling(period).mean()) / df["volume"].rolling(period).std()
        return df

    def feature_engineering_expand_basic(self, dataframe: DataFrame, metadata: dict, **kwargs) -> DataFrame:
        df = dataframe
        df["%-pct_change"] = df["close"].pct_change()
        rng = (df["high"] - df["low"]).replace(0, np.nan)
        df["%-body_ratio"] = (df["close"] - df["open"]) / rng
        df["%-upper_wick"] = (df["high"] - df[["open", "close"]].max(axis=1)) / rng
        df["%-lower_wick"] = (df[["open", "close"]].min(axis=1) - df["low"]) / rng
        return df

    def feature_engineering_standard(self, dataframe: DataFrame, metadata: dict, **kwargs) -> DataFrame:
        df = dataframe
        df["%-day_of_week"] = df["date"].dt.dayofweek
        df["%-hour_of_day"] = df["date"].dt.hour
        df["%-cycle_long"] = (df["date"].map(cycle_for) == "long").astype(int)
        return df

    def set_freqai_targets(self, dataframe: DataFrame, metadata: dict, **kwargs) -> DataFrame:
        df = dataframe
        self.freqai.class_names = ["loss", "win"]
        close, high, low = df["close"], df["high"], df["low"]
        tr = np.maximum(high - low, np.maximum((high - close.shift()).abs(), (low - close.shift()).abs()))
        sl_pct = (1.5 * tr.ewm(alpha=1 / 14, adjust=False).mean() / close).clip(SL_MIN, SL_MAX)
        sides = np.where(df["date"].map(cycle_for) == "long", 1, -1)
        y = label_wins(high.to_numpy(), low.to_numpy(), close.to_numpy(), sl_pct.to_numpy(), sides, TIME_STOP_CANDLES)
        df["&-win"] = np.where(np.isnan(y), None, np.where(y == 1.0, "win", "loss"))
        return df

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe = self.freqai.start(dataframe, metadata, self)
        return super().populate_indicators(dataframe, metadata)

    def win_probability(self, df: DataFrame, side: str):
        # the label already follows the cycle direction, which is the only side we trade
        return df["win"] if "win" in df else super().win_probability(df, side)

    def entry_filter(self, df: DataFrame, side: str):
        if "win" not in df:
            return df["close"] != df["close"]
        return (df["do_predict"] == 1) & (df["win"] >= self.pwin_threshold)
