// Freqtrade REST API client and mapping into the dashboard's trade/position shapes.
// Field names follow freqtrade's api_schemas (TradeSchema / OpenTradeSchema / Balances).

import { BOTS, PAIRS } from './data.js';
import { sessionOf } from './engine.js';

const BAR = 4 * 3600 * 1000;
const TIME_STOP = 30 * BAR;

export function parseTag(tag) {
  const out = { bot: null };
  if (!tag) return out;
  const [bot, ...rest] = String(tag).split('|');
  out.bot = bot;
  for (const part of rest) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

const toPair = (p) => p.replace(/:.*$/, ''); // 'BTC/USDT:USDT' -> 'BTC/USDT'
const botInfo = (id) => BOTS.find((b) => b.id === id);

function commonFields(t) {
  const tag = parseTag(t.enter_tag);
  const bot = botInfo(tag.bot);
  const qty0 = ((t.max_stake_amount ?? t.stake_amount) * (t.leverage || 1)) / t.open_rate;
  const stop0 = t.initial_stop_loss_abs ?? t.stop_loss_abs;
  const riskUsd = stop0 ? Math.abs(t.open_rate - stop0) * qty0 : 0;
  const aligned = tag.al == null ? null : tag.al === '1';
  return {
    tag, bot, qty0, riskUsd, stop0,
    base: {
      id: t.trade_id, bot: bot?.id ?? 'freqtrade', botName: bot?.name ?? (tag.bot || t.strategy), strategy: t.strategy, tf: '4h',
      pair: toPair(t.pair), side: t.is_short ? 'SHORT' : 'LONG', entry: t.open_rate, openedAt: t.open_timestamp,
      conf: tag.p != null ? Number(tag.p) : 0.5,
      tags: { session: sessionOf(t.open_timestamp), volRegime: tag.vol ?? null, aligned },
    },
  };
}

function statusOf(t) {
  const partial = (t.nr_of_successful_exits ?? 0) > 1;
  switch (t.exit_reason) {
    case 'tp2': return 'TP2';
    case 'time_stop': return 'TIME';
    case 'stop_loss':
    case 'stoploss_on_exchange':
    case 'trailing_stop_loss':
    case 'liquidation': return partial ? 'TP1' : 'SL';
    default: return 'TIME'; // manual / force exits
  }
}

export function mapClosedTrade(t) {
  const { base, qty0, riskUsd } = commonFields(t);
  const pnl = t.profit_abs ?? t.close_profit_abs ?? 0;
  return {
    ...base, exit: t.close_rate, closedAt: t.close_timestamp, qty: qty0, pnl,
    r: riskUsd ? pnl / riskUsd : 0, status: statusOf(t), exitReason: t.exit_reason,
    fee: (t.fee_open_cost || 0) + (t.fee_close_cost || 0),
  };
}

export function mapOpenTrade(t, now = Date.now()) {
  const { base, bot, riskUsd, stop0 } = commonFields(t);
  const s = t.is_short ? -1 : 1;
  const d = stop0 ? Math.abs(t.open_rate - stop0) : t.open_rate * 0.01;
  const notional = (t.amount || 0) * t.current_rate;
  const upnl = t.total_profit_abs ?? t.profit_abs ?? 0;
  return {
    ...base, price: t.current_rate, sl: t.stop_loss_abs ?? stop0, initialSl: stop0,
    tp1: t.open_rate + s * d, tp2: t.open_rate + s * d * (bot?.rr ?? 2), tp1Hit: (t.nr_of_successful_exits ?? 0) > 0,
    qty: t.amount, qtyOpen: t.amount, notional, margin: notional / (t.leverage || 1), upnl,
    r: riskUsd ? upnl / riskUsd : 0, timeLeft: Math.max(0, t.open_timestamp + TIME_STOP - now),
  };
}

// pair_candles returns {columns, data: [[...row]]}; take the last closed candle's indicators
export function mapCandles(pair, res) {
  const cols = res?.columns || [];
  const rows = res?.data || [];
  if (!rows.length) return null;
  const col = (row, name) => row[cols.indexOf(name)];
  const last = rows[rows.length - 1];
  const close = Number(col(last, 'close'));
  const ago = rows[Math.max(0, rows.length - 7)];
  const ema20 = Number(col(last, 'ema20')), ema50 = Number(col(last, 'ema50')), atr = Number(col(last, 'atr'));
  const meta = PAIRS.find((p) => p.sym === pair);
  return {
    sym: pair, base: pair.split('/')[0], color: meta?.color ?? '#8f9bc8', price: close,
    chg24: (close - Number(col(ago, 'close'))) / Number(col(ago, 'close')),
    bias: Number.isFinite(ema20) && ema20 < ema50 ? 'SHORT' : 'LONG',
    strength: Number.isFinite(atr) && atr > 0 ? (ema20 - ema50) / atr : 0,
    regime: col(last, 'vol_regime') || 'normal',
    spark: rows.slice(-60).map((r) => Number(col(r, 'close'))),
    ref: null,
  };
}

export class FreqtradeClient {
  constructor({ url, username, password, fetchImpl = fetch }) {
    this.url = url.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.fetch = fetchImpl;
    this.token = null;
  }

  // concurrent requests share one login
  #login() {
    this.loginPromise ??= this.#doLogin().finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }

  async #doLogin() {
    const res = await this.fetch(`${this.url}/api/v1/token/login`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}` },
    });
    if (!res.ok) throw new Error(`login freqtrade gagal (${res.status})`);
    this.token = (await res.json()).access_token;
  }

  async request(path, { method = 'GET', retry = true } = {}) {
    if (!this.token) await this.#login();
    const res = await this.fetch(`${this.url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${this.token}` } });
    if (res.status === 401 && retry) {
      this.token = null;
      return this.request(path, { method, retry: false });
    }
    if (!res.ok) throw new Error(`freqtrade ${path} → ${res.status}`);
    return res.json();
  }

  async closedTrades(max = 2000) {
    const out = [];
    for (let offset = 0; offset < max; offset += 500) {
      const page = await this.request(`/trades?limit=500&offset=${offset}`);
      out.push(...page.trades.filter((t) => !t.is_open));
      if (offset + 500 >= page.total_trades) break;
    }
    return out;
  }

  // Everything the dashboard needs, mapped to its own shapes.
  async snapshot(now = Date.now()) {
    const [open, closed, balance, config, whitelist] = await Promise.all([
      this.request('/status'), this.closedTrades(), this.request('/balance'), this.request('/show_config'), this.request('/whitelist'),
    ]);
    const prices = [];
    for (const pair of whitelist.whitelist || []) {
      try {
        const res = await this.request(`/pair_candles?pair=${encodeURIComponent(pair)}&timeframe=${config.timeframe || '4h'}&limit=200`);
        const p = mapCandles(toPair(pair), res);
        if (p) prices.push(p);
      } catch { /* one pair failing should not hide the rest */ }
    }
    return {
      trades: closed.map(mapClosedTrade).sort((a, b) => a.closedAt - b.closedAt),
      positions: open.map((t) => mapOpenTrade(t, now)),
      equity: balance.total_bot ?? balance.total,
      startCapital: balance.starting_capital,
      prices,
      dryRun: !!config.dry_run,
      // stopentry sets max_open_trades to 0; reload_config restores it
      running: config.state === 'running' && config.max_open_trades !== 0,
      strategy: config.strategy,
    };
  }

  // Pause = no new entries (open trades stay managed); resume reloads the configured limits.
  async setRunning(on) {
    await this.request(on ? '/reload_config' : '/stopentry', { method: 'POST' });
  }
}
