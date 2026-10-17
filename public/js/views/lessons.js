import { h, api, fmtR, fmtPct, fmtTime, fmtDate, coin, sideTag, stagger } from '../util.js';

function dbars(rows, scale) {
  return h('div', { class: 'dbars' }, ...rows.map((r) => {
    const w = Math.min(50, (Math.abs(r.delta) / scale) * 50);
    const fill = h('div', { class: 'fill', style: `left:50%;width:0;background:${r.delta < 0 ? 'var(--red)' : 'var(--green)'}` });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fill.style.width = `${w}%`;
      fill.style.left = r.delta < 0 ? `${50 - w}%` : '50%';
    }));
    return h('div', { class: 'dbar' },
      h('div', { html: `${r.label}<br><small>n=${r.n} · SL ${fmtPct(r.slRate, 0)}</small>` }),
      h('div', { class: 'track' }, fill),
      h('div', { class: `val ${r.delta < 0 ? 'down' : 'up'}` }, fmtR(r.delta)));
  }));
}

export function mount(root) {
  root.innerHTML = `
  <div class="page-head"><div><div class="eyebrow">Belajar dari kekalahan</div><h1>Kondisi yang paling sering kena stop loss</h1>
    <p data-ref="sub">memuat</p></div></div>
  <div class="grid">
    <section class="card span-12" data-ref="headline"><div class="skeleton" style="height:60px"></div></section>
    <section class="card span-12"><header class="card-head"><div><h3>Per strategi</h3><div class="sub">bar = selisih R/trade kondisi vs rata-rata strategi</div></div></header>
      <div class="grid" data-ref="per"></div></section>
    <section class="card span-7"><header class="card-head"><div><h3>Pola lintas strategi</h3><div class="sub">semua bot digabung</div></div></header><div data-ref="cross"></div></section>
    <section class="card span-5"><header class="card-head"><h3>Stop loss terbaru</h3></header>
      <div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Pair</th><th>Side</th><th>Kondisi</th></tr></thead><tbody data-ref="recent"></tbody></table></div></section>
  </div>`;
  const ref = Object.fromEntries([...root.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));

  api('/api/lessons').then((d) => {
    ref.sub.textContent = `Dihitung dari ${d.sample} trade terakhir. Kondisi diberi label saat entry (sesi, rezim volatilitas, searah bias, confidence) sehingga tidak bocor dari hasil trade.`;
    const worst = [...d.cross.rows].sort((a, b) => b.slLift - a.slLift)[0];
    ref.headline.innerHTML = worst ? `
      <div class="verdict"><div class="verdict-score down">${fmtPct(worst.slRate, 0)}</div>
      <div><div class="eyebrow">Paling sering kena SL</div><h2>${worst.label}</h2>
      <div class="muted">SL rate ${fmtPct(worst.slRate, 0)} vs rata-rata ${fmtPct(d.cross.base.slRate, 0)} (${worst.slLift >= 0 ? '+' : ''}${(worst.slLift * 100).toFixed(0)}pp), ${fmtR(worst.delta)} per trade, n=${worst.n}. Sampel kecil bisa menipu, jadi pantau sebelum mengubah aturan.</div></div></div>` : 'Belum cukup data.';
    const scale = Math.max(0.1, ...d.perStrategy.flatMap((s) => s.rows.map((r) => Math.abs(r.delta))));
    ref.per.replaceChildren(...d.perStrategy.map((s) => h('div', { class: 'span-6 reveal' },
      h('h4', { style: `margin-bottom:10px;color:${s.color}`, html: `${s.name} <span class="dim small" style="font-weight:500">rata-rata ${fmtR(s.base.avgR, 3)} · n=${s.base.n}</span>` }),
      dbars(s.rows.slice(0, 5), scale))));
    ref.cross.replaceChildren(dbars(d.cross.rows, scale));
    ref.recent.replaceChildren(...d.lossesRecent.map((t) => h('tr', { html: `
      <td class="mono dim">${fmtDate(t.closedAt)} ${fmtTime(t.closedAt)}</td><td>${coin(t.pair)}</td><td>${sideTag(t.side)}</td>
      <td class="small">${[t.tags.session, `vol ${t.tags.volRegime}`, t.tags.aligned ? 'searah' : '<span class="down">melawan bias</span>'].join(' · ')}</td>` })));
    stagger(root);
  });
  return {};
}
