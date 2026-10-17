import { h, api, tweenNumber, fmtSignedUsd, fmtPct, fmtR, fmtPx, fmtTime, fmtDate, coin, sideTag, statusTag, stagger } from '../util.js';
import { LineChart } from '../charts.js';

const PAGE = 20;

export function mount(root) {
  root.innerHTML = `
  <div class="page-head"><div><div class="eyebrow">Forward test</div><h1>Jurnal trade</h1>
    <p>500 trade tertutup terakhir dari semua bot. Filter untuk melihat distribusi R dan kurva kumulatif per subset.</p></div></div>
  <div class="card" style="margin-bottom:16px">
    <div class="filters">
      <select class="select" data-ref="bot"><option value="">Semua bot</option></select>
      <select class="select" data-ref="pair"><option value="">Semua pair</option></select>
      <div class="seg" data-ref="side"><button class="on" data-v="">Semua</button><button data-v="LONG">Long</button><button data-v="SHORT">Short</button></div>
      <div class="filters" data-ref="status">${['TP2', 'TP1', 'TIME', 'SL'].map((s) => `<button class="chip on" data-v="${s}">${s}</button>`).join('')}</div>
    </div>
  </div>
  <div class="stat-cards">
    <div class="card stat"><small>Trade</small><b data-ref="n">—</b><div class="sub" data-ref="nSub"></div></div>
    <div class="card stat"><small>Win rate</small><b data-ref="wr">—</b><div class="sub">target 70%</div></div>
    <div class="card stat"><small>Profit factor</small><b data-ref="pf">—</b><div class="sub">target &gt; 3</div></div>
    <div class="card stat"><small>Net PnL</small><b class="money" data-ref="net">—</b><div class="sub" data-ref="avgR"></div></div>
  </div>
  <div class="grid" style="margin-top:16px">
    <section class="card span-7"><header class="card-head"><h3>R kumulatif</h3><span class="sub">urut waktu tutup</span></header><div class="chart" data-ref="cum" style="height:210px"></div></section>
    <section class="card span-5"><header class="card-head"><h3>Distribusi R</h3><span class="sub">per trade</span></header><div class="hist" data-ref="hist"></div><div class="hist-axis"><span>−1,5R</span><span>0</span><span>+2R</span></div></section>
    <section class="card span-12">
      <header class="card-head"><h3>Daftar trade</h3><span class="sub" data-ref="count"></span></header>
      <div class="table-wrap"><table>
        <thead><tr><th>Tutup</th><th>Bot</th><th>Pair</th><th>Side</th><th class="num">Entry</th><th class="num">Exit</th><th class="num">PnL</th><th class="num">R</th><th class="num">P(win)</th><th>Sesi</th><th>Status</th></tr></thead>
        <tbody data-ref="rows"></tbody>
      </table></div>
      <div class="pager"><span data-ref="pageInfo"></span><button data-ref="prev">‹ Sebelumnya</button><button data-ref="next">Berikutnya ›</button></div>
    </section>
  </div>`;
  const ref = Object.fromEntries([...root.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));
  stagger(root);
  const cum = new LineChart(ref.cum, { yFormat: (v) => `${v.toFixed(0)}R`, xFormat: (i) => `#${i}`, zeroLine: true, includeZero: true, xTicks: 5 });
  const f = { bot: '', pair: '', side: '', status: new Set(['TP2', 'TP1', 'TIME', 'SL']) };
  let trades = [], page = 0, lastTop = null;

  async function load() {
    const d = await api('/api/trades');
    if (!trades.length) {
      ref.bot.append(...d.bots.map((b) => h('option', { value: b.id }, b.name)));
      ref.pair.append(...[...new Set(d.trades.map((t) => t.pair))].sort().map((p) => h('option', { value: p }, p)));
    }
    trades = d.trades;
    lastTop = trades[0]?.id;
    render();
  }

  function filtered() {
    return trades.filter((t) => (!f.bot || t.bot === f.bot) && (!f.pair || t.pair === f.pair) && (!f.side || t.side === f.side) && f.status.has(t.status));
  }

  function render() {
    const ts = filtered();
    const wins = ts.filter((t) => t.pnl > 0);
    const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -ts.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
    const net = gw - gl;
    tweenNumber(ref.n, ts.length, (x) => Math.round(x));
    ref.nSub.textContent = `${wins.length} menang · ${ts.length - wins.length} kalah`;
    tweenNumber(ref.wr, ts.length ? wins.length / ts.length : 0, (x) => fmtPct(x, 1));
    tweenNumber(ref.pf, gl ? gw / gl : 0, (x) => x.toFixed(2));
    tweenNumber(ref.net, net, fmtSignedUsd);
    ref.net.className = `money ${net >= 0 ? 'up' : 'down'}`;
    ref.avgR.textContent = `rata-rata ${fmtR(ts.reduce((a, t) => a + t.r, 0) / (ts.length || 1), 3)} / trade`;

    const chrono = [...ts].reverse();
    let acc = 0;
    const vals = chrono.map((t) => (acc += t.r));
    if (vals.length >= 2) cum.setData({ x: vals.map((_, i) => i + 1), series: [{ key: 'r', label: 'R kumulatif', values: vals, color: acc >= 0 ? '#22e39b' : '#ff5c7a', fill: true, width: 2 }] });

    const bins = Array(14).fill(0);
    for (const t of ts) bins[Math.max(0, Math.min(13, Math.floor((t.r + 1.5) / 0.25)))]++;
    const max = Math.max(1, ...bins);
    if (!ref.hist.children.length) ref.hist.append(...bins.map(() => h('div')));
    [...ref.hist.children].forEach((el, i) => {
      const lo = -1.5 + i * 0.25;
      el.style.height = `${(bins[i] / max) * 100}%`;
      el.style.setProperty('--c', lo < 0 ? 'linear-gradient(180deg,#ff5c7a,#ff5c7a55)' : 'linear-gradient(180deg,#22e39b,#22e39b55)');
      el.dataset.tip = `${lo.toFixed(2)}…${(lo + 0.25).toFixed(2)}R: ${bins[i]}`;
    });

    const pages = Math.max(1, Math.ceil(ts.length / PAGE));
    page = Math.min(page, pages - 1);
    ref.rows.replaceChildren(...ts.slice(page * PAGE, page * PAGE + PAGE).map((t) => h('tr', { html: `
      <td class="mono dim">${fmtDate(t.closedAt)} ${fmtTime(t.closedAt)}</td><td class="muted">${t.botName}</td><td>${coin(t.pair)}</td><td>${sideTag(t.side)}</td>
      <td class="num">${fmtPx(t.entry)}</td><td class="num">${fmtPx(t.exit)}</td>
      <td class="num money ${t.pnl >= 0 ? 'up' : 'down'}">${fmtSignedUsd(t.pnl)}</td><td class="num ${t.r >= 0 ? 'up' : 'down'}">${fmtR(t.r)}</td>
      <td class="num">${fmtPct(t.conf, 0)}</td><td class="muted">${t.tags.session}</td><td>${statusTag(t.status)}</td>` })));
    ref.count.textContent = `${ts.length} dari ${trades.length}`;
    ref.pageInfo.textContent = `Halaman ${page + 1} / ${pages}`;
    ref.prev.disabled = page === 0;
    ref.next.disabled = page >= pages - 1;
  }

  ref.bot.addEventListener('change', (e) => { f.bot = e.target.value; page = 0; render(); });
  ref.pair.addEventListener('change', (e) => { f.pair = e.target.value; page = 0; render(); });
  ref.side.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    f.side = b.dataset.v;
    ref.side.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    page = 0; render();
  });
  ref.status.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (f.status.has(b.dataset.v)) f.status.delete(b.dataset.v); else f.status.add(b.dataset.v);
    b.classList.toggle('on');
    page = 0; render();
  });
  ref.prev.addEventListener('click', () => { page--; render(); });
  ref.next.addEventListener('click', () => { page++; render(); });
  load();

  return {
    update(s) {
      // refresh when a new trade closes
      if (trades.length && s.recentTrades[0] && s.recentTrades[0].id !== lastTop) load();
    },
  };
}
