import { h, api, fmtR, stagger } from '../util.js';

const STATUS = { lolos: 'green', gagal: 'red', pantau: 'yellow' };

export function mount(root) {
  root.innerHTML = `
  <div class="page-head"><div><div class="eyebrow">YouTube · TradingView · riset publik</div><h1>Insight yang diuji</h1>
    <p>Video tidak ditonton langsung; aturan diambil dari ringkasan transkrip, deskripsi, dan kode publik, lalu dikunci sebelum backtest. Instagram belum bisa dicari secara terstruktur.</p></div>
    <div class="seg" data-ref="seg"><button class="on" data-v="">Semua</button><button data-v="lolos">Lolos</button><button data-v="pantau">Pantau</button><button data-v="gagal">Gagal</button></div></div>
  <div class="grid" data-ref="list"></div>`;
  const ref = Object.fromEntries([...root.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));
  let items = [], f = '';
  const render = () => {
    ref.list.replaceChildren(...items.filter((i) => !f || i.status === f).map((i) => h('section', { class: 'card insight span-4' },
      h('div', { class: 'src', html: `<span class="tag blue">${i.source}</span><span class="tag ${STATUS[i.status]}">${i.status.toUpperCase()}</span>` }),
      h('h4', {}, i.title),
      h('p', {}, i.rule),
      h('div', { class: 'metrics', style: 'grid-template-columns:1fr 1fr 1fr', html: `<div><span>n</span><b>${i.n}</b></div><div><span>PF</span><b class="${i.pf >= 1.15 ? 'up' : i.pf < 1 ? 'down' : ''}">${i.pf.toFixed(2)}</b></div><div><span>R/trade</span><b class="${i.avgR >= 0 ? 'up' : 'down'}">${fmtR(i.avgR)}</b></div>` }))));
    stagger(ref.list);
  };
  ref.seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    f = b.dataset.v;
    ref.seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  });
  api('/api/insights').then((d) => { items = d.insights; render(); });
  return {};
}
