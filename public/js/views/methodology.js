import { h, api, stagger } from '../util.js';

const FLOW = [
  ['Data', 'Harga close per bar; candle yang belum close dibuang.'],
  ['Sinyal', 'Setiap strategi menilai bias, rezim volatilitas, dan sesi saat bar close.'],
  ['Seleksi sel', 'Hanya sel yang lolos aturan v1.2c dan searah siklus masuk buku utama.'],
  ['Eksekusi', 'Risiko 0,5% ekuitas per R, SL maksimal 3%, TP1 → breakeven, TP2, time stop.'],
  ['Evaluasi', 'Jurnal, kalibrasi, walk-forward, dan pelajaran dari kekalahan diperbarui otomatis.'],
];

export function mount(root) {
  root.innerHTML = `
  <div class="page-head"><div><div class="eyebrow">Cara kerja</div><h1>Metodologi, glosarium, batasan</h1></div></div>
  <div class="grid">
    <section class="card span-12"><div class="flow">${FLOW.map(([t, p], i) => `<div class="flow-step"><span class="n">0${i + 1}</span><h4>${t}</h4><p>${p}</p></div>`).join('')}</div></section>
    <section class="card span-6"><header class="card-head"><h3>Aturan aktif</h3></header><div class="rule-box" data-ref="rule"></div>
      <h4 style="margin:18px 0 10px">Batasan</h4><ul class="notes" data-ref="limits"></ul></section>
    <section class="card span-6"><header class="card-head"><h3>Glosarium singkat</h3></header><dl class="gloss" data-ref="gloss"></dl></section>
  </div>`;
  const ref = Object.fromEntries([...root.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));
  stagger(root);
  api('/api/methodology').then((d) => {
    const r = d.rule;
    ref.rule.innerHTML = `<b>${r.version}</b> · jendela ${r.window} trade<br/>n ≥ ${r.minN} · kedua paruh positif · PF ≥ ${r.minPF} · rata-rata ≥ +${r.minAvgR}R · LCB ≥ +${r.minLcbR}R<br/>Buku utama: ${r.mainBookTFs.join(' / ')} searah siklus (Long hanya di tahun bull, Short hanya di tahun bear)`;
    ref.limits.replaceChildren(...d.limitations.map((l) => h('li', {}, l)));
    ref.gloss.replaceChildren(...d.glossary.flatMap(([t, def]) => [h('dt', {}, t), h('dd', {}, def)]));
  });
  return {};
}
