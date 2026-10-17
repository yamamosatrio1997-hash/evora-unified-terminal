import { h, api, tweenNumber, fmtUsd, fmtPct, stagger, coin } from '../util.js';
import { LineChart } from '../charts.js';

const STATUS = { lolos: 'green', parsial: 'yellow', tidak: 'red', baseline: 'blue', 'tidak diimplementasikan': 'muted' };

export function mount(root) {
  root.innerHTML = `
  <div class="page-head"><div><div class="eyebrow">LightGBM · XGBoost · HMM · GARCH · ensemble · Monte Carlo</div><h1>Lab prediktif</h1>
    <p>Vonis: edge arah 4H sangat tipis. Volatilitas lebih bisa diprediksi daripada arah, jadi model dipakai untuk rentang harga dan ukuran stop, bukan untuk menebak naik/turun.</p></div></div>
  <div class="grid">
    <section class="card span-8"><header class="card-head"><div><h3>Monte Carlo ekuitas 30 hari</h3><div class="sub" data-ref="mcSub">bootstrap R dari 300 trade terakhir</div></div></header>
      <div class="legend"><span><i style="background:rgba(61,139,255,.35)"></i>5–95%</span><span><i style="background:rgba(61,139,255,.6)"></i>25–75%</span><span><i style="background:#22e39b"></i>Median</span><span><i class="dash"></i>+$1.000</span></div>
      <div class="chart" data-ref="mc" style="height:280px"></div></section>
    <section class="span-4" style="display:grid;gap:16px">
      <div class="card prob-ring"><small class="muted">P(≥ +$1.000 dalam 30 hari)</small><b data-ref="pTarget">—</b><div class="note">simulasi, bukan hasil aktual</div></div>
      <div class="card prob-ring"><small class="muted">P(drawdown ≥ 10%)</small><b class="down" data-ref="pDD">—</b><div class="note" data-ref="perDay"></div></div>
    </section>
    <section class="card span-12"><header class="card-head"><div><h3>Perbandingan model</h3><div class="sub">walk-forward kuartalan, out-of-sample · contoh ilustrasi sampai disambungkan ke pred_report.json</div></div></header>
      <div class="table-wrap"><table><thead><tr><th>Model</th><th>Target</th><th class="num">AUC</th><th class="num">Brier</th><th class="num">ECE</th><th>Status</th><th>Catatan</th></tr></thead><tbody data-ref="models"></tbody></table></div></section>
    <section class="card span-6"><header class="card-head"><div><h3>P(arah) live per pair</h3><div class="sub">peluang close berikutnya naik · forward live</div></div></header><div class="dbars" data-ref="pdir"></div>
      <div class="note">P(arah) ≠ P(win). Nilai dekat 50% adalah jujur: edge arah memang tipis.</div></section>
    <section class="card span-6"><header class="card-head"><div><h3>Volatilitas GARCH(1,1)</h3><div class="sub">σ 1 jam ke depan vs σ dasar · forward live</div></div></header><div class="dbars" data-ref="vol"></div></section>
    <section class="card span-12"><header class="card-head"><div><h3>P(win) posisi terbuka</h3><div class="sub">meta-model confidence saat entry</div></div></header><div class="dbars" data-ref="pwin"></div></section>
  </div>`;
  const ref = Object.fromEntries([...root.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));
  const mc = new LineChart(ref.mc, { yFormat: (v) => `$${Math.round(v).toLocaleString('en-US')}`, xFormat: (d) => `H+${d}`, tipX: (d) => `Hari ke-${d}`, tipFormat: fmtUsd });

  function row(label, frac, val, color, sub = '') {
    const el = h('div', { class: 'dbar' },
      h('div', { html: `${label}${sub ? `<br><small>${sub}</small>` : ''}` }),
      h('div', { class: 'track' }, h('div', { class: 'fill', style: `left:0;width:${Math.max(0, Math.min(100, frac * 100))}%;background:${color}` })),
      h('div', { class: 'val' }, val));
    return el;
  }

  // diverging bar around 50%: ±10pp fills the half-track
  function dirRow(label, p, sub) {
    const w = Math.min(50, (Math.abs(p - 0.5) / 0.1) * 50);
    return h('div', { class: 'dbar' },
      h('div', { html: `${label}<br><small>${sub}</small>` }),
      h('div', { class: 'track' }, h('div', { class: 'fill', style: `left:${p >= 0.5 ? 50 : 50 - w}%;width:${w}%;background:${p >= 0.5 ? 'var(--green)' : 'var(--red)'}` })),
      h('div', { class: `val ${p >= 0.5 ? 'up' : 'down'}` }, fmtPct(p, 1)));
  }

  async function load() {
    const d = await api('/api/predictive');
    const b = d.bands;
    mc.setData({
      x: b.map((q) => q.d),
      bands: [
        { lo: b.map((q) => q.p5), hi: b.map((q) => q.p95), color: 'rgba(61,139,255,.16)', label: '5–95%', swatch: 'rgba(61,139,255,.4)' },
        { lo: b.map((q) => q.p25), hi: b.map((q) => q.p75), color: 'rgba(61,139,255,.28)', label: '25–75%', swatch: 'rgba(61,139,255,.7)' },
      ],
      series: [
        { key: 'tgt', values: b.map(() => d.eq0 + 1000), color: '#ffc94d', dash: [5, 5], width: 1.4, label: 'Target' },
        { key: 'p50', values: b.map((q) => q.p50), color: '#22e39b', width: 2.4, label: 'Median', glow: true },
      ],
    });
    ref.mcSub.textContent = `${d.paths} jalur · ${d.perDay.toFixed(1)} trade/hari · bootstrap R dari 300 trade terakhir`;
    tweenNumber(ref.pTarget, d.probTarget, (x) => fmtPct(x, 1), { flash: false });
    tweenNumber(ref.pDD, d.probDD10, (x) => fmtPct(x, 1), { flash: false });
    ref.pTarget.className = d.probTarget >= 0.5 ? 'up' : '';
    ref.perDay.textContent = `ekuitas awal ${fmtUsd(d.eq0)}`;
    if (!ref.models.children.length) {
      ref.models.replaceChildren(...d.models.map((m) => h('tr', { html: `
        <td><b>${m.name}</b></td><td class="muted">${m.task}</td>
        <td class="num">${m.auc?.toFixed(3) ?? '—'}</td><td class="num">${m.brier?.toFixed(4) ?? '—'}</td><td class="num">${m.ece != null ? fmtPct(m.ece, 1) : '—'}</td>
        <td><span class="tag ${STATUS[m.status]}">${m.status}</span></td><td class="muted small wrap">${m.note}</td>` })));
    }
    ref.vol.replaceChildren(...d.vols.map((v) => row(v.base, (v.volNow / v.volBase) / 2, `${(v.volNow / v.volBase).toFixed(2)}×`,
      v.volNow > v.volBase * 1.15 ? 'var(--red)' : v.volNow < v.volBase * 0.88 ? 'var(--cyan)' : 'var(--purple)', `σ ${fmtPct(v.volNow, 2)}/jam`)));
    stagger(root);
  }
  load();
  const timer = setInterval(load, 20000);

  function update(s) {
    ref.pdir.replaceChildren(...s.prices.map((p) => {
      const pUp = 0.5 + 0.08 * Math.tanh(p.strength);
      return dirRow(coin(p.sym), pUp, `bias ${p.bias.toLowerCase()} · rezim vol ${p.regime}`);
    }));
    ref.pwin.replaceChildren(...(s.positions.length ? s.positions.map((p) => row(`${coin(p.pair)} <span class="${p.side === 'LONG' ? 'side-long' : 'side-short'}">${p.side}</span>`, p.conf, fmtPct(p.conf, 0), p.conf >= 0.55 ? 'var(--green)' : 'var(--yellow)', p.botName))
      : [h('div', { class: 'muted small' }, 'Tidak ada posisi terbuka.')]));
  }
  return { update, destroy: () => clearInterval(timer) };
}
