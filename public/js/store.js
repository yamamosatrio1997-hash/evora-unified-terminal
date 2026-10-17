// Live snapshot store fed by the server-sent event stream.
const subs = new Set();
export const store = { snap: null, connected: false };

export function subscribe(fn) {
  subs.add(fn);
  if (store.snap) fn(store.snap, true);
  return () => subs.delete(fn);
}

function publish(snap) {
  const first = !store.snap;
  store.snap = snap;
  for (const fn of subs) {
    try { fn(store.snap, first); } catch (err) { console.error(err); }
  }
}

export function connect({ onStatus } = {}) {
  const local = globalThis.__PQ_BACKEND__;
  if (local) {
    store.connected = true;
    onStatus?.(true);
    return local.stream(publish);
  }
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => publish(JSON.parse(e.data)));
  es.onopen = () => { store.connected = true; onStatus?.(true); };
  es.onerror = () => { store.connected = false; onStatus?.(false); };
  return es;
}
