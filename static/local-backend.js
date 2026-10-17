// In-browser stand-in for server/index.js: same engine and routes, no network.
// Real TradingView quotes (when the viewer's connector answers) anchor the simulated prices.
import { Engine } from './sim/engine.js';
import { RULE_EVOLUTION, NOTES, INSIGHTS, MODELS, GLOSSARY, LIMITATIONS, RULE, BOTS } from './sim/data.js';
import { onLive } from './live-market.js';

const engine = new Engine({ now: Date.now() });
const subs = new Set();
const clone = (x) => JSON.parse(JSON.stringify(x));

onLive((live) => {
  for (const [sym, q] of Object.entries(live.quotes)) engine.setReference(sym, q.price);
});

setInterval(() => {
  engine.tick(Date.now());
  const snap = clone(engine.snapshot());
  for (const fn of subs) fn(snap);
}, 1000);

const routes = {
  'GET /api/snapshot': () => engine.snapshot(),
  'GET /api/equity': (q) => engine.equitySeries(q.get('range') || '1D'),
  'GET /api/trades': () => ({ trades: engine.trades.slice(-500).reverse(), bots: BOTS.map(({ id, name, color }) => ({ id, name, color })) }),
  'GET /api/strategies': () => engine.strategiesView(),
  'GET /api/lessons': () => ({ ...engine.lessonsView(), target: engine.targetMath() }),
  'GET /api/learning': () => ({ ...engine.learningView(), evolution: RULE_EVOLUTION, notes: NOTES }),
  'GET /api/insights': () => ({ insights: INSIGHTS }),
  'GET /api/predictive': () => ({ ...engine.predictiveView(), models: MODELS }),
  'GET /api/methodology': () => ({ rule: RULE, glossary: GLOSSARY, limitations: LIMITATIONS, evolution: RULE_EVOLUTION }),
};

export async function api(path, opts = {}) {
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
  fn(clone(engine.snapshot()));
  return () => subs.delete(fn);
}
