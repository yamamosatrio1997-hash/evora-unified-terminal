import { mulberry32, gauss, pick, clamp } from './rng.js';
import {
  START_EQUITY, MONTHLY_TARGET, RISK_PCT, LEVERAGE, FEE_SIDE, FEE_STRESS_SIDE, MAX_SL, TARGETS, cycleFor,
  PAIRS, BOTS, STRATEGIES, TIMEFRAMES, EXITS, DIRECTIONS, RULE,
} from './data.js';

export const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const MAX_TRADES = 2000;
const MAX_LOGS = 120;
const SPARK_EVERY = 5; // seconds between sparkline samples
const TIME_STOP = 40 * MIN;

const sideSign = (side) => (side === 'LONG' ? 1 : -1);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function sessionOf(t) {
  const h = new Date(t).getUTCHours();
  if (h < 7) return 'Asia';
  if (h < 13) return 'London';
  if (h < 21) return 'New York';
  return 'Asia';
}

// ---------- statistics helpers (pure, exported for tests) ----------

export function tradeStats(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winRate: 0, pf: 0, avgR: 0, pnl: 0, sdR: 0 };
  let wins = 0, gw = 0, gl = 0, sumR = 0, pnl = 0, sumR2 = 0;
  for (const t of trades) {
    if (t.pnl > 0) { wins++; gw += t.pnl; } else gl -= t.pnl;
    sumR += t.r; sumR2 += t.r * t.r; pnl += t.pnl;
  }
  const avgR = sumR / n;
  const sdR = Math.sqrt(Math.max(0, sumR2 / n - avgR * avgR));
  return { n, winRate: wins / n, pf: gl === 0 ? (gw > 0 ? 99 : 0) : gw / gl, avgR, pnl, sdR };
}

export function maxDrawdown(points) {
  let peak = -Infinity, dd = 0;
  for (const p of points) {
    if (p.v > peak) peak = p.v;
    const d = (p.v - peak) / peak;
    if (d < dd) dd = d;
  }
  return dd;
}

export function evaluateCell(c) {
  const fails = [];
  if (c.n < RULE.minN) fails.push(`n ${c.n} < ${RULE.minN}`);
  if (!(c.half1 > 0 && c.half2 > 0)) fails.push('paruh tidak sama-sama positif');
  if (c.pf < RULE.minPF) fails.push(`PF ${c.pf.toFixed(2)} < ${RULE.minPF}`);
  if (c.avgR < RULE.minAvgR) fails.push(`rata-rata ${c.avgR.toFixed(2)}R < ${RULE.minAvgR}R`);
  if (c.lcb < RULE.minLcbR) fails.push(`LCB ${c.lcb.toFixed(2)}R < ${RULE.minLcbR}R`);
  return { active: fails.length === 0, fails };
}

export function downsample(points, step, from = -Infinity) {
  const out = [];
  for (const p of points) {
    if (p.t < from) continue;
    const b = Math.floor(p.t / step) * step;
    if (out.length && out[out.length - 1].t === b) out[out.length - 1].v = p.v;
    else out.push({ t: b, v: p.v });
  }
  return out;
}

function percentile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// ---------- engine ----------

export class Engine {
  constructor({ seed = 1997, now = Date.now(), saved = null } = {}) {
    this.seed = seed;
    this.rng = mulberry32((seed * 7919 + Math.floor(now / 1000)) >>> 0);
    this.running = true;
    this.bootAt = now;
    this.now = now;
    this.seq = 1;
    this.positions = [];
    this.pending = [];
    this.trades = [];
    this.logs = [];
    this.equityMin = [];
    this.equityHour = [];
    this.market = {};
    this.tickCount = 0;
    this.cells = this.#buildCells(mulberry32(seed + 11));

    if (saved && saved.v === 1) this.#restore(saved, now);
    else this.#seedHistory(mulberry32(seed), now);
  }

  // ----- seeding -----

