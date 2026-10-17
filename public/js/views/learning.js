import { h, api, fmtPct, fmtDate, stagger } from '../util.js';
import { LineChart } from '../charts.js';

export function mount(root) {
  root.innerHTML = `
  <div class="page-head"><div><div class="eyebrow">Evaluasi &amp; perbaikan</div><h1>Pembelajaran</h1>
    <p>Bagaimana aturan buku utama berevolusi, apakah confidence bot terkalibrasi, dan apakah hasil bertahan di luar sampel.</p></div></div>
  <div class="grid">
    <section class="card span-7"><header class="card-head"><div><h3>Evolusi aturan buku utama</h3><div class="sub">backtest 12 bulan, seleksi kausal · PF out-of-sample</div></div></header>
      <ol class="timeline" data-ref="timeline"></ol></section>
    <section class="card span-5"><header class="card-head"><h3>Catatan</h3></header><ul class="notes" data-ref="notes"></ul></section>
    <section class="card span-6"><header class="card-head"><div><h3>Kalibrasi confidence</h3><div class="sub">P(win) saat entry vs win rate aktual</div></div></header>
      <div class="legend"><span><i class="dash"></i>Ideal (terkalibrasi sempurna)</span><span><i style="background:var(--cyan)"></i>Aktual</span></div>
      <div class="chart" data-ref="calib" style="height:230px"></div><div class="note" data-ref="calibNote"></div></section>
    <section class="card span-6"><header class="card-head"><div><h3>Walk-forward</h3><div class="sub">40 hari in-sample → 20 hari out-of-sample, digeser 60 hari</div></div></header>
      <div class="legend"><span><i style="background:var(--blue)"></i>PF in-sample</span><span><i style="background:var(--green)"></i>PF out-of-sample</span></div>
      <div data-ref="wf" style="display:flex;align-items:flex-end;gap:14px;height:200px;padding:20px 0 0;position:relative"></div>
      <div class="note" data-ref="wfNote"></div></section>
    <section class="card span-12"><header class="card-head"><div><h3>Sizing</h3><div class="sub">Kelly dari 300 trade terakhir</div></div></header>
      <div class="stat-cards" data-ref="sizing"></div><div class="note warn">Kelly mengasumsikan statistik masa lalu tetap berlaku. Pakai paling banyak seperempat Kelly, dan jangan di atas risiko sekarang bila Kelly ≤ 0.</div></section>
  </div>`;
  const ref = Object.fromEntries([...root.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));
  const calib = new LineChart(ref.calib, { yFormat: (v) => `${Math.round(v * 100)}%`, xFormat: (v) => `${Math.round(v * 100)}%`, xTicks: 5 });

  api('/api/learning').then((d) => {
    ref.timeline.replaceChildren(...d.evolution.map((e, i) => h('li', { class: i === d.evolution.length - 1 ? 'current' : '' },
      h('h4', { html: `<span class="tag ${i === d.evolution.length - 1 ? 'green' : 'blue'}">${e.v}</span>${e.title}<span class="dim small mono">${e.date}</span>` }),
      h('p', { html: `${e.note} <b class="${e.pf >= 1 ? 'up' : 'down'} mono">PF ${e.pf.toFixed(2)}</b>` }))));
    ref.notes.replaceChildren(...d.notes.map((n) => h('li', {}, n)));

    const b = d.calibration;
    if (b.length >= 2) {
      calib.setData({
        x: b.map((q) => (q.lo + q.hi) / 2),
        series: [
          { key: 'ideal', label: 'Ideal', values: b.map((q) => q.predicted), color: '#ffd23b', dash: [5, 5], width: 1.5 },
          { key: 'act', label: 'Aktual', values: b.map((q) => q.actual), color: '#22f0ff', width: 2.4, fill: true },
        ],
      });
      const ece = b.reduce((a, q) => a + Math.abs(q.actual - q.predicted) * q.n, 0) / b.reduce((a, q) => a + q.n, 0);
      ref.calibNote.textContent = `ECE ≈ ${fmtPct(ece, 1)} dari ${b.reduce((a, q) => a + q.n, 0)} trade. Di bawah 5% berarti confidence cukup jujur.`;
    }

    const wf = d.walkForward;
    const max = Math.max(1.6, ...wf.flatMap((w) => [w.isPF, w.oosPF]).filter(Number.isFinite));
    const line = h('div', { style: `position:absolute;left:0;right:0;bottom:${(1 / max) * 180 + 22}px;border-top:1px dashed var(--yellow);opacity:.6` });
    line.append(h('span', { class: 'mono small', style: 'position:absolute;right:0;top:-16px;color:var(--yellow)' }, 'PF 1'));
    ref.wf.replaceChildren(line, ...wf.map((w) => {
      const bar = (v, c) => {
        const el = h('div', { title: `PF ${v.toFixed(2)}`, style: `flex:1;height:0;border-radius:5px 5px 0 0;background:${c};transition:height .9s cubic-bezier(.2,.8,.2,1)` });
        requestAnimationFrame(() => requestAnimationFrame(() => { el.style.height = `${(Math.min(v, max) / max) * 180}px`; }));
        return el;
      };
      return h('div', { style: 'flex:1;display:flex;flex-direction:column;align-items:stretch;gap:4px' },
        h('div', { style: 'display:flex;align-items:flex-end;gap:3px;height:180px' }, bar(w.isPF, 'var(--blue)'), bar(w.oosPF, w.oosPF >= 1 ? 'var(--green)' : 'var(--red)')),
        h('div', { class: 'mono dim', style: 'font-size:10px;text-align:center' }, fmtDate(w.end)));
    }));
    const kept = wf.filter((w) => w.oosPF >= 1).length;
    ref.wfNote.textContent = `${kept}/${wf.length} jendela out-of-sample dengan PF ≥ 1. Selisih besar antara IS dan OOS menandakan overfit.`;

    const s = d.sizing;
    ref.sizing.innerHTML = [
      ['Win rate', fmtPct(s.winRate, 1), '300 trade terakhir'],
      ['Payoff (avg win / avg loss)', s.payoff.toFixed(2), 'dalam R'],
      ['Kelly penuh', fmtPct(s.kelly, 1), s.kelly <= 0 ? 'tidak ada edge' : 'teoretis, terlalu agresif'],
      ['¼ Kelly vs sekarang', `${fmtPct(s.quarterKelly, 2)} / ${fmtPct(s.current, 1)}`, s.quarterKelly < s.current ? 'risiko sekarang lebih besar dari ¼ Kelly' : 'risiko sekarang konservatif'],
    ].map(([a, b2, c]) => `<div class="card stat"><small>${a}</small><b>${b2}</b><div class="sub">${c}</div></div>`).join('');
    stagger(root);
  });
  return {};
}
