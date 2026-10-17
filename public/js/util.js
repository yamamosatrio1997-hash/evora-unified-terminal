// DOM, formatting, number tweening and icons.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

export const prefs = {
  get hide() { return document.documentElement.classList.contains('hide-money'); },
  get reduceMotion() {
    return document.documentElement.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  },
};

// ---------- formatting ----------
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtUsd = (x) => usd0.format(x);
export const fmtSignedUsd = (x) => (x >= 0 ? '+' : '−') + usd0.format(Math.abs(x));
export const fmtPct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
export const fmtSignedPct = (x, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`;
export const fmtR = (x, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}R`;
export const fmtNum = (x, d = 0) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export function fmtPx(x) {
  if (x >= 1000) return x.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (x >= 100) return x.toFixed(2);
  if (x >= 1) return x.toFixed(3);
  return x.toFixed(4);
}
export const fmtTime = (t) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }).replace('.', ':');
export const fmtDate = (t) => new Date(t).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', timeZone: 'Asia/Jakarta' });
export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
export const tone = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'flat');

// ---------- animated numbers ----------
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export function tweenNumber(el, to, format, { duration = 700, flash = true, money = false } = {}) {
  if (!el) return;
  if (money) el.classList.add('money');
  const from = el._value ?? to;
  el._value = to;
  if (el._raf) cancelAnimationFrame(el._raf);
  if (flash && from !== to && el._shown) {
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(to > from ? 'flash-up' : 'flash-down');
  }
  el._shown = true;
  if (prefs.reduceMotion || from === to) { el.textContent = format(to); return; }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / duration);
    el.textContent = format(from + (to - from) * easeOut(k));
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// ---------- icons ----------
const P = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 18 6"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/><path d="M9 7h6M9 11h6"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h1V4z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h-1V4z"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3"/><path d="M7 15h10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  user: '<circle cx="12" cy="9" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6"/>',
  winrate: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  swap: '<path d="M4 8h14l-4-4M20 16H6l4 4"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="M9 12h6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el._iconDone) continue;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
    el._iconDone = true;
  }
}

// The static build installs an in-browser backend here (see static/boot.js).
export async function api(path, opts) {
  const local = globalThis.__PQ_BACKEND__;
  if (local) return local.api(path, opts);
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

// Reveal-on-load stagger for cards inside a view.
export function stagger(root) {
  if (prefs.reduceMotion) return;
  root.querySelectorAll('.card, .reveal').forEach((el, i) => {
    el.style.setProperty('--d', `${Math.min(i, 14) * 55}ms`);
    el.classList.add('enter');
  });
}

export const COIN_COLORS = { BTC: '#f7931a', ETH: '#8b8cf8', SOL: '#2dd4bf', ARB: '#3b82f6', XRP: '#cbd5e1', BNB: '#facc15', DOGE: '#d6b25e', AVAX: '#f43f5e', Lainnya: '#5f6c9c' };

export function coin(pair) {
  const base = pair.split('/')[0];
  return `<span class="pair"><span class="coin" style="--c:${COIN_COLORS[base] || '#8f9bc8'}">${base[0]}</span>${pair}</span>`;
}

export const sideTag = (side) => `<span class="${side === 'LONG' ? 'side-long' : 'side-short'}">${side}</span>`;

export function statusTag(status) {
  const map = { TP2: 'green', TP1: 'blue', SL: 'red', TIME: 'yellow' };
  return `<span class="tag ${map[status] || 'muted'}">${status}</span>`;
}
