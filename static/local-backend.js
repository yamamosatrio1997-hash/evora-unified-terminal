// In-browser stand-in for server/index.js: same engine and routes, no network.
// With the viewer's TradingView connector the bots are backtested on a year of real 4h candles
// and forward-tested on live quotes; without it the engine falls back to its simulation.
import { Engine } from './sim/engine.js';
import { RULE_EVOLUTION, NOTES, INSIGHTS, MODELS, GLOSSARY, LIMITATIONS, RULE, BOTS } from './sim/data.js';
import { onLive, fetchHistory, errorText } from './live-market.js';

const subs = new Set();
const clone = (x) => JSON.parse(JSON.stringify(x));
let engine = null;

function banner(text, tone = 'info') {
  const el = document.getElementById('dataBanner');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
  el.dataset.tone = tone;
}

const ready = (async () => {
  banner('Memuat 12 bulan candle 4H dari TradingView…');
  try {
    const bars = await fetchHistory();
    engine = new Engine({ now: Date.now(), bars });
    banner('');
  } catch (err) {
    engine = new Engine({ now: Date.now() });
    const why = err?.code === 'unavailable' ? 'TradingView tidak tersedia di tampilan ini.' : errorText(err);
    banner(`${why} Menampilkan data simulasi.`, 'warn');
    setTimeout(() => banner(''), 9000);
  }
  onLive((live) => {
    for (const [sym, q] of Object.entries(live.quotes)) {
      if (engine.real) engine.onQuote(sym, q.price, Date.now(), q.chg);
      else engine.setReference(sym, q.price);
    }
  });
  setInterval(() => {
    engine.tick(Date.now());
    const snap = clone(engine.snapshot());
    for (const fn of subs) fn(snap);
  }, 1000);
  return engine;
})();

const REAL_LIMITS = [
  'Hasil bot adalah backtest dan forward test paper di candle 4H Binance dari TradingView; bukan uang sungguhan dan bukan saran investasi.',
  'Backtest masuk di close candle sinyal dan menganggap stop tersentuh lebih dulu bila stop dan target ada di candle yang sama.',
  'Heatmap 130 sel di halaman Strategi dan tabel model prediktif masih ilustrasi.',
];

const routes = {
  'GET /api/snapshot': () => engine.snapshot(),
  'GET /api/equity': (q) => engine.equitySeries(q.get('range') || '1D'),
  'GET /api/trades': () => ({ trades: engine.trades.slice(-500).reverse(), bots: BOTS.map(({ id, name, color }) => ({ id, name, color })) }),
  'GET /api/strategies': () => engine.strategiesView(),
  'GET /api/lessons': () => ({ ...engine.lessonsView(), target: engine.targetMath() }),
  'GET /api/learning': () => ({ ...engine.learningView(), evolution: RULE_EVOLUTION, notes: NOTES }),
  'GET /api/insights': () => ({ insights: INSIGHTS }),
  'GET /api/predictive': () => ({ ...engine.predictiveView(), models: MODELS }),
  'GET /api/methodology': () => ({
    rule: RULE, glossary: GLOSSARY, evolution: RULE_EVOLUTION,
    limitations: engine.real ? [...REAL_LIMITS, ...LIMITATIONS.slice(1).filter((l) => !l.startsWith('Waktu simulasi'))] : LIMITATIONS,
  }),
};

export async function api(path, opts = {}) {
  await ready;
  const url = new URL(path, 'http://local');
  const method = (opts.method || 'GET').toUpperCase();
  if (method === 'POST' && url.pathname === '/api/engine') {
    engine.setRunning(JSON.parse(opts.body || '{}').running !== false);
    return { running: engine.running };
  }
  const fn = routes[`${method} ${url.pathname}`];
  if (!fn) throw new Error(`404 ${path}`);
  return clone(fn(url.searchParams));
}

export function stream(fn) {
  subs.add(fn);
  ready.then(() => fn(clone(engine.snapshot())));
  return () => subs.delete(fn);
}
