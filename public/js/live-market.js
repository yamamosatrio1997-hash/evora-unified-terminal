// Real market data from the viewer's TradingView connector (claude.ai Artifact `mcp` capability).
// Outside an Artifact viewer `window.claude` is absent and everything stays on the simulation.

export const TV_SERVER = 'Tradingview Official MCP Server';
export const TV_SYMBOLS = {
  'BTC/USDT': 'BINANCE:BTCUSDT', 'ETH/USDT': 'BINANCE:ETHUSDT', 'SOL/USDT': 'BINANCE:SOLUSDT', 'ARB/USDT': 'BINANCE:ARBUSDT',
  'XRP/USDT': 'BINANCE:XRPUSDT', 'BNB/USDT': 'BINANCE:BNBUSDT', 'DOGE/USDT': 'BINANCE:DOGEUSDT', 'AVAX/USDT': 'BINANCE:AVAXUSDT',
};
const QUOTE_TOOL = 'mcp-tv-get-symbol-data-batch';
const OHLCV_TOOL = 'mcp-tv-get-ohlcv';
const QUOTE_INPUT = { symbols: Object.values(TV_SYMBOLS), columns: ['close', 'change'] };

// Codes where the viewer has no access: drop real data and explain the fix.
const DENIED = new Set(['needs_reauth', 'server_not_connected', 'selection_required', 'blocked_by_policy', 'approval_required',
  'not_in_manifest', 'not_granted', 'capability_disabled', 'capability_removed', 'consent_required', 'server_not_found']);

// status: loading | live | stale | denied | error | unavailable
export const live = { status: 'loading', error: null, quotes: {}, quotesAt: null };
const subs = new Set();
const emit = () => { for (const fn of subs) fn(live); };

export function onLive(fn) {
  subs.add(fn);
  fn(live);
  return () => subs.delete(fn);
}

let mcpPromise = null;
function getMcp() {
  mcpPromise ??= window.claude?.use ? window.claude.use('mcp').catch(() => null) : Promise.resolve(null);
  return mcpPromise;
}

export function errorText(err) {
  switch (err?.code) {
    case 'needs_reauth': return 'Sambungkan ulang TradingView di claude.ai Settings → Connectors.';
    case 'server_not_connected':
    case 'server_not_found': return 'Tambahkan connector TradingView di claude.ai Settings → Connectors.';
    case 'selection_required': return 'Ada lebih dari satu connector TradingView; pilih salah satu di prompt claude.ai.';
    case 'approval_required':
    case 'not_in_manifest':
    case 'consent_required': return 'Halaman ini belum diizinkan membaca TradingView.';
    case 'blocked_by_policy': return 'Kebijakan organisasi memblokir TradingView untuk akun ini.';
    case 'server_unavailable': return 'TradingView sedang tidak merespons; mencoba lagi di refresh berikutnya.';
    case 'tool_error': return `TradingView menolak permintaan: ${err.message}`;
    default: return 'Data TradingView tidak tersedia saat ini.';
  }
}

export const canAskAccess = (err) => ['approval_required', 'not_in_manifest', 'consent_required'].includes(err?.code);

function applyQuotes(result) {
  const data = result?.payload?.data || {};
  for (const [pair, tv] of Object.entries(TV_SYMBOLS)) {
    const q = data[tv];
    if (q && q.close > 0) live.quotes[pair] = { price: q.close, chg: (q.change ?? 0) / 100 };
  }
  live.quotesAt = result?.cache?.storedAt ?? Date.now();
  live.status = 'live';
  live.error = null;
  emit();
}

function applyError(err) {
  live.error = err;
  if (DENIED.has(err?.code)) { live.quotes = {}; live.status = 'denied'; }
  else live.status = Object.keys(live.quotes).length ? 'stale' : 'error';
  emit();
}

export async function startQuotes() {
  const mcp = await getMcp();
  if (!mcp) { live.status = 'unavailable'; emit(); return; }
  mcp.watchTool(TV_SERVER, QUOTE_TOOL, QUOTE_INPUT, (ev) => (ev.type === 'data' ? applyQuotes(ev.result) : applyError(ev.error)),
    { refetchInterval: 30000 });
}

// One explicit call behind a viewer click: lets claude.ai ask for consent.
export async function requestAccess() {
  const mcp = await getMcp();
  if (!mcp) return;
  try { applyQuotes(await mcp.callTool(TV_SERVER, QUOTE_TOOL, QUOTE_INPUT)); } catch (err) { applyError(err); }
}

const REFRESH = { '15m': 60000, '1h': 120000, '4h': 300000, '1D': 300000 };

// Watches candles for one pair; handler gets { bars, at } or { error }. Returns an unsubscribe.
export function watchCandles(pair, interval, handler) {
  let stop = null, cancelled = false;
  getMcp().then((mcp) => {
    if (cancelled) return;
    if (!mcp) { handler({ error: { code: 'unavailable' } }); return; }
    stop = mcp.watchTool(TV_SERVER, OHLCV_TOOL, { symbol: TV_SYMBOLS[pair], interval, count: 96, format: 'columns' }, (ev) => {
      if (ev.type === 'error') return handler({ error: ev.error });
      const b = ev.result?.payload?.bars;
      if (!b?.t?.length) return handler({ error: { code: 'tool_error', message: 'tidak ada bar' } });
      handler({ bars: b.t.map((t, i) => ({ t: t * 1000, o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i], v: b.v[i] })), at: ev.result?.cache?.storedAt ?? Date.now() });
    }, { refetchInterval: REFRESH[interval] || 120000 });
  });
  return () => { cancelled = true; stop?.(); };
}
