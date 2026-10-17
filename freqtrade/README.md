# Pixel Quant × freqtrade

The four Pixel Quant bots as a [freqtrade](https://github.com/freqtrade/freqtrade) strategy, plus a FreqAI
version that learns P(win) for each bot signal and only takes the signals the model rates highly
(meta-labelling). The Pixel Quant dashboard can mirror a running freqtrade bot.

| File | What it is |
| --- | --- |
| `user_data/strategies/PixelQuantStrategy.py` | Rule-based bots: Donchian breakout, EMA cross, RSI fade, liquidity sweep. Stop = 1.5×ATR (0.5–3%), 0.5% risk/R, 10x isolated, TP1 half-off → breakeven, TP2 at the bot's RR, 30-candle time stop, direction follows the yearly cycle (2026 = Short). |
| `user_data/strategies/PixelQuantFreqAI.py` | Same bots + LightGBM classifier. Target `&-win` = does a trade from this candle reach +1R before −1R within 30 candles. Entries need `do_predict == 1` and P(win) ≥ `pwin_threshold` (0.55). |
| `user_data/config.json` | Binance USDT-M futures, dry-run, 4h, 8 pairs, REST API on 127.0.0.1:8080. |
| `user_data/config-freqai.json` | FreqAI overlay: 180-day train window, 30-day walk-forward step, 4h+1d features, BTC as correlated pair. |
| `tests/test_strategy.py` | Unit tests for levels, breakeven, time stop, cycle rule, tag format, label function. |

## Install

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install "freqtrade[freqai]"
cd freqtrade
freqtrade create-userdir --userdir user_data   # keeps the files already here
```

Set real secrets through the environment rather than editing the JSON:

```bash
export FREQTRADE__API_SERVER__PASSWORD='a-long-password'
export FREQTRADE__API_SERVER__JWT_SECRET_KEY="$(python -c 'import secrets;print(secrets.token_hex(32))')"
```

## Data, backtest, FreqAI

```bash
freqtrade download-data -c user_data/config.json --timeframes 4h 1d --trading-mode futures --timerange 20250101-

# rule-based bots, project fee 0.15% round trip (0.075% per side), then the 0.30% stress test
freqtrade backtesting -c user_data/config.json --strategy PixelQuantStrategy --fee 0.00075 --timerange 20250701-
freqtrade backtesting -c user_data/config.json --strategy PixelQuantStrategy --fee 0.0015  --timerange 20250701-

# bots + learned P(win) gate (walk-forward: retrains every 30 days on the previous 180)
freqtrade backtesting -c user_data/config.json -c user_data/config-freqai.json \
  --freqaimodel LightGBMClassifier --fee 0.00075 --timerange 20260101-20261015
```

Compare the two runs on the same timerange. The ML gate is only worth keeping if it improves
R/trade or drawdown out of sample after fees, not just win rate.

## Dry-run and the dashboard

```bash
freqtrade trade -c user_data/config.json -c user_data/config-freqai.json --freqaimodel LightGBMClassifier
```

In another terminal, from the repo root:

```bash
FREQTRADE_URL=http://127.0.0.1:8080 FREQTRADE_USERNAME=pixelquant FREQTRADE_PASSWORD='a-long-password' npm start
```

The dashboard then shows freqtrade's equity, open trades, closed trades, KPIs, the 4-target
verdict, loss lessons and calibration (from the `p=`, `al=` and `vol=` fields in each entry tag).
The pause button maps to freqtrade's `/stopentry` (no new entries, open trades stay managed) and
resume to `/reload_config`.

## Tests

```bash
python -m unittest discover -s freqtrade/tests   # from the repo root, inside the venv
```
