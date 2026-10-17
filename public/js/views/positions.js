import { h, tweenNumber, fmtUsd, fmtSignedUsd, fmtPx, fmtR, fmtDur, fmtPct, coin, sideTag, stagger } from '../util.js';
import { botAvatar } from '../pixel.js';

export function mount(root) {
  root.innerHTML = `
  <div class="page-head"><div><div class="eyebrow">Buku utama · paper</div><h1>Posisi live</h1>
    <p>Titik = harga terakhir, garis kuning = entry. Setengah posisi ditutup di TP1 lalu stop pindah ke breakeven. Posisi yang tidak kena target atau stop ditutup oleh time stop.</p></div></div>
  <div class="stat-cards">
    <div class="card stat"><small>Posisi terbuka</small><b data-ref="count">0</b><div class="sub" data-ref="countSub"></div></div>
    <div class="card stat"><small>Margin terpakai</small><b class="money" data-ref="margin">$0</b><div class="sub">leverage 10x</div></div>
    <div class="card stat"><small>PnL berjalan</small><b class="money" data-ref="upnl">$0</b><div class="sub" data-ref="upnlR"></div></div>
    <div class="card stat"><small>Eksposur long / short</small><b data-ref="expo">—</b><div class="sub" data-ref="expoSub"></div></div>
  </div>
  <section class="card" style="margin-top:16px">
    <header class="card-head"><h3>Posisi terbuka</h3><span class="sub">diperbarui tiap detik</span></header>
    <div class="table-wrap"><table>
      <thead><tr><th>Pair</th><th>Bot</th><th>Side</th><th class="num">Notional</th><th class="num">Entry</th><th class="num">Last</th><th>SL · Entry · TP1 · TP2</th><th class="num">PnL</th><th class="num">R</th><th class="num">P(win)</th><th class="num">Time stop</th></tr></thead>
      <tbody data-ref="rows"></tbody>
    </table></div>
    <div data-ref="empty"></div>
  </section>
  <section class="card" style="margin-top:16px">
    <header class="card-head"><h3>Order limit menunggu terisi</h3><span class="sub">kedaluwarsa 6 menit</span></header>
    <div class="table-wrap"><table>
      <thead><tr><th>Pair</th><th>Bot</th><th>Side</th><th class="num">Limit</th><th class="num">Last</th><th class="num">Jarak</th><th class="num">P(win)</th><th class="num">Sisa waktu</th></tr></thead>
      <tbody data-ref="pending"></tbody>
    </table></div>
    <div data-ref="emptyPending"></div>
  </section>`;
  const ref = Object.fromEntries([...root.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));
  stagger(root);
  const rows = new Map();

  function emptyState(el, show, text) {
    if (!show) { el.replaceChildren(); return; }
    if (el.firstChild) return;
    const cv = h('canvas', { class: 'pixel', width: 12, height: 11 });
    botAvatar(cv, '#5f6c9c');
    el.replaceChildren(h('div', { class: 'empty' }, cv, text));
  }

  function rangeBar(p) {
    const lo = Math.min(p.initialSl, p.tp2), hi = Math.max(p.initialSl, p.tp2);
    const pos = (x) => `${Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100))}%`;
    return { lo, hi, pos };
  }

  function buildRow(p) {
    const { pos } = rangeBar(p);
    const tr = h('tr', { class: 'new', html: `
      <td>${coin(p.pair)}</td><td class="muted">${p.botName}</td><td>${sideTag(p.side)}</td>
      <td class="num money" data-c="notional"></td><td class="num">${fmtPx(p.entry)}</td><td class="num" data-c="last"></td>
      <td><div class="range ${p.side === 'SHORT' ? 'short' : ''}">
        <div class="track"></div>
        <span class="mark sl" data-c="sl" style="left:${pos(p.sl)}"></span><label data-c="slLabel" style="left:${pos(p.sl)}">SL</label>
        <span class="mark entry" style="left:${pos(p.entry)}"></span>
        <span class="mark tp" style="left:${pos(p.tp1)}"></span><label style="left:${pos(p.tp1)}">TP1</label>
        <span class="mark tp" style="left:${pos(p.tp2)}"></span><label style="left:${pos(p.tp2)}">TP2</label>
        <span class="dot" data-c="dot" style="left:${pos(p.price)}"></span>
      </div></td>
      <td class="num money" data-c="upnl"></td><td class="num" data-c="r"></td><td class="num">${fmtPct(p.conf, 0)}</td><td class="num mono" data-c="time"></td>` });
    return tr;
  }

  function update(s) {
    const ps = s.positions;
    tweenNumber(ref.count, ps.length, (x) => Math.round(x));
    ref.countSub.textContent = `${ps.filter((p) => p.tp1Hit).length} sudah TP1 · ${s.pending.length} limit`;
    tweenNumber(ref.margin, ps.reduce((a, p) => a + p.margin, 0), fmtUsd, { flash: false });
    const upnl = ps.reduce((a, p) => a + p.upnl, 0);
    tweenNumber(ref.upnl, upnl, fmtSignedUsd);
    ref.upnl.className = `money ${upnl >= 0 ? 'up' : 'down'}`;
    ref.upnlR.textContent = `${fmtR(ps.reduce((a, p) => a + p.r, 0))} total`;
    const L = ps.filter((p) => p.side === 'LONG').reduce((a, p) => a + p.notional, 0);
    const S = ps.filter((p) => p.side === 'SHORT').reduce((a, p) => a + p.notional, 0);
    ref.expo.textContent = L + S ? `${Math.round((L / (L + S)) * 100)}% / ${Math.round((S / (L + S)) * 100)}%` : '—';
    ref.expoSub.textContent = 'buku utama mengikuti siklus tahun';

    const ids = new Set(ps.map((p) => p.id));
    for (const [id, tr] of rows) if (!ids.has(id)) { tr.remove(); rows.delete(id); }
    for (const p of ps) {
      let tr = rows.get(p.id);
      if (!tr) { tr = buildRow(p); rows.set(p.id, tr); ref.rows.prepend(tr); }
      const c = (k) => tr.querySelector(`[data-c="${k}"]`);
      const { pos } = rangeBar(p);
      c('dot').style.left = pos(p.price);
      c('sl').style.left = pos(p.sl);
      c('slLabel').style.left = pos(p.sl);
      c('slLabel').textContent = p.tp1Hit ? 'BE' : 'SL';
      tweenNumber(c('last'), p.price, fmtPx, { duration: 500 });
      tweenNumber(c('notional'), p.notional, fmtUsd, { flash: false });
      const u = c('upnl');
      tweenNumber(u, p.upnl, fmtSignedUsd);
      u.classList.toggle('up', p.upnl >= 0); u.classList.toggle('down', p.upnl < 0);
      const r = c('r');
      r.textContent = fmtR(p.r);
      r.className = `num ${p.r >= 0 ? 'up' : 'down'}`;
      c('time').textContent = fmtDur(p.timeLeft);
    }
    emptyState(ref.empty, !ps.length, 'Tidak ada posisi terbuka. Bot sedang memindai sinyal.');

    ref.pending.replaceChildren(...s.pending.map((o) => h('tr', { html: `
      <td>${coin(o.pair)}</td><td class="muted">${o.botName}</td><td>${sideTag(o.side)}</td>
      <td class="num">${fmtPx(o.limit)}</td><td class="num">${fmtPx(o.price)}</td>
      <td class="num">${fmtPct(Math.abs(o.distance), 2)}</td><td class="num">${fmtPct(o.conf, 0)}</td>
      <td class="num mono">${fmtDur(o.expiresAt - s.t)}</td>` })));
    emptyState(ref.emptyPending, !s.pending.length, 'Tidak ada order limit menunggu.');
  }
  return { update };
}
