import { $, h, icon, api, tweenNumber, fmtUsd, fmtSignedUsd, fmtSignedPct, fmtPct, fmtR, fmtPx, fmtTime, fmtDate, coin, sideTag, statusTag, stagger } from '../util.js';
import { LineChart, Donut, sparkline } from '../charts.js';
import { heroScene, botAvatar } from '../pixel.js';

const MONTH = 30 * 86400000;
const ALLOC_COLORS = ['#ffc94d', '#9b7bff', '#33d6ff', '#3d8bff', '#22e39b', '#5f6c9c'];

const KPIS = [
  { key: 'winRate', label: 'Win Rate', icon: 'winrate', c: 'var(--green)' },
  { key: 'trades', label: 'Total Trades · 30h', icon: 'swap', c: 'var(--blue)' },
  { key: 'pf', label: 'Profit Factor', icon: 'star', c: 'var(--purple)' },
  { key: 'maxDD', label: 'Max Drawdown', icon: 'shield', c: 'var(--red)' },
];

export function mount(root) {
  root.innerHTML = `
  <div class="grid">
    <section class="card hero span-8">
      <canvas class="pixel" width="320" height="118"></canvas>
      <div class="hero-copy">
        <h1>Trading Bot</h1>
        <h2>Auto trade. Lebih terukur.</h2>
        <div class="hero-status"><span class="dot"></span><span data-ref="heroStatus">System Online</span></div>
        <div class="hero-meta">Scanning 24/7 • 8 pair • Futures 10x</div>
      </div>
      <span class="hero-chip">PAPER MODE · SIMULASI</span>
    </section>

    <section class="card equity-card span-4">
      <div class="equity-top">
        <div>
          <div class="label">Total Equity <button data-ref="eye" aria-label="Sembunyikan nominal">${icon('eye')}</button></div>
          <div class="equity-value money" data-ref="equity">$0.00</div>
          <div class="equity-change" data-ref="change">—</div>
        </div>
        <canvas class="equity-spark" data-ref="spark"></canvas>
      </div>
      <div class="equity-split">
        <div><small>Available Margin</small><b class="money" data-ref="avail">—</b></div>
        <div><small>PnL Berjalan</small><b class="money" data-ref="unreal">—</b></div>
      </div>
    </section>

    <section class="card span-12">
      <div class="verdict">
        <div class="verdict-score"><span data-ref="hit">0</span><small>/<span data-ref="total">4</span></small></div>
        <div>
          <div class="eyebrow">Laporan lab · 30 hari terakhir</div>
          <h2>Apakah ada setup yang sudah mencapai target?</h2>
          <div class="muted small" data-ref="verdictText">memuat vonis</div>
          <div class="checks" data-ref="checks"></div>
        </div>
      </div>
    </section>

    ${KPIS.map((k) => `
    <section class="card kpi kpi-card span-3" style="--c:${k.c}" data-kpi="${k.key}">
      <div class="kpi-top"><span class="kpi-icon">${icon(k.icon)}</span>${k.label}</div>
      <div class="kpi-row"><span class="kpi-value">—</span><span class="kpi-delta"></span></div>
      <div class="bar"><i></i></div>
    </section>`).join('')}

    <section class="card span-7">
      <header class="card-head">
        <div><h3>Pertumbuhan ekuitas</h3><div class="sub">modal $10.000 · realisasi + PnL berjalan</div></div>
        <div class="seg" data-ref="ranges">${['1D', '1W', '1M', '3M', '1Y', 'ALL'].map((r) => `<button data-range="${r}" class="${r === '1D' ? 'on' : ''}">${r}</button>`).join('')}</div>
      </header>
      <div class="legend"><span><i style="background:var(--green)"></i>Ekuitas buku utama</span><span><i class="dash"></i>Jalur target $1.000/bulan</span></div>
      <div class="chart" data-ref="chart"></div>
    </section>

    <section class="card span-5">
      <header class="card-head"><div><h3>Strategi terdekat ke target</h3><div class="sub">PnL 30 hari per bot vs $1.000/bulan</div></div></header>
      <div class="bots" data-ref="bots"></div>
    </section>

    <section class="card span-7">
      <header class="card-head"><h3>Recent Trades</h3><a class="link" href="#/jurnal">Jurnal ${icon('arrowRight')}</a></header>
      <div class="table-wrap"><table>
        <thead><tr><th>Waktu</th><th>Pair</th><th>Side</th><th class="num">Entry</th><th class="num">Exit</th><th class="num">P/L</th><th>Status</th></tr></thead>
        <tbody data-ref="trades"></tbody>
      </table></div>
    </section>

    <section class="card span-5">
      <header class="card-head"><div><h3>Alokasi Trade</h3><div class="sub">porsi notional 30 hari per aset</div></div></header>
      <div class="alloc">
        <div class="donut-wrap" data-ref="donut"><div class="donut-center"><b class="money" data-ref="donutVal">—</b><small>Total Equity</small></div></div>
        <ul class="alloc-list" data-ref="allocList"></ul>
      </div>
    </section>

    <section class="card span-4">
      <header class="card-head"><h3>Metrik lengkap</h3></header>
      <div class="metrics" data-ref="metrics" style="grid-template-columns:1fr"></div>
    </section>

    <section class="card span-4">
      <header class="card-head"><h3>Pelajaran terbaru</h3><a class="link" href="#/kekalahan">Detail ${icon('arrowRight')}</a></header>
      <ol class="lesson-list" data-ref="lessons"><li><div class="skeleton"></div></li></ol>
    </section>

    <section class="card span-4">
      <header class="card-head"><h3>Mengapa $1.000/bulan sulit?</h3></header>
      <div class="math" data-ref="math"><div class="skeleton" style="height:120px"></div></div>
    </section>
  </div>`;

  const ref = Object.fromEntries([...root.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));
  heroScene(root.querySelector('.hero canvas'));
  stagger(root);

  ref.eye.addEventListener('click', () => {
    document.getElementById('optHide').click();
  });

  // equity chart
  const chart = new LineChart(ref.chart, { yFormat: (v) => `$${Math.round(v).toLocaleString('en-US')}`, tipFormat: (v) => fmtUsd(v) });
  let range = '1D', series = null, sparkVals = [], sparkSeeded = false;
  const xFmt = (t) => (range === '1D' ? fmtTime(t) : fmtDate(t));
  chart.o.xFormat = xFmt;
  chart.o.tipX = (t) => `${fmtDate(t)} ${fmtTime(t)}`;

  async function loadRange(r) {
    range = r;
    ref.ranges.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.range === r));
    const data = await api(`/api/equity?range=${r}`);
    if (range !== r) return;
    series = data;
    const p = data.points;
    const t0 = p[0].t, v0 = p[0].v;
    const targetAt = (t) => v0 + (data.target * (t - t0)) / MONTH;
    chart.setData({
      x: p.map((q) => q.t),
      series: [
        { key: 'target', label: 'Jalur target', values: p.map((q) => targetAt(q.t)), color: '#ffc94d', width: 1.5, dash: [5, 5], nextFn: targetAt },
        { key: 'eq', label: 'Ekuitas', values: p.map((q) => q.v), color: '#22e39b', fill: true, width: 2.2, live: true, glow: true },
      ],
    });
    if (r === '1D' && !sparkSeeded) { sparkSeeded = true; sparkVals = [...p.slice(-40).map((q) => q.v), ...sparkVals].slice(-40); }
  }
  ref.ranges.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) loadRange(b.dataset.range); });
  loadRange('1D');

  // bots
  const botRows = new Map();
  function buildBots(bots) {
    ref.bots.replaceChildren(...bots.map((b) => {
      const cv = h('canvas', { class: 'pixel', width: 12, height: 11 });
      botAvatar(cv, b.color);
      const row = h('div', { class: 'bot-row', style: `--c:${b.color}` },
        h('div', { class: 'bot-avatar' }, cv),
        h('div', {},
          h('div', { class: 'bot-name', html: `${b.name} <small>(${b.pairs.map((p) => p.split('/')[0]).join('/')})</small> <span class="state"></span>` }),
          h('div', { class: 'bar' }, h('i'))),
        h('div', { class: 'bot-pct' }, h('span', { class: 'pct' }), h('small', { class: 'money pnl' })));
      botRows.set(b.id, row);
      return row;
    }));
  }

  // lessons + target math (heavier, refreshed every 30s)
  async function loadLessons() {
    try {
      const d = await api('/api/lessons');
      const rows = d.cross.rows.filter((r) => r.delta < 0).slice(0, 3);
      ref.lessons.replaceChildren(...rows.map((r, i) => h('li', {},
        h('span', { class: 'n' }, `0${i + 1}`),
        h('div', { html: `<b>${r.label}</b>: ${fmtR(r.delta)} per trade vs rata-rata<small>SL rate ${fmtPct(r.slRate, 0)} · n=${r.n}</small>` }))));
      const t = d.target;
      ref.math.innerHTML = `
        <div class="eq">ekspektasi/bulan = <b>${fmtR(t.avgR, 3)}</b> × <b>$${t.riskUsd.toFixed(0)}</b>/R × <b>${t.tradesPerMonth}</b> trade<br/>= <b>${fmtSignedUsd(t.expectedMonthly)}</b> <span class="dim">(biaya 0,15%)</span><br/>= <b>${fmtSignedUsd(t.expectedMonthlyStress)}</b> <span class="dim">(stress 0,30%)</span></div>
        <div>${t.requiredTrades
          ? `Dengan edge ${fmtR(t.avgR, 3)} dan risiko 0,5%/trade, butuh <b>${Math.ceil(t.requiredTrades)}</b> trade per bulan, atau risiko <b>${fmtPct(t.requiredRiskPct, 1)}</b> per trade pada frekuensi sekarang. Menaikkan risiko memperbesar drawdown setara.`
          : 'Ekspektasi per trade saat ini tidak positif, jadi menambah frekuensi atau risiko hanya mempercepat kerugian.'}</div>
        <div class="dim small">Kalau edge hilang saat biaya naik ke 0,30%, edge itu terlalu tipis untuk diandalkan.</div>`;
    } catch { /* keep skeleton; next refresh retries */ }
  }
  loadLessons();
  const lessonTimer = setInterval(loadLessons, 30000);

  const donut = new Donut(ref.donut, { size: 170, stroke: 18 });
  ref.donut.prepend(donut.svg);
  let allocKey = '', lastTradeTop = null;

  function update(s, first) {
    const a = s.account;
    ref.heroStatus.textContent = s.running ? 'System Online' : 'Engine dijeda';
    tweenNumber(ref.equity, a.equity, fmtUsd, { money: true });
    ref.change.className = `equity-change ${a.todayPnl >= 0 ? 'up' : 'down'}`;
    ref.change.textContent = `${fmtSignedUsd(a.todayPnl)} (${fmtSignedPct(a.todayPct)}) 24 jam`;
    tweenNumber(ref.avail, a.available, fmtUsd, { flash: false });
    tweenNumber(ref.unreal, a.unrealized, fmtSignedUsd);
    ref.unreal.className = `money ${a.unrealized >= 0 ? 'up' : 'down'}`;
    tweenNumber(ref.donutVal, a.equity, (v) => `$${Math.round(v).toLocaleString('en-US')}`, { flash: false });

    sparkVals.push(a.equity);
    if (sparkVals.length > 40) sparkVals.shift();
    sparkline(ref.spark, sparkVals, sparkVals.at(-1) >= sparkVals[0] ? '#22e39b' : '#ff5c7a');

    if (series) chart.setLast('eq', a.equity, Math.floor(s.t / series.step) * series.step);

    // verdict
    const v = s.verdict;
    tweenNumber(ref.hit, v.hit, (x) => Math.round(x));
    ref.total.textContent = v.total;
    ref.verdictText.textContent = v.hit === v.total ? 'Semua target tercapai pada buku paper. Validasi out-of-sample sebelum percaya.'
      : v.hit === 0 ? 'Belum ada target yang tercapai. Teruskan forward test, jangan naikkan risiko.'
        : 'Sebagian target tercapai. Belum memenuhi semua syarat untuk dana sungguhan.';
    if (!ref.checks.children.length) ref.checks.replaceChildren(...v.checks.map((c) => h('div', { class: 'check', 'data-k': c.key }, h('small', {}, c.label), h('b'))));
    for (const c of v.checks) {
      const el = ref.checks.querySelector(`[data-k="${c.key}"]`);
      el.classList.toggle('ok', c.ok);
      const fmt = c.key === 'winRate' ? (x) => fmtPct(x, 1) : c.key === 'maxDD' ? (x) => fmtPct(x, 1) : c.key === 'pf' ? (x) => x.toFixed(2) : fmtSignedUsd;
      tweenNumber(el.querySelector('b'), c.value, fmt, { money: c.key === 'monthly' });
    }

    // KPIs
    const k = s.kpi;
    const kp = {
      winRate: { v: k.winRate, f: (x) => fmtPct(x, 1), d: `${k.winRateDelta >= 0 ? '▲' : '▼'} ${Math.abs(k.winRateDelta * 100).toFixed(1)}pp`, up: k.winRateDelta >= 0, bar: k.winRate / 0.7 },
      trades: { v: k.trades, f: (x) => Math.round(x), d: `▲ +${k.tradesToday} 24j`, up: true, bar: k.trades / 300 },
      pf: { v: k.pf, f: (x) => x.toFixed(2), d: `${k.pfDelta >= 0 ? '▲' : '▼'} ${k.pfDelta >= 0 ? '+' : '−'}${Math.abs(k.pfDelta).toFixed(2)}`, up: k.pfDelta >= 0, bar: k.pf / 3 },
      maxDD: { v: k.maxDD, f: (x) => fmtPct(x, 1), d: `${k.maxDDDelta >= 0 ? '▲' : '▼'} ${(k.maxDDDelta * 100).toFixed(1)}pp`, up: k.maxDDDelta >= 0, bar: Math.abs(k.maxDD) / 0.1 },
    };
    for (const [key, o] of Object.entries(kp)) {
      const card = root.querySelector(`[data-kpi="${key}"]`);
      tweenNumber(card.querySelector('.kpi-value'), o.v, o.f);
      const d = card.querySelector('.kpi-delta');
      d.textContent = o.d;
      d.className = `kpi-delta ${o.up ? 'up' : 'down'}`;
      card.querySelector('.bar i').style.width = `${Math.max(3, Math.min(100, o.bar * 100))}%`;
    }

    // bots
    if (botRows.size !== s.bots.length) buildBots(s.bots);
    for (const b of s.bots) {
      const row = botRows.get(b.id);
      row.querySelector('.bar i').style.width = `${Math.max(2, Math.min(100, b.progress * 100))}%`;
      tweenNumber(row.querySelector('.pct'), b.progress, (x) => `${Math.round(x * 100) || 0}%`, { flash: false });
      const pnl = row.querySelector('.pnl');
      pnl.textContent = fmtSignedUsd(b.monthPnl);
      const st = row.querySelector('.state');
      st.className = `state ${b.status}`;
      st.textContent = b.status === 'in-trade' ? `${b.open} OPEN` : b.status === 'paused' ? 'JEDA' : 'SCAN';
      row.querySelector('.bot-avatar').classList.toggle('busy', b.status === 'in-trade');
    }

    // recent trades
    const top = s.recentTrades[0]?.id;
    if (top !== lastTradeTop) {
      const prevTop = lastTradeTop;
      lastTradeTop = top;
      const known = prevTop == null ? Infinity : prevTop;
      ref.trades.replaceChildren(...s.recentTrades.slice(0, 6).map((t) => {
        const pct = ((t.exit - t.entry) / t.entry) * (t.side === 'LONG' ? 1 : -1);
        return h('tr', { class: !first && t.id > known ? 'new' : '', html: `
          <td class="mono dim">${fmtTime(t.closedAt)}</td><td>${coin(t.pair)}</td><td>${sideTag(t.side)}</td>
          <td class="num">${fmtPx(t.entry)}</td><td class="num">${fmtPx(t.exit)}</td>
          <td class="num ${t.pnl >= 0 ? 'up' : 'down'}">${fmtSignedPct(pct)}</td><td>${statusTag(t.status)}</td>` });
      }));
    }

    // allocation
    const key = s.allocation.map((x) => `${x.label}${x.pct.toFixed(3)}`).join();
    if (key !== allocKey) {
      allocKey = key;
      const items = s.allocation.map((x, i) => ({ ...x, color: ALLOC_COLORS[i % ALLOC_COLORS.length] }));
      donut.set(items);
      ref.allocList.replaceChildren(...items.map((x) => h('li', {}, h('i', { style: `background:${x.color}` }), x.label, h('b', {}, fmtPct(x.pct, 0)))));
    }

    // metrics
    const m = [
      ['Return sejak awal', fmtSignedPct(a.totalPct)],
      ['Rata-rata R / trade (30h)', fmtR(k.avgR, 3)],
      ['Trade 24 jam', String(k.tradesToday)],
      ['Posisi terbuka', `${s.positions.length} · limit ${s.pending.length}`],
      ['Risiko per trade', '0,5% ekuitas'],
      ['Biaya', '0,15% PP · stress 0,30%'],
      ['Leverage', '10x isolated'],
    ];
    ref.metrics.innerHTML = m.map(([l, val]) => `<div><span>${l}</span><b>${val}</b></div>`).join('');
  }

  return { update, destroy: () => clearInterval(lessonTimer) };
}
