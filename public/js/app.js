import { $, h, icon, hydrateIcons, tweenNumber, fmtTime, fmtSignedPct, fmtPx, coin, api, fmtPct } from './util.js';
import { connect, subscribe, store } from './store.js';
import { brandLogo, mascotScene, sunsetScene } from './pixel.js';
import { live, onLive, startQuotes } from './live-market.js';

const ROUTES = [
  { path: '/', label: 'Laporan Lab', icon: 'home', load: () => import('./views/dashboard.js') },
  { path: '/posisi', label: 'Posisi Live', icon: 'radar', load: () => import('./views/positions.js'), count: (s) => s.positions.length },
  { path: '/jurnal', label: 'Jurnal Trade', icon: 'book', load: () => import('./views/journal.js') },
  { path: '/strategi', label: 'Strategi & Setup', icon: 'layers', load: () => import('./views/strategies.js') },
  { path: '/kekalahan', label: 'Belajar dari Kalah', icon: 'target', load: () => import('./views/lessons.js') },
  { path: '/pembelajaran', label: 'Pembelajaran', icon: 'brain', load: () => import('./views/learning.js') },
  { path: '/insight', label: 'Insight Teruji', icon: 'bulb', load: () => import('./views/insights.js') },
  { path: '/prediktif', label: 'Lab Prediktif', icon: 'flask', load: () => import('./views/predictive.js') },
  { path: '/metodologi', label: 'Metodologi', icon: 'info', load: () => import('./views/methodology.js') },
];

const viewEl = $('#view');
let current = null;
let routeToken = 0;

// ---------- preferences ----------
const PREF_KEY = 'pq-prefs';
const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })();
function applyPrefs() {
  document.documentElement.classList.toggle('hide-money', !!prefs.hide);
  document.documentElement.classList.toggle('reduce-motion', !!prefs.motion);
  $('#optHide').checked = !!prefs.hide;
  $('#optMotion').checked = !!prefs.motion;
  $('#optToast').checked = prefs.toast !== false;
}
function savePref(k, v) {
  prefs[k] = v;
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
  applyPrefs();
}
export const togglePref = (k) => savePref(k, !prefs[k]);

// ---------- navigation ----------
function buildNav() {
  $('#nav').append(...ROUTES.map((r) => h('li', {}, h('a', { href: `#${r.path}`, 'data-path': r.path, html: `${icon(r.icon)}<span>${r.label}</span>${r.count ? '<span class="nav-count" hidden></span>' : ''}` }))));
}

async function route() {
  const path = location.hash.replace(/^#/, '') || '/';
  const r = ROUTES.find((x) => x.path === path) || ROUTES[0];
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.path === r.path));
  $('#sidebar').classList.remove('open');
  const token = ++routeToken;
  const mod = await r.load();
  if (token !== routeToken) return;
  current?.destroy?.();
  viewEl.innerHTML = '';
  current = mod.mount(viewEl);
  hydrateIcons(viewEl);
  document.title = `${r.label} · Pixel Quant`;
  window.scrollTo({ top: 0 });
  if (store.snap) current.update?.(store.snap, true);
}

// ---------- rail: logs + pairs ----------
const seenLogs = new Set();
const TONE = { green: 'var(--green)', red: 'var(--red)', purple: 'var(--purple)', blue: 'var(--blue)', yellow: 'var(--yellow)', info: 'var(--blue)', muted: 'var(--dim)' };
let unseen = 0;

function renderLogs(snap, first) {
  const list = $('#logs');
  const latest = snap.logs.slice(-8).reverse();
  const fresh = latest.filter((l) => !seenLogs.has(l.id));
  list.replaceChildren(...latest.map((l) => {
    const isNew = !first && fresh.includes(l);
    return h('li', { class: `log${isNew ? ' new' : ''}`, style: `--c:${TONE[l.tone] || 'var(--blue)'}` },
      h('span', { class: 'pip' }),
      h('time', {}, fmtTime(l.t)),
      h('div', { html: `${l.text}<small>${l.sub.replace(/\((LONG|SHORT)\)/, '(<em>$1</em>)')}</small>` }));
  }));
  for (const l of snap.logs) {
    if (seenLogs.has(l.id)) continue;
    seenLogs.add(l.id);
    if (!first && (l.kind === 'tp' || l.kind === 'sl' || l.kind === 'buy' || l.kind === 'sell')) {
      unseen++;
      if (prefs.toast !== false && (l.kind === 'tp' || l.kind === 'sl')) toast(l);
    }
  }
  const badge = $('#bellBadge');
  badge.hidden = unseen === 0;
  badge.textContent = unseen > 9 ? '9+' : unseen;
}

