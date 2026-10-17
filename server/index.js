import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.js';
import { FreqtradeClient } from './freqtrade.js';
import { RULE_EVOLUTION, NOTES, INSIGHTS, MODELS, GLOSSARY, LIMITATIONS, RULE, BOTS } from './data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT) || 3000;
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function saveState(engine) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(engine.serialize()));
  fs.renameSync(tmp, STATE_FILE);
}

// With FREQTRADE_URL the dashboard mirrors a running freqtrade bot instead of its own simulation.
const freqtrade = process.env.FREQTRADE_URL
  ? new FreqtradeClient({ url: process.env.FREQTRADE_URL, username: process.env.FREQTRADE_USERNAME || 'pixelquant', password: process.env.FREQTRADE_PASSWORD || '' })
  : null;
const engine = freqtrade ? new Engine({ external: true }) : new Engine({ saved: process.env.FRESH ? null : loadState() });
const clients = new Set();

async function syncFreqtrade() {
  try {
    engine.syncExternal(await freqtrade.snapshot(Date.now()), Date.now());
  } catch (e) {
    if (engine.sourceError !== e.message) console.error('freqtrade:', e.message);
    engine.sourceError = e.message;
  }
}
if (freqtrade) {
  syncFreqtrade();
  setInterval(syncFreqtrade, Number(process.env.FREQTRADE_POLL_MS) || 15_000);
}

setInterval(() => {
  engine.tick(Date.now());
  if (!clients.size) return;
  const payload = `event: snapshot\ndata: ${JSON.stringify(engine.snapshot())}\n\n`;
  for (const res of clients) res.write(payload);
}, 1000);

if (!freqtrade) setInterval(() => { try { saveState(engine); } catch (e) { console.error('save failed', e.message); } }, 30_000);

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

const routes = {
  'GET /api/health': () => ({ ok: true, uptime: engine.now - engine.bootAt }),
  'GET /api/snapshot': () => engine.snapshot(),
  'GET /api/equity': (q) => engine.equitySeries(q.get('range') || '1D') ?? { error: 'range tidak dikenal' },
  'GET /api/trades': () => ({ trades: engine.trades.slice(-500).reverse(), bots: BOTS.map(({ id, name, color }) => ({ id, name, color })) }),
  'GET /api/strategies': () => engine.strategiesView(),
  'GET /api/lessons': () => ({ ...engine.lessonsView(), target: engine.targetMath() }),
  'GET /api/learning': () => ({ ...engine.learningView(), evolution: RULE_EVOLUTION, notes: NOTES }),
  'GET /api/insights': () => ({ insights: INSIGHTS }),
  'GET /api/predictive': () => ({ ...engine.predictiveView(), models: MODELS }),
  'GET /api/methodology': () => ({ rule: RULE, glossary: GLOSSARY, limitations: LIMITATIONS, evolution: RULE_EVOLUTION }),
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        if (e2) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;

  if (key === 'GET /api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    res.write(`event: snapshot\ndata: ${JSON.stringify(engine.snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (key === 'POST /api/engine') {
    if (CONTROL_TOKEN && req.headers['x-control-token'] !== CONTROL_TOKEN) return json(res, 401, { error: 'token salah' });
    const body = await readBody(req);
    const on = body.running !== false;
    if (freqtrade) {
      try { await freqtrade.setRunning(on); await syncFreqtrade(); } catch (e) { return json(res, 502, { error: e.message }); }
    }
    engine.setRunning(on);
    return json(res, 200, { running: engine.running });
  }

  const handler = routes[key];
  if (handler) {
    try { return json(res, 200, handler(url.searchParams)); }
    catch (e) { console.error(e); return json(res, 500, { error: 'internal error' }); }
  }
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  serveStatic(req, res, url.pathname);
});

function shutdown() {
  if (freqtrade) process.exit(0);
  try { saveState(engine); } catch (e) { console.error('save failed', e.message); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => console.log(`Pixel Quant → http://localhost:${PORT}`));
