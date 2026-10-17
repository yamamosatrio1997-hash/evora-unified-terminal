// Live snapshot store fed by the server-sent event stream.
const subs = new Set();
export const store = { snap: null, connected: false };

export function subscribe(fn) {
  subs.add(fn);
  if (store.snap) fn(store.snap, true);
  return () => subs.delete(fn);
}

export function connect({ onStatus } = {}) {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => {
    const first = !store.snap;
    store.snap = JSON.parse(e.data);
    for (const fn of subs) {
      try { fn(store.snap, first); } catch (err) { console.error(err); }
    }
  });
  es.onopen = () => { store.connected = true; onStatus?.(true); };
  es.onerror = () => { store.connected = false; onStatus?.(false); };
  return es;
}
