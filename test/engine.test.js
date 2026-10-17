import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, tradeStats, maxDrawdown, evaluateCell, downsample, MIN, HOUR } from '../server/engine.js';
import { MAX_SL, RULE } from '../server/data.js';

test('tradeStats computes win rate, profit factor and average R', () => {
  const s = tradeStats([{ pnl: 20, r: 2 }, { pnl: -10, r: -1 }, { pnl: -10, r: -1 }, { pnl: 5, r: 0.5 }]);
  assert.equal(s.n, 4);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.pf, 25 / 20);
  assert.equal(s.avgR, 0.125);
});

test('maxDrawdown finds the deepest peak-to-trough fall', () => {
  const dd = maxDrawdown([100, 120, 90, 130, 117].map((v, t) => ({ t, v })));
  assert.equal(dd, -0.25);
});

test('evaluateCell applies every v1.2c condition', () => {
  const good = { n: 250, half1: 0.2, half2: 0.1, pf: 1.3, avgR: 0.15, lcb: 0.06 };
  assert.equal(evaluateCell(good).active, true);
  for (const [k, v] of [['n', RULE.minN - 1], ['half2', -0.01], ['pf', 1.1], ['avgR', 0.05], ['lcb', 0.01]]) {
    const r = evaluateCell({ ...good, [k]: v });
    assert.equal(r.active, false, k);
    assert.equal(r.fails.length, 1, k);
  }
});

test('downsample keeps the last value per bucket', () => {
  const pts = [{ t: 0, v: 1 }, { t: 30, v: 2 }, { t: 60, v: 3 }, { t: 90, v: 4 }];
  assert.deepEqual(downsample(pts, 60), [{ t: 0, v: 2 }, { t: 60, v: 4 }]);
});

test('engine seeds 130 cells across 15 strategies and a year of history', () => {
  const now = Date.UTC(2026, 9, 17, 5);
  const e = new Engine({ now });
  const st = e.strategiesView();
  assert.equal(st.totalCells, 130);
  assert.equal(st.strategies.length, 15);
  assert.equal(st.cycle, 'SHORT');
  assert.ok(st.mainBook.every((c) => c.dir === 'SHORT' && ['1D', '4H', '1H'].includes(c.tf) && c.active));
  assert.ok(e.trades.length > 500);
  for (const r of ['1D', '1W', '1M', '3M', '1Y', 'ALL']) assert.ok(e.equitySeries(r).points.length > 100, r);
  assert.equal(e.equitySeries('nope'), null);
});

test('live simulation keeps accounting consistent and respects the 3% stop cap', () => {
  const now = Date.UTC(2026, 9, 17, 5);
  const e = new Engine({ now });
  const before = e.balance;
  const seen = new Set(e.trades.map((t) => t.id));
  let t = now;
  for (let i = 0; i < 4 * 3600; i++) {
    t += 1000;
    e.tick(t);
    for (const p of e.positions) assert.ok(Math.abs(p.entry - p.initialSl) / p.entry <= MAX_SL + 1e-9);
  }
  const fresh = e.trades.filter((x) => !seen.has(x.id));
  assert.ok(fresh.length > 10, 'bots should close trades');
  const realized = fresh.reduce((s, x) => s + x.pnl, 0);
  assert.ok(Math.abs(e.balance - before - realized) < 0.05 * fresh.length, 'balance moves only by closed pnl');
  // with no open positions, equity equals balance
  const flat = new Engine({ now });
  flat.positions = [];
  assert.equal(flat.equity(), flat.balance);
  const v = e.verdict();
  assert.equal(v.total, 4);
  assert.equal(v.hit, v.checks.filter((c) => c.ok).length);
});

test('pausing stops new entries', () => {
  const now = Date.UTC(2026, 9, 17, 5);
  const e = new Engine({ now });
  e.setRunning(false);
  const n = e.positions.length + e.pending.length;
  for (let i = 1; i <= 600; i++) e.tick(now + i * 1000);
  assert.equal(e.positions.length + e.pending.length, n);
});

test('state round-trips through serialize', () => {
  const now = Date.UTC(2026, 9, 17, 5);
  const e = new Engine({ now });
  for (let i = 1; i <= 120; i++) e.tick(now + i * 1000);
  const saved = JSON.parse(JSON.stringify(e.serialize()));
  const later = now + 2 * HOUR;
  const r = new Engine({ now: later, saved });
  assert.equal(r.trades.length, e.trades.length);
  assert.equal(r.balance, e.balance);
  assert.ok(r.equityMin.at(-1).t >= Math.floor(later / MIN) * MIN - MIN);
});