const pairRows = new Map();
function renderPairs(snap) {
  const list = $('#pairs');
  // prefer real TradingView quotes when the connector answers
  const prices = snap.prices.map((p) => (live.quotes[p.sym] ? { ...p, price: live.quotes[p.sym].price, chg24: live.quotes[p.sym].chg } : p));
  $('#pairsSource').textContent = Object.keys(live.quotes).length ? 'TradingView' : 'simulasi';
  const rows = [...prices].sort((a, b) => Math.abs(b.chg24) - Math.abs(a.chg24)).slice(0, 6);
  if (pairRows.size !== rows.length || rows.some((p) => !pairRows.has(p.sym))) {
    pairRows.clear();
    list.replaceChildren(...rows.map((p) => {
      const li = h('li', {},
        h('div', { html: `${coin(p.sym)}<span class="px"></span>` }),
        h('span', { class: 'chg' }),
        h('span', { class: 'tag' }));
      pairRows.set(p.sym, li);
      return li;
    }));
  }
  for (const p of rows) {
    const li = pairRows.get(p.sym);
    tweenNumber(li.querySelector('.px'), p.price, fmtPx, { duration: 500 });
    const chg = li.querySelector('.chg');
    chg.className = `chg ${p.chg24 >= 0 ? 'up' : 'down'}`;
    tweenNumber(chg, p.chg24, (v) => fmtSignedPct(v), { flash: false });
    const tag = li.querySelector('.tag');
    tag.className = `tag ${p.bias === 'LONG' ? 'green' : 'red'}`;
    tag.textContent = p.bias;
  }
}

// ---------- toasts ----------
function toast(l) {
  const win = l.kind === 'tp';
  const el = h('div', { class: 'toast', style: `--c:${win ? 'var(--green)' : 'var(--red)'}` },
    h('div', { class: 'ti', html: icon(win ? 'trend' : 'alert') }),
    h('div', { html: `<b>${l.text}</b><small>${l.sub}</small>` }));
  const box = $('#toasts');
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 4200);
}
export function notify(text, sub = '', good = true) { toast({ kind: good ? 'tp' : 'sl', text, sub }); }

// ---------- top bar ----------
function renderStatus(snap) {
  const pill = $('#statusPill');
  pill.classList.toggle('running', snap.running);
  pill.classList.toggle('paused', !snap.running);
  $('.status-label', pill).textContent = snap.running ? 'Bot Running' : 'Bot Dijeda';
  for (const r of ROUTES) {
    if (!r.count) continue;
    const el = document.querySelector(`.nav a[data-path="${r.path}"] .nav-count`);
    const n = r.count(snap);
    el.hidden = !n;
    el.textContent = n;
  }
}

function tickClock() {
  const t = new Date();
  $('#clock').textContent = `${t.toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false })} (UTC+7)`;
}

// sidebar mascot speech bubble: rotates through live facts with a typing effect
let bubbleIdx = 0;
function bubbleMessages(s) {
  const best = [...s.bots].sort((a, b) => b.progress - a.progress)[0];
  return [
    'Ayo tangkap peluang bersama!',
    `Win rate 30 hari: ${fmtPct(s.kpi.winRate, 1)}. Target 70%.`,
    best ? `${best.name} paling dekat ke target: ${fmtPct(Math.max(0, best.progress), 0)}.` : '',
    `${s.positions.length} posisi terbuka, ${s.pending.length} limit menunggu.`,
    'Disiplin dulu, profit menyusul.',
    `Skor target: ${s.verdict.hit}/${s.verdict.total}. Masih belajar.`,
  ].filter(Boolean);
}
function rotateBubble() {
  if (!store.snap) return;
  const msgs = bubbleMessages(store.snap);
  const text = msgs[bubbleIdx++ % msgs.length];
  const el = $('#bubbleText');
  let i = 0;
  clearInterval(el._typer);
  el._typer = setInterval(() => {
    el.textContent = text.slice(0, ++i);
    if (i >= text.length) clearInterval(el._typer);
  }, 28);
}

function wireTopbar() {
  $('#statusPill').addEventListener('click', async () => {
    if (!store.snap) return;
    try {
      const r = await api('/api/engine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ running: !store.snap.running }) });
      notify(r.running ? 'Bot dilanjutkan' : 'Bot dijeda', r.running ? 'Sinyal baru diizinkan lagi' : 'Tidak ada entry baru sampai dilanjutkan', r.running);
    } catch {
      notify('Gagal mengubah status bot', 'Server menolak permintaan (token kontrol?)', false);
    }
  });
  $('#bellBtn').addEventListener('click', () => {
    unseen = 0;
    $('#bellBadge').hidden = true;
    const rail = $('#rail');
    if (matchMedia('(max-width: 1280px)').matches) rail.classList.toggle('open');
    else { const c = $('.logs-card'); c.classList.remove('flash-up'); void c.offsetWidth; c.classList.add('flash-up'); }
  });
  $('#settingsBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#settingsPop').hidden = !$('#settingsPop').hidden; });
  document.addEventListener('click', (e) => { if (!e.target.closest('.popover-wrap')) $('#settingsPop').hidden = true; });
  $('#optHide').addEventListener('change', (e) => savePref('hide', e.target.checked));
  $('#optMotion').addEventListener('change', (e) => savePref('motion', e.target.checked));
  $('#optToast').addEventListener('change', (e) => savePref('toast', e.target.checked));
  $('#navToggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
}

// ---------- boot ----------
applyPrefs();
hydrateIcons();
buildNav();
wireTopbar();
brandLogo($('#brandLogo'));
mascotScene($('#mascot'));
sunsetScene($('#sunset'));
tickClock();
setInterval(tickClock, 1000);
setInterval(rotateBubble, 9000);

subscribe((snap, first) => {
  renderStatus(snap);
  renderLogs(snap, first);
  renderPairs(snap);
  current?.update?.(snap, first);
  if (first) rotateBubble();
});
connect({ onStatus: (ok) => { $('#connBanner').hidden = ok; } });
startQuotes();
onLive(() => { if (store.snap) renderPairs(store.snap); });
window.addEventListener('hashchange', route);
route();
