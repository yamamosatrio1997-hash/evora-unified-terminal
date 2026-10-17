import { h, api, fmtR, fmtPct, stagger } from '../util.js';

const TFS = ['1D', '4H', '1H', '15m', '5m'];
const EXITS = ['2R tetap', 'Trailing ATR'];
const DIRS = ['LONG', 'SHORT'];
const COLS = TFS.flatMap((tf) => EXITS.flatMap((exit) => DIRS.map((dir) => ({ tf, exit, dir }))));

function heatColor(r) {
  const t = Math.max(-1, Math.min(1, r / 0.22));
  if (t >= 0) return `rgba(34,227,155,${0.15 + t * 0.85})`;
  return `rgba(255,92,122,${0.15 + -t * 0.85})`;
}

export function mount(root) {
  root.innerHTML = `
  <div class="page-head"><div><div class="eyebrow" data-ref="eyebrow">memuat</div><h1>Strategi &amp; setup</h1>
    <p>Sel = strategi × timeframe × exit × arah. Warna = rata-rata R per trade (300 trade terakhir); titik putih = lolos aturan aktif.</p></div></div>
  <div class="grid">
    <section class="card span-8">
      <div class="rule-box" data-ref="rule"></div>
    </section>
    <section class="card span-4 stat">
      <small>Sel aktif / total</small><b data-ref="activeCount">—</b>
      <div class="sub" data-ref="mainSub"></div>
      <div class="rule-chips" data-ref="mainBook"></div>
    </section>
    <section class="card span-12">
      <header class="card-head">
        <div class="filters">
          <div class="seg" data-ref="status">${['Semua', 'Aktif', 'Pantau', 'Nonaktif'].map((s, i) => `<button class="${i ? '' : 'on'}" data-v="${i ? s : ''}">${s}</button>`).join('')}</div>
          <div class="seg" data-ref="tf"><button class="on" data-v="">Semua TF</button>${TFS.map((t) => `<button data-v="${t}">${t}</button>`).join('')}</div>
        </div>
        <div class="scale">−0,22R <i></i> +0,22R</div>
      </header>
      <div class="table-wrap"><div class="heat" data-ref="heat" style="min-width:760px"></div></div>
    </section>
    <section class="card span-12" data-ref="detailCard" hidden>
      <header class="card-head"><h3 data-ref="detailTitle"></h3><button class="chip" data-ref="closeDetail">Tutup</button></header>
      <div class="table-wrap"><table>
        <thead><tr><th>TF</th><th>Exit</th><th>Arah</th><th class="num">n</th><th class="num">Rata-rata</th><th class="num">LCB</th><th class="num">PF</th><th class="num">Paruh 1</th><th class="num">Paruh 2</th><th>Status</th><th>Alasan gagal</th></tr></thead>
        <tbody data-ref="detail"></tbody>
      </table></div>
    </section>
  </div>`;
  const ref = Object.fromEntries([...root.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));
  const tip = h('div', { class: 'heat-tip', hidden: true });
  document.body.append(tip);
  const filter = { status: '', tf: '' };
  let data = null;

  function showDetail(s) {
    ref.detailCard.hidden = false;
    ref.detailTitle.textContent = `Detail sel · ${s.name}`;
    ref.detail.replaceChildren(...s.cells.map((c) => h('tr', { html: `
      <td>${c.tf}</td><td>${c.exit}</td><td class="${c.dir === 'LONG' ? 'side-long' : 'side-short'}">${c.dir}</td>
      <td class="num">${c.n}</td><td class="num ${c.avgR >= 0 ? 'up' : 'down'}">${fmtR(c.avgR, 3)}</td><td class="num">${fmtR(c.lcb, 3)}</td>
      <td class="num">${c.pf.toFixed(2)}</td><td class="num">${fmtR(c.half1, 2)}</td><td class="num">${fmtR(c.half2, 2)}</td>
      <td><span class="tag ${c.status === 'Aktif' ? 'green' : c.status === 'Pantau' ? 'yellow' : 'muted'}">${c.status}${c.forward ? ' · FWD' : ''}</span></td>
      <td class="muted small">${c.fails.join('; ') || '—'}</td>` })));
    ref.detailCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function render() {
    const head = h('div', { class: 'hrow' }, h('div'), ...COLS.map((c) => h('div', { class: 'hcol' }, `${c.tf} ${c.exit === '2R tetap' ? '2R' : 'ATR'} ${c.dir === 'LONG' ? 'L' : 'S'}`)), h('div', { class: 'hcol' }, 'aktif'));
    const rows = data.strategies.map((s, si) => {
      const cells = COLS.map((col) => {
        const c = s.cells.find((x) => x.tf === col.tf && x.exit === col.exit && x.dir === col.dir);
        if (!c) return h('div', { class: 'cell', style: 'background:transparent;cursor:default;box-shadow:inset 0 0 0 1px rgba(120,140,220,.08)' });
        const dim = (filter.status && c.status !== filter.status) || (filter.tf && c.tf !== filter.tf);
        const el = h('div', { class: `cell${c.active ? ' active' : ''}${dim ? ' dimmed' : ''}`, style: `background:${heatColor(c.avgR)};opacity:0;transition:opacity .4s ${(si * 20 + COLS.indexOf(col) * 6)}ms, transform .15s` });
        el.addEventListener('mouseenter', () => {
          tip.innerHTML = `<h4>${s.name} · ${c.tf} · ${c.exit} · ${c.dir}</h4>
            <div class="metrics"><div><span>n</span><b>${c.n}</b></div><div><span>Rata-rata</span><b>${fmtR(c.avgR, 3)}</b></div>
            <div><span>LCB 90%</span><b>${fmtR(c.lcb, 3)}</b></div><div><span>PF</span><b>${c.pf.toFixed(2)}</b></div>
            <div><span>Paruh 1</span><b>${fmtR(c.half1)}</b></div><div><span>Paruh 2</span><b>${fmtR(c.half2)}</b></div>
            <div><span>Win rate</span><b>${fmtPct(c.winRate, 0)}</b></div><div><span>Status</span><b>${c.status}</b></div></div>
            ${c.fails.length ? `<ul>${c.fails.map((f) => `<li>${f}</li>`).join('')}</ul>` : '<p class="up" style="margin:8px 0 0">Lolos semua syarat v1.2c</p>'}`;
          tip.hidden = false;
        });
        el.addEventListener('mousemove', (e) => {
          const x = e.clientX + 16 + 260 > innerWidth ? e.clientX - 266 : e.clientX + 16;
          tip.style.left = `${x}px`;
          tip.style.top = `${Math.min(innerHeight - tip.offsetHeight - 10, e.clientY + 12)}px`;
        });
        el.addEventListener('mouseleave', () => { tip.hidden = true; });
        el.addEventListener('click', () => showDetail(s));
        return el;
      });
      const name = h('div', { class: 'hname', title: s.name, html: `${s.name}${s.forward ? ' <span class="fw">FWD</span>' : ''}` });
      name.addEventListener('click', () => showDetail(s));
      return h('div', { class: 'hrow' }, name, ...cells, h('div', { class: 'hact' }, `${s.active}/${s.cells.length}`));
    });
    ref.heat.replaceChildren(head, ...rows);
    requestAnimationFrame(() => ref.heat.querySelectorAll('.cell').forEach((c) => { if (c.style.opacity === '0') c.style.opacity = ''; }));
  }

  api('/api/strategies').then((d) => {
    data = d;
    const r = d.rule;
    ref.eyebrow.textContent = `${d.strategies.length} strategi · ${d.totalCells} sel`;
    ref.rule.innerHTML = `<b>Aturan ${r.version}:</b> sel aktif bila dari ${r.window} trade terakhir <b>n ≥ ${r.minN}</b>, kedua paruh positif, <b>PF ≥ ${r.minPF.toString().replace('.', ',')}</b>, rata-rata <b>≥ +${r.minAvgR.toString().replace('.', ',')}R</b> dan batas bawah keyakinan <b>≥ +${r.minLcbR.toString().replace('.', ',')}R</b>. Buku utama hanya mengambil sel aktif <b>${r.mainBookTFs.join('/')}</b> yang searah siklus (sekarang <b>${d.cycle}</b>).`;
    ref.activeCount.textContent = `${d.activeCells} / ${d.totalCells}`;
    ref.mainSub.textContent = `${d.mainBook.length} sel masuk buku utama (${d.cycle})`;
    ref.mainBook.replaceChildren(...d.mainBook.map((c) => h('span', { class: 'tag green' }, `${c.strategy} · ${c.tf} · ${c.exit === '2R tetap' ? '2R' : 'ATR'}`)));
    render();
    stagger(root);
  });

  const bindSeg = (el, key) => el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    filter[key] = b.dataset.v;
    el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    if (data) render();
  });
  bindSeg(ref.status, 'status');
  bindSeg(ref.tf, 'tf');
  ref.closeDetail.addEventListener('click', () => { ref.detailCard.hidden = true; });

  return { destroy: () => tip.remove() };
}
