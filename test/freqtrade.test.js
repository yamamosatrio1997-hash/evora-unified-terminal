import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { FreqtradeClient, mapClosedTrade, mapOpenTrade, parseTag } from '../server/freqtrade.js';
import { Engine } from '../server/engine.js';

const H = 3600_000;
const now = Date.UTC(2026, 9, 17, 10);

// shapes follow freqtrade's TradeSchema / OpenTradeSchema
function trade(over = {}) {
  return {
    trade_id: 1, pair: 'BTC/USDT:USDT', is_open: false, is_short: true, amount: 0.05, stake_amount: 400, max_stake_amount: 400,
    strategy: 'PixelQuantStrategy', enter_tag: 'trend|p=0.62|al=1|vol=tinggi', open_timestamp: now - 20 * H, open_rate: 80000,
    close_timestamp: now - 8 * H, close_rate: 78000, profit_abs: 95.5, initial_stop_loss_abs: 81600, stop_loss_abs: 80000,
    exit_reason: 'tp2', nr_of_successful_exits: 2, leverage: 10, fee_open_cost: 2.4, fee_close_cost: 2.3, ...over,
  };
}

test('parseTag reads bot and fields', () => {
  assert.deepEqual(parseTag('sweep|p=0.5|al=0|vol=normal'), { bot: 'sweep', p: '0.5', al: '0', vol: 'normal' });
  assert.deepEqual(parseTag(null), { bot: null });
});

test('closed freqtrade trades map to dashboard trades with R from the initial stop', () => {
  const t = mapClosedTrade(trade());
  assert.equal(t.pair, 'BTC/USDT');
  assert.equal(t.side, 'SHORT');
  assert.equal(t.bot, 'trend');
  assert.equal(t.status, 'TP2');
  assert.equal(t.conf, 0.62);
  assert.equal(t.tags.aligned, true);
  assert.equal(t.tags.volRegime, 'tinggi');
  // qty0 = 400 * 10 / 80000 = 0.05 ; risk = 1600 * 0.05 = 80
  assert.ok(Math.abs(t.r - 95.5 / 80) < 1e-9);
  assert.equal(mapClosedTrade(trade({ exit_reason: 'stop_loss', nr_of_successful_exits: 1 })).status, 'SL');
  assert.equal(mapClosedTrade(trade({ exit_reason: 'trailing_stop_loss', nr_of_successful_exits: 2 })).status, 'TP1');
  assert.equal(mapClosedTrade(trade({ exit_reason: 'time_stop' })).status, 'TIME');
});

test('open trades get TP levels from the bot RR', () => {
  const p = mapOpenTrade(trade({ is_open: true, current_rate: 79000, total_profit_abs: 50, nr_of_successful_exits: 0 }), now);
  assert.equal(p.tp1, 78400);
  assert.equal(p.tp2, 80000 - 1600 * 2.4);
  assert.equal(p.tp1Hit, false);
  assert.ok(p.timeLeft > 0);
});

function fakeFreqtrade() {
  const state = { stopped: false, logins: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/v1/token/login') {
      state.logins++;
      return req.headers.authorization === `Basic ${Buffer.from('pq:secret').toString('base64')}` ? send({ access_token: 'tok', refresh_token: 'r' }) : send({}, 401);
    }
    if (req.headers.authorization !== 'Bearer tok') return send({ detail: 'unauthorized' }, 401);
    switch (url.pathname) {
      case '/api/v1/status': return send([trade({ trade_id: 9, is_open: true, current_rate: 79500, total_profit_abs: 25, close_timestamp: null, nr_of_successful_exits: 0 })]);
      case '/api/v1/trades': return send({ trades: [trade(), trade({ trade_id: 2, profit_abs: -82, exit_reason: 'stop_loss', nr_of_successful_exits: 1, close_timestamp: now - 2 * H })], trades_count: 2, offset: 0, total_trades: 2 });
      case '/api/v1/balance': return send({ total: 10050, total_bot: 10038.5, starting_capital: 10000 });
      case '/api/v1/show_config': return send({ dry_run: true, state: 'running', max_open_trades: state.stopped ? 0 : 8, timeframe: '4h', strategy: 'PixelQuantFreqAI' });
      case '/api/v1/whitelist': return send({ whitelist: ['BTC/USDT:USDT'], length: 1, method: ['StaticPairList'] });
      case '/api/v1/pair_candles': return send({ columns: ['date', 'close', 'ema20', 'ema50', 'atr', 'vol_regime'], data: Array.from({ length: 10 }, (_, i) => [i, 80000 + i * 10, 79000, 80000, 500, 'normal']) });
      case '/api/v1/stopentry': state.stopped = true; return send({ status: 'ok' });
      case '/api/v1/reload_config': state.stopped = false; return send({ status: 'ok' });
      default: return send({}, 404);
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

test('client logs in, mirrors the bot into the engine and pauses entries', async () => {
  const { server, state, url } = await fakeFreqtrade();
  try {
    const client = new FreqtradeClient({ url, username: 'pq', password: 'secret' });
    const data = await client.snapshot(now);
    assert.equal(data.trades.length, 2);
    assert.equal(data.positions.length, 1);
    assert.equal(data.prices[0].sym, 'BTC/USDT');
    assert.equal(data.prices[0].bias, 'SHORT');
    assert.equal(data.running, true);

    const e = new Engine({ external: true, now });
    e.syncExternal(data, now);
    e.tick(now);
    const s = e.snapshot();
    assert.equal(s.source, 'freqtrade');
    assert.equal(s.account.equity, 10038.5);
    assert.equal(s.positions[0].pair, 'BTC/USDT');
    assert.equal(s.kpi.trades, 2);
    assert.equal(s.kpi.winRate, 0.5);
    assert.equal(s.account.unrealized, 25, 'open PnL comes from the open trades');
    assert.equal(e.equitySeries('1W').points.at(-1).v, 10038.5);

    await client.setRunning(false);
    assert.equal((await client.snapshot(now)).running, false);
    await client.setRunning(true);
    assert.equal((await client.snapshot(now)).running, true);
    assert.equal(state.logins, 1, 'the token is reused');
  } finally {
    server.close();
  }
});