  #initMarket(rng, now) {
    for (const p of PAIRS) {
      const hourly = [];
      let price = p.price;
      const hv = p.vol * 60 * 0.2; // calmer hourly path for history
      for (let i = 0; i < 24 * 400; i++) {
        hourly.push(price);
        price = price / Math.exp(hv * gauss(rng) + 0.00002);
      }
      hourly.reverse(); // oldest first, newest = current price
      this.market[p.sym] = {
        sym: p.sym, base: p.base, color: p.color, vol: p.vol,
        price: p.price, emaFast: p.price, emaSlow: p.price,
        drift: 0, driftLeft: 0, garchVar: p.vol * p.vol,
        rets: [], spark: Array(60).fill(p.price),
        hist: hourly, // hourly closes, last = now
      };
    }
    // warm up EMAs and sparklines with a few minutes of ticks
    this.lastHour = Math.floor(now / HOUR) * HOUR;
    for (let i = 0; i < 900; i++) this.#stepMarket(now - (900 - i) * SEC);
  }

  #outcomeProbs(bot, tags) {
    let pSL = 0.38, pTP1 = 0.2, pTP2 = 0.285, pTIME = 0.12;
    if (!tags.aligned) pSL += 0.13;
    if (tags.volRegime === 'tinggi') pSL += 0.07;
    if (tags.volRegime === 'rendah') pTIME += 0.06;
    if (bot.style === 'trend' && tags.session === 'Asia') pSL += 0.06;
    if (bot.style === 'revert' && tags.session === 'New York') pSL += 0.05;
    const s = pSL + pTP1 + pTP2 + pTIME;
    return { pSL: pSL / s, pTP1: pTP1 / s, pTP2: pTP2 / s, pTIME: pTIME / s };
  }

  #seedHistory(rng, now) {
    this.#initMarket(rng, now);
    const t0 = now - 365 * DAY;
    const raw = [];
    for (const bot of BOTS) {
      let t = t0 + rng() * DAY;
      while (t < now - 30 * MIN) {
        t += (-Math.log(1 - rng()) * DAY) / 0.62;
        if (t >= now - 30 * MIN) break;
        raw.push({ bot, closedAt: t });
      }
    }
    raw.sort((a, b) => a.closedAt - b.closedAt);

    let balance = START_EQUITY;
    for (const { bot, closedAt } of raw) {
      const openedAt = closedAt - (8 + rng() * 40) * MIN;
      const pair = pick(rng, bot.pairs);
      const m = this.market[pair];
      const hIdx = clamp(m.hist.length - 1 - Math.floor((now - openedAt) / HOUR), 0, m.hist.length - 1);
      const entry = m.hist[hIdx];
      const tags = {
        session: sessionOf(openedAt),
        volRegime: rng() < 0.22 ? 'tinggi' : rng() < 0.3 ? 'rendah' : 'normal',
        aligned: rng() < 0.7,
      };
      const pr = this.#outcomeProbs(bot, tags);
      const u = rng();
      let status, r;
      if (u < pr.pSL) { status = 'SL'; r = -1; }
      else if (u < pr.pSL + pr.pTP1) { status = 'TP1'; r = 0.5; }
      else if (u < pr.pSL + pr.pTP1 + pr.pTP2) { status = 'TP2'; r = 0.5 + 0.5 * bot.rr; }
      else { status = 'TIME'; r = -0.6 + rng() * 1.4; }
      const slPct = 0.012 + rng() * 0.018;
      const side = rng() < 0.62 ? 'LONG' : 'SHORT';
      const riskUsd = balance * RISK_PCT;
      const notional = riskUsd / slPct;
      const fee = notional * FEE_SIDE * 2;
      const pnl = r * riskUsd - fee;
      balance += pnl;
      const conf = clamp(1 - pr.pSL - 0.05 + gauss(rng) * 0.07, 0.35, 0.85);
      this.trades.push({
        id: this.seq++, bot: bot.id, botName: bot.name, strategy: bot.strategy, tf: bot.tf,
        pair, side, entry: round(entry, 6),
        exit: round(entry * (1 + sideSign(side) * slPct * r), 6),
        qty: notional / entry, openedAt, closedAt, pnl: round(pnl), r: round(pnl / riskUsd, 3),
        status, conf: round(conf, 3), tags, fee: round(fee),
      });
    }
    this.balance = balance;

    // equity series rebuilt from closed trades
    const all = this.trades;
    let idx = 0, eq = START_EQUITY;
    const hStart = Math.floor(t0 / HOUR) * HOUR;
    for (let t = hStart; t <= now; t += HOUR) {
      while (idx < all.length && all[idx].closedAt <= t) eq += all[idx++].pnl;
      this.equityHour.push({ t, v: round(eq + gauss(rng) * 4) });
    }
    idx = 0; eq = START_EQUITY;
    const mStart = Math.floor((now - DAY) / MIN) * MIN;
    for (let t = mStart; t <= now; t += MIN) {
      while (idx < all.length && all[idx].closedAt <= t) eq += all[idx++].pnl;
      this.equityMin.push({ t, v: round(eq + gauss(rng) * 0.8) });
    }
    const last = this.equityMin[this.equityMin.length - 1];
    last.v = round(balance);
    if (this.trades.length > MAX_TRADES) this.trades = this.trades.slice(-MAX_TRADES);

    for (const t of this.trades.slice(-14)) this.#logClose(t, t.closedAt);
    this.#log('system', now, 'Engine dimulai', 'Mode paper · 10x · simulasi harga', null, 'info');
  }

  #buildCells(rng) {
    const cells = [];
    STRATEGIES.forEach((name, si) => {
      const combos = [];
      for (const tf of TIMEFRAMES) for (const exit of EXITS) for (const dir of DIRECTIONS) combos.push({ tf, exit, dir });
      for (let i = combos.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [combos[i], combos[j]] = [combos[j], combos[i]];
      }
      const count = si < 10 ? 9 : 8;
      const skill = gauss(rng) * 0.06;
      for (const { tf, exit, dir } of combos.slice(0, count)) {
        const n = Math.round(clamp(110 + rng() * 210, 40, RULE.window));
        const fast = tf === '15m' || tf === '5m';
        const edge = skill + gauss(rng) * 0.08 + (fast ? -0.08 : 0.03) + (dir === cycleFor(Date.now()) ? 0.03 : -0.03);
        const sd = 1.1;
        const avgR = edge + (gauss(rng) * sd) / Math.sqrt(n);
        const half1 = avgR + (gauss(rng) * sd) / Math.sqrt(n / 2) * 0.7;
        const half2 = 2 * avgR - half1;
        const pf = Math.max(0.3, 1 + avgR * 2.1 + gauss(rng) * 0.04);
        const lcb = avgR - (1.645 * sd) / Math.sqrt(n);
        const c = {
          id: `${si}-${tf}-${exit}-${dir}`, strategy: name, tf, exit, dir, n,
          avgR: round(avgR, 3), half1: round(half1, 3), half2: round(half2, 3), pf: round(pf, 2), lcb: round(lcb, 3),
          winRate: round(clamp(0.42 + avgR * 0.35 + gauss(rng) * 0.03, 0.25, 0.7), 3),
        };
        const ev = evaluateCell(c);
        c.active = ev.active;
        c.fails = ev.fails;
        c.status = ev.active ? 'Aktif' : (c.avgR > 0 && c.n >= 150 ? 'Pantau' : 'Nonaktif');
        c.forward = BOTS.some((b) => b.strategy === name && b.tf === tf);
        cells.push(c);
      }
    });
    return cells;
  }

  #restore(s, now) {
    this.seq = s.seq;
    this.balance = s.balance;
    this.trades = s.trades;
    this.logs = s.logs;
    this.positions = s.positions || [];
    this.pending = s.pending || [];
    this.equityMin = s.equityMin;
    this.equityHour = s.equityHour;
    this.market = s.market;
    this.lastHour = Math.floor(now / HOUR) * HOUR;
    for (const m of Object.values(this.market)) { m.rets = []; m.drift = 0; m.driftLeft = 0; }
    // fill the offline gap with flat equity
    const v = this.equity();
    for (let t = this.equityMin.at(-1).t + MIN; t <= now; t += MIN) this.equityMin.push({ t, v: round(v) });
    for (let t = this.equityHour.at(-1).t + HOUR; t <= now; t += HOUR) this.equityHour.push({ t, v: round(v) });
    this.equityMin = this.equityMin.slice(-1441);
    this.#log('system', now, 'Engine dilanjutkan', 'State dipulihkan dari disk', null, 'info');
  }

  serialize() {
    return {
      v: 1, savedAt: this.now, seq: this.seq, balance: this.balance,
      trades: this.trades, logs: this.logs, positions: this.positions, pending: this.pending,
      equityMin: this.equityMin, equityHour: this.equityHour, market: this.market,
    };
  }

  // ----- live simulation -----

  #stepMarket(now) {
    const newHour = now - this.lastHour >= HOUR;
    for (const m of Object.values(this.market)) {
      if (m.driftLeft <= 0) {
        m.drift = gauss(this.rng) * m.vol * 0.045;
        m.driftLeft = -Math.log(1 - this.rng()) * 900;
      }
      m.driftLeft--;
      const r = m.drift + m.vol * gauss(this.rng);
      m.price *= Math.exp(r);
      m.rets.push(r);
      if (m.rets.length > 300) m.rets.shift();
      m.emaFast += (2 / 121) * (m.price - m.emaFast);
      m.emaSlow += (2 / 601) * (m.price - m.emaSlow);
      const a = 0.08, b = 0.9;
      m.garchVar = m.vol * m.vol * (1 - a - b) + a * r * r + b * m.garchVar;
      if (this.tickCount % SPARK_EVERY === 0) { m.spark.push(m.price); if (m.spark.length > 60) m.spark.shift(); }
      if (newHour) { m.hist.push(m.price); if (m.hist.length > 24 * 400) m.hist.shift(); }
      else m.hist[m.hist.length - 1] = m.price;
    }
    if (newHour) this.lastHour = Math.floor(now / HOUR) * HOUR;
    this.tickCount++;
  }

  trendStrength(m) {
    return (m.emaFast - m.emaSlow) / m.emaSlow / (m.vol * Math.sqrt(300));
  }

  bias(m) { return m.emaFast >= m.emaSlow ? 'LONG' : 'SHORT'; }

  volRegime(m) {
    const ratio = Math.sqrt(m.garchVar) / m.vol;
    return ratio > 1.15 ? 'tinggi' : ratio < 0.88 ? 'rendah' : 'normal';
  }

  tick(now = Date.now()) {
    this.now = now;
    this.#stepMarket(now);
    if (this.running) {
      this.#managePending(now);
      this.#managePositions(now);
      for (const bot of BOTS) this.#maybeSignal(bot, now);
    }
    this.#updateEquitySeries(now);
  }

  #maybeSignal(bot, now) {
    const busy = this.positions.filter((p) => p.bot === bot.id).length + this.pending.filter((p) => p.bot === bot.id).length;
    if (busy >= 2 || this.rng() > 1 / 40) return;
    const free = bot.pairs.filter((s) => !this.positions.some((p) => p.bot === bot.id && p.pair === s) && !this.pending.some((p) => p.bot === bot.id && p.pair === s));
    if (!free.length) return;
    const pair = pick(this.rng, free);
    const m = this.market[pair];
    const strength = this.trendStrength(m);
    let side;
    if (bot.style === 'trend') side = strength >= 0 ? 'LONG' : 'SHORT';
    else side = m.price > m.emaFast ? 'SHORT' : 'LONG';
    const tags = { session: sessionOf(now), volRegime: this.volRegime(m), aligned: side === this.bias(m) };
    const conf = clamp(0.5 + 0.1 * Math.abs(strength) * (tags.aligned ? 1 : -1) - (tags.volRegime === 'tinggi' ? 0.05 : 0) + gauss(this.rng) * 0.05, 0.35, 0.85);

    if (conf < 0.42) {
      this.#log('signal', now, `Sinyal ${bot.name} dilewati`, `${pair} (${side}) · conf ${(conf * 100).toFixed(0)}%`, side, 'muted');
      return;
    }
    const slPct = clamp(m.vol * Math.sqrt(600) * 1.5, 0.008, MAX_SL);
    const plan = { bot: bot.id, pair, side, slPct, conf, tags, rr: bot.rr };
    if (this.rng() < 0.45) {
      const limit = m.price * (1 - sideSign(side) * slPct * 0.3);
      this.pending.push({ id: this.seq++, ...plan, botName: bot.name, limit, createdAt: now, expiresAt: now + 6 * MIN });
      this.#log('signal', now, `Signal detected · limit ${bot.name}`, `${pair} (${side}) @ ${fmtPx(limit)}`, side, 'purple');
    } else {
      this.#open(plan, m.price, now);
    }
  }

  #open(plan, price, now) {
    const bot = BOTS.find((b) => b.id === plan.bot);
    const s = sideSign(plan.side);
    const slDist = price * plan.slPct;
    const riskUsd = this.equity() * RISK_PCT;
    const qty = riskUsd / slDist;
    const fee = qty * price * FEE_SIDE;
    const pos = {
      id: this.seq++, bot: bot.id, botName: bot.name, strategy: bot.strategy, tf: bot.tf,
      pair: plan.pair, side: plan.side, entry: price, qty, qtyOpen: qty, riskUsd,
      sl: price - s * slDist, initialSl: price - s * slDist,
      tp1: price + s * slDist, tp2: price + s * slDist * plan.rr,
      tp1Hit: false, realized: -fee, fees: fee, openedAt: now, conf: plan.conf, tags: plan.tags, exitValue: 0,
    };
    this.positions.push(pos);
    this.#log(plan.side === 'LONG' ? 'buy' : 'sell', now, `Bot ${bot.name} opened ${plan.side}`, `${plan.pair} @ ${fmtPx(price)} · ${(plan.rr + 0).toFixed(1)}RR`, plan.side, plan.side === 'LONG' ? 'green' : 'red');
  }

  #managePending(now) {
    for (const o of [...this.pending]) {
      const px = this.market[o.pair].price;
      const filled = o.side === 'LONG' ? px <= o.limit : px >= o.limit;
      if (filled) {
        this.pending = this.pending.filter((x) => x !== o);
        this.#open(o, o.limit, now);
      } else if (now >= o.expiresAt) {
        this.pending = this.pending.filter((x) => x !== o);
        this.#log('system', now, `Limit ${o.botName} kedaluwarsa`, `${o.pair} (${o.side}) tidak terisi`, o.side, 'muted');
      }
    }
  }

  #fill(pos, qty, price) {
    const fee = qty * price * FEE_SIDE;
    pos.realized += (price - pos.entry) * qty * sideSign(pos.side) - fee;
    pos.fees += fee;
    pos.exitValue += qty * price;
    pos.qtyOpen -= qty;
  }

  #managePositions(now) {
    for (const pos of [...this.positions]) {
      const px = this.market[pos.pair].price;
      const s = sideSign(pos.side);
      const beyond = (lvl) => (px - lvl) * s >= 0;
      if (!pos.tp1Hit && beyond(pos.tp1)) {
        this.#fill(pos, pos.qtyOpen / 2, pos.tp1);
        pos.tp1Hit = true;
        pos.sl = pos.entry;
        this.#log('tp', now, `TP1 hit (+${(pos.realized / pos.riskUsd).toFixed(2)}R)`, `${pos.pair} · stop → breakeven`, pos.side, 'green');
      }
      let status = null, price = px;
      if ((pos.sl - px) * s >= 0) { status = pos.tp1Hit ? 'TP1' : 'SL'; price = pos.sl; }
      else if (beyond(pos.tp2)) { status = 'TP2'; price = pos.tp2; }
      else if (now - pos.openedAt >= TIME_STOP) status = 'TIME';
      if (status) this.#close(pos, price, status, now);
    }
  }

  #close(pos, price, status, now) {
    this.#fill(pos, pos.qtyOpen, price);
    this.positions = this.positions.filter((p) => p !== pos);
    const pnl = pos.realized; // net of entry + exit fees
    this.balance += pnl;
    const trade = {
      id: pos.id, bot: pos.bot, botName: pos.botName, strategy: pos.strategy, tf: pos.tf,
      pair: pos.pair, side: pos.side, entry: round(pos.entry, 6), exit: round(pos.exitValue / pos.qty, 6),
      qty: pos.qty, openedAt: pos.openedAt, closedAt: now, pnl: round(pnl), r: round(pnl / pos.riskUsd, 3),
      status, conf: round(pos.conf, 3), tags: pos.tags, fee: round(pos.fees),
    };
    this.trades.push(trade);
    if (this.trades.length > MAX_TRADES) this.trades.shift();
    this.#logClose(trade, now);
  }

  #logClose(t, now) {
    const pct = ((t.exit - t.entry) / t.entry) * 100 * sideSign(t.side);
    const sign = pct >= 0 ? '+' : '';
    if (t.status === 'SL') this.#log('sl', now, `Stop loss · ${t.botName}`, `${t.pair} (${t.r.toFixed(2)}R)`, t.side, 'red', t.id);
    else if (t.status === 'TIME') this.#log('system', now, `Time stop · ${t.botName}`, `${t.pair} (${sign}${pct.toFixed(2)}%)`, t.side, t.pnl >= 0 ? 'green' : 'red', t.id);
    else this.#log('tp', now, `${t.status} hit · ${t.botName}`, `${t.pair} (${sign}${pct.toFixed(2)}% · ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R)`, t.side, 'green', t.id);
  }

  #log(kind, t, text, sub, side, tone, ref = null) {
    this.logs.push({ id: this.seq++, t, kind, text, sub, side, tone, ref });
    if (this.logs.length > MAX_LOGS) this.logs.shift();
  }

  #updateEquitySeries(now) {
    const v = round(this.equity());
    const mb = Math.floor(now / MIN) * MIN;
    const lm = this.equityMin.at(-1);
    if (lm && lm.t === mb) lm.v = v;
    else { this.equityMin.push({ t: mb, v }); if (this.equityMin.length > 1441) this.equityMin.shift(); }
    const hb = Math.floor(now / HOUR) * HOUR;
    const lh = this.equityHour.at(-1);
    if (lh && lh.t === hb) lh.v = v;
    else { this.equityHour.push({ t: hb, v }); if (this.equityHour.length > 24 * 400) this.equityHour.shift(); }
  }

  setRunning(on) {
    this.running = !!on;
    this.#log('system', this.now, on ? 'Bot dilanjutkan' : 'Bot dijeda', on ? 'Sinyal baru diizinkan' : 'Posisi terbuka dibekukan, tidak ada entry baru', null, on ? 'green' : 'yellow');
  }

  // ----- derived views -----

  unrealized() {
    let u = 0;
    for (const p of this.positions) u += (this.market[p.pair].price - p.entry) * p.qtyOpen * sideSign(p.side);
    return u;
  }

  equity() { return this.balance + this.unrealized() + this.positions.reduce((s, p) => s + p.realized, 0); }

  usedMargin() {
    return this.positions.reduce((s, p) => s + (p.qtyOpen * this.market[p.pair].price) / LEVERAGE, 0);
  }

  #window(from, to = Infinity) { return this.trades.filter((t) => t.closedAt >= from && t.closedAt < to); }

  account() {
    const eq = this.equity();
    const dayStart = this.#valueAt(this.equityMin, this.now - DAY) ?? eq;
    const today = eq - dayStart;
    return {
      equity: round(eq), balance: round(this.balance), unrealized: round(eq - this.balance),
      available: round(eq - this.usedMargin()), todayPnl: round(today), todayPct: dayStart ? today / dayStart : 0,
      startEquity: START_EQUITY, totalPct: (eq - START_EQUITY) / START_EQUITY,
    };
  }

  #valueAt(series, t) {
    for (let i = series.length - 1; i >= 0; i--) if (series[i].t <= t) return series[i].v;
    return series[0]?.v;
  }

  kpis() {
    const now = this.now;
    const cur = tradeStats(this.#window(now - 30 * DAY));
    const prev = tradeStats(this.#window(now - 60 * DAY, now - 30 * DAY));
    const ddCur = maxDrawdown(this.equityHour.filter((p) => p.t >= now - 30 * DAY));
    const ddPrev = maxDrawdown(this.equityHour.filter((p) => p.t >= now - 60 * DAY && p.t < now - 30 * DAY));
    const today = this.#window(now - DAY).length;
    return {
      winRate: cur.winRate, winRateDelta: cur.winRate - prev.winRate,
      trades: cur.n, tradesToday: today,
      pf: cur.pf, pfDelta: cur.pf - prev.pf,
      maxDD: ddCur, maxDDDelta: ddCur - ddPrev,
      avgR: cur.avgR,
    };
  }

  botsView() {
    const from = this.now - 30 * DAY;
    return BOTS.map((b) => {
      const ts = this.trades.filter((t) => t.bot === b.id && t.closedAt >= from);
      const st = tradeStats(ts);
      const open = this.positions.filter((p) => p.bot === b.id);
      const unreal = open.reduce((s, p) => s + p.realized + (this.market[p.pair].price - p.entry) * p.qtyOpen * sideSign(p.side), 0);
      const monthPnl = st.pnl + unreal;
      return {
        id: b.id, name: b.name, pairs: b.pairs, color: b.color, tf: b.tf, style: b.style, rr: b.rr,
        monthPnl: round(monthPnl), progress: monthPnl / MONTHLY_TARGET, trades: st.n, winRate: st.winRate,
        avgR: st.avgR, pf: st.pf, open: open.length, status: !this.running ? 'paused' : open.length ? 'in-trade' : 'scanning',
      };
    });
  }

  pricesView() {
    return Object.values(this.market).map((m) => {
      const h = m.hist;
      const p24 = h[Math.max(0, h.length - 25)];
      return {
        sym: m.sym, base: m.base, color: m.color, price: m.price, chg24: (m.price - p24) / p24,
        bias: this.bias(m), strength: round(this.trendStrength(m), 3), regime: this.volRegime(m),
        spark: m.spark.map((x) => +x.toPrecision(6)),
      };
    });
  }

  positionsView() {
    return this.positions.map((p) => {
      const px = this.market[p.pair].price;
      const upnl = p.realized + (px - p.entry) * p.qtyOpen * sideSign(p.side);
      return {
        id: p.id, bot: p.bot, botName: p.botName, pair: p.pair, side: p.side, entry: p.entry, price: px,
        sl: p.sl, initialSl: p.initialSl, tp1: p.tp1, tp2: p.tp2, tp1Hit: p.tp1Hit, qty: p.qty, qtyOpen: p.qtyOpen,
        notional: p.qtyOpen * px, margin: (p.qtyOpen * px) / LEVERAGE, upnl: round(upnl), r: upnl / p.riskUsd,
        openedAt: p.openedAt, timeLeft: Math.max(0, p.openedAt + TIME_STOP - this.now), conf: p.conf, tags: p.tags,
      };
    });
  }

  pendingView() {
    return this.pending.map((o) => ({
      id: o.id, botName: o.botName, pair: o.pair, side: o.side, limit: o.limit, price: this.market[o.pair].price,
      createdAt: o.createdAt, expiresAt: o.expiresAt, conf: o.conf, distance: (this.market[o.pair].price - o.limit) / o.limit,
    }));
  }

  allocation() {
    const from = this.now - 30 * DAY;
    const counts = {};
    let total = 0;
    for (const t of this.trades) {
      if (t.closedAt < from) continue;
      const base = t.pair.split('/')[0];
      counts[base] = (counts[base] || 0) + Math.abs(t.qty * t.entry);
      total += Math.abs(t.qty * t.entry);
    }
    const rows = Object.entries(counts).map(([label, v]) => ({ label, pct: total ? v / total : 0 })).sort((a, b) => b.pct - a.pct);
    const top = rows.slice(0, 5);
    const rest = rows.slice(5).reduce((s, r) => s + r.pct, 0);
    if (rest > 0) top.push({ label: 'Lainnya', pct: rest });
    return top;
  }

  snapshot() {
    const bots = this.botsView();
    return {
      t: this.now, running: this.running, uptime: this.now - this.bootAt,
      account: this.account(), kpi: this.kpis(), prices: this.pricesView(),
      positions: this.positionsView(), pending: this.pendingView(), bots,
      allocation: this.allocation(), logs: this.logs.slice(-30),
      recentTrades: this.trades.slice(-8).reverse(),
      verdict: this.verdict(),
      equityPoint: { v: round(this.equity()) },
    };
  }

  // Four project targets, judged on the whole paper book over the last 30 days.
  verdict() {
    const st = tradeStats(this.#window(this.now - 30 * DAY));
    const dd = maxDrawdown(this.equityHour.filter((p) => p.t >= this.now - 30 * DAY));
    const monthly = this.equity() - (this.#valueAt(this.equityHour, this.now - 30 * DAY) ?? this.equity());
    const checks = [
      { key: 'winRate', label: 'Win rate ≥ 70%', value: st.winRate, ok: st.winRate >= TARGETS.winRate },
      { key: 'maxDD', label: 'Drawdown < 10%', value: dd, ok: -dd < TARGETS.maxDD },
      { key: 'pf', label: 'Profit factor > 3', value: st.pf, ok: st.pf > TARGETS.pf },
      { key: 'monthly', label: '$1.000 / bulan', value: monthly, ok: monthly >= TARGETS.monthly },
    ];
    return { hit: checks.filter((c) => c.ok).length, total: checks.length, checks };
  }

  equitySeries(range = '1D') {
    const now = this.now;
    const cfg = {
      '1D': { src: this.equityMin, from: now - DAY, step: 5 * MIN },
      '1W': { src: this.equityHour, from: now - 7 * DAY, step: HOUR },
      '1M': { src: this.equityHour, from: now - 30 * DAY, step: 2 * HOUR },
      '3M': { src: this.equityHour, from: now - 90 * DAY, step: 6 * HOUR },
      '1Y': { src: this.equityHour, from: now - 365 * DAY, step: DAY },
      'ALL': { src: this.equityHour, from: -Infinity, step: DAY },
    }[range];
    if (!cfg) return null;
    return { range, step: cfg.step, target: MONTHLY_TARGET, points: downsample(cfg.src, cfg.step, cfg.from) };
  }

  strategiesView() {
    const byStrategy = STRATEGIES.map((name) => {
      const cells = this.cells.filter((c) => c.strategy === name);
      const best = cells.reduce((a, b) => (b.avgR > a.avgR ? b : a));
      return {
        name, cells, active: cells.filter((c) => c.active).length, best: best.avgR,
        forward: BOTS.some((b) => b.strategy === name),
      };
    }).sort((a, b) => b.best - a.best);
    const cycle = cycleFor(this.now);
    const mainBook = this.cells.filter((c) => c.active && RULE.mainBookTFs.includes(c.tf) && c.dir === cycle);
    return { rule: RULE, cycle, strategies: byStrategy, totalCells: this.cells.length, activeCells: this.cells.filter((c) => c.active).length, mainBook };
  }

  lessonsView() {
    const conds = [
      ['Melawan bias trend', (t) => !t.tags.aligned],
      ['Volatilitas tinggi', (t) => t.tags.volRegime === 'tinggi'],
      ['Volatilitas rendah', (t) => t.tags.volRegime === 'rendah'],
      ['Sesi Asia', (t) => t.tags.session === 'Asia'],
      ['Sesi London', (t) => t.tags.session === 'London'],
      ['Sesi New York', (t) => t.tags.session === 'New York'],
      ['Confidence < 50%', (t) => t.conf < 0.5],
    ];
    const evalSet = (ts) => {
      const base = tradeStats(ts);
      const slRate = ts.filter((t) => t.status === 'SL').length / (ts.length || 1);
      const rows = conds.map(([label, fn]) => {
        const sub = ts.filter(fn);
        const st = tradeStats(sub);
        const sl = sub.filter((t) => t.status === 'SL').length / (sub.length || 1);
        return { label, n: st.n, avgR: st.avgR, delta: st.avgR - base.avgR, slRate: sl, slLift: sl - slRate };
      }).filter((r) => r.n >= 8).sort((a, b) => a.delta - b.delta);
      return { base: { ...base, slRate }, rows };
    };
    const recent = this.trades.slice(-600);
    const perStrategy = BOTS.map((b) => ({ bot: b.id, name: b.name, color: b.color, ...evalSet(recent.filter((t) => t.bot === b.id)) }));
    const cross = evalSet(recent);
    const lossesRecent = recent.filter((t) => t.status === 'SL').slice(-6).reverse();
    return { perStrategy, cross, lossesRecent, sample: recent.length };
  }

  learningView() {
    // calibration: confidence buckets vs realized win rate
    const buckets = [];
    for (let lo = 0.35; lo < 0.85; lo += 0.1) {
      const sub = this.trades.filter((t) => t.conf >= lo && t.conf < lo + 0.1);
      if (sub.length < 5) continue;
      buckets.push({
        lo: round(lo), hi: round(lo + 0.1), n: sub.length,
        predicted: sub.reduce((s, t) => s + t.conf, 0) / sub.length,
        actual: sub.filter((t) => t.pnl > 0).length / sub.length,
      });
    }
    // walk-forward: 6 windows of 60 days, 40d in-sample → 20d out-of-sample
    const wf = [];
    for (let k = 5; k >= 0; k--) {
      const end = this.now - k * 60 * DAY;
      const is = tradeStats(this.#window(end - 60 * DAY, end - 20 * DAY));
      const oos = tradeStats(this.#window(end - 20 * DAY, end));
      wf.push({ end, isPF: is.pf, oosPF: oos.pf, isN: is.n, oosN: oos.n, oosR: oos.avgR });
    }
    const st = tradeStats(this.trades.slice(-300));
    const wins = this.trades.slice(-300).filter((t) => t.r > 0);
    const losses = this.trades.slice(-300).filter((t) => t.r <= 0);
    const avgWin = wins.reduce((s, t) => s + t.r, 0) / (wins.length || 1);
    const avgLoss = -losses.reduce((s, t) => s + t.r, 0) / (losses.length || 1);
    const b = avgLoss ? avgWin / avgLoss : 0;
    const kelly = b ? st.winRate - (1 - st.winRate) / b : 0;
    return {
      calibration: buckets, walkForward: wf,
      sizing: { winRate: st.winRate, payoff: b, kelly, quarterKelly: Math.max(0, kelly / 4), current: RISK_PCT },
    };
  }

  targetMath() {
    const st = tradeStats(this.trades.slice(-300));
    const perMonth = this.#window(this.now - 30 * DAY).length;
    const riskUsd = this.equity() * RISK_PCT;
    const expected = st.avgR * riskUsd * perMonth;
    // extra cost per trade if fees double to the 0.30% stress level, expressed in R
    const recent = this.trades.slice(-300);
    const stressR = recent.reduce((s, t) => s + (t.fee * (FEE_STRESS_SIDE / FEE_SIDE - 1)) / (Math.abs(t.pnl / (t.r || 1)) || 1), 0) / (recent.length || 1);
    return {
      avgR: st.avgR, avgRStress: st.avgR - stressR, riskUsd, tradesPerMonth: perMonth, expectedMonthly: expected,
      expectedMonthlyStress: (st.avgR - stressR) * riskUsd * perMonth, target: MONTHLY_TARGET,
      requiredTrades: st.avgR > 0 ? MONTHLY_TARGET / (st.avgR * riskUsd) : null,
      requiredRiskPct: st.avgR > 0 && perMonth ? MONTHLY_TARGET / (st.avgR * perMonth) / this.equity() : null,
    };
  }

  predictiveView({ paths = 400, days = 30 } = {}) {
    const rng = mulberry32((this.seed + Math.floor(this.now / MIN)) >>> 0);
    const rs = this.trades.slice(-300).map((t) => t.r);
    const perDay = this.#window(this.now - 30 * DAY).length / 30;
    const eq0 = this.equity();
    const riskUsd = eq0 * RISK_PCT;
    const series = Array.from({ length: days + 1 }, () => []);
    let hit = 0, dd10 = 0;
    for (let p = 0; p < paths; p++) {
      let eq = eq0, peak = eq0, worst = 0;
      series[0].push(eq);
      for (let d = 1; d <= days; d++) {
        // Poisson trade count via inversion
        let k = 0, L = Math.exp(-perDay), q = 1;
        do { k++; q *= rng(); } while (q > L);
        for (let i = 0; i < k - 1; i++) eq += rs[Math.floor(rng() * rs.length)] * riskUsd;
        peak = Math.max(peak, eq);
        worst = Math.min(worst, (eq - peak) / peak);
        series[d].push(eq);
      }
      if (eq - eq0 >= MONTHLY_TARGET) hit++;
      if (worst <= -0.1) dd10++;
    }
    const bands = series.map((vals, d) => {
      vals.sort((a, b) => a - b);
      return { d, p5: percentile(vals, 0.05), p25: percentile(vals, 0.25), p50: percentile(vals, 0.5), p75: percentile(vals, 0.75), p95: percentile(vals, 0.95) };
    });
    const vols = Object.values(this.market).map((m) => {
      const s = Math.sqrt(m.garchVar);
      const pTrend = 1 / (1 + Math.exp(-(Math.abs(this.trendStrength(m)) - 0.8) * 3));
      return { sym: m.sym, base: m.base, color: m.color, volNow: s * Math.sqrt(3600), volBase: m.vol * Math.sqrt(3600), pTrend, bias: this.bias(m) };
    });
    return { paths, days, perDay, eq0, bands, probTarget: hit / paths, probDD10: dd10 / paths, vols };
  }
}

export function fmtPx(x) {
  if (x >= 1000) return x.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (x >= 1) return x.toFixed(2);
  return x.toFixed(4);
}
