import { h, prefs } from './util.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function niceStep(range, ticks) {
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function resample(arr, n) {
  if (!arr.length) return Array(n).fill(0);
  if (arr.length === n) return arr.slice();
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / Math.max(1, n - 1)) * (arr.length - 1);
    const lo = Math.floor(x), hi = Math.min(arr.length - 1, lo + 1);
    out[i] = arr[lo] + (arr[hi] - arr[lo]) * (x - lo);
  }
  return out;
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Smoothly morphing line chart. Every frame the displayed values ease toward
// their targets, so range switches, live ticks and domain changes all animate.
export class LineChart {
  constructor(host, opts = {}) {
    this.host = host;
    this.o = { pad: { l: 56, r: 18, t: 14, b: 30 }, yTicks: 5, xTicks: 6, yFormat: (v) => v.toFixed(0), xFormat: (v) => String(v), tipFormat: null, ...opts };
    this.canvas = h('canvas');
    this.tip = h('div', { class: 'chart-tip', hidden: true });
    host.classList.add('chart-host');
    host.append(this.canvas, this.tip);
    this.ctx = this.canvas.getContext('2d');
    this.x = [];
    this.series = [];
    this.bands = [];
    this.dom = null;
    this.reveal = 0;
    this.hover = null;
    this.ro = new ResizeObserver(() => this.#resize());
    this.ro.observe(host);
    this.canvas.addEventListener('mousemove', (e) => this.#onMove(e));
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.tip.hidden = true; });
    this.#resize();
    this._frame = () => this.#loop();
    requestAnimationFrame(this._frame);
  }

  #resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(50, r.width);
    this.h = Math.max(50, r.height);
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // data: { x: [], series: [{ key, values, color, fill, width, dash, live, label }], bands: [{ lo, hi, color }] }
  setData(data) {
    const n = data.x.length;
    this.x = data.x;
    const prev = Object.fromEntries(this.series.map((s) => [s.key, s]));
    this.series = data.series.map((s) => {
      const old = prev[s.key];
      const cur = old ? resample(old.cur, n) : resample(s.values, n).map((v) => v);
      return { ...s, to: s.values.slice(), cur };
    });
    this.bands = (data.bands || []).map((b, i) => {
      const old = this.bandsPrev?.[i];
      return { ...b, curLo: old ? resample(old.curLo, n) : b.lo.slice(), curHi: old ? resample(old.curHi, n) : b.hi.slice() };
    });
    this.bandsPrev = this.bands;
    if (prefs.reduceMotion) { this.reveal = 1; for (const s of this.series) s.cur = s.to.slice(); }
  }

  setLast(key, value, xValue) {
    const s = this.series.find((q) => q.key === key);
    if (!s || !s.to.length) return;
    if (xValue != null && xValue !== this.x[this.x.length - 1]) {
      this.x = [...this.x.slice(1), xValue];
      for (const q of this.series) {
        const last = q.key === key ? value : q.nextFn ? q.nextFn(xValue) : q.to[q.to.length - 1];
        q.to = [...q.to.slice(1), last];
        q.cur = [...q.cur.slice(1), q.cur[q.cur.length - 1]];
      }
      return;
    }
    s.to[s.to.length - 1] = value;
  }

  #domain() {
    let min = Infinity, max = -Infinity;
    for (const s of this.series) for (const v of s.to) { if (v < min) min = v; if (v > max) max = v; }
    for (const b of this.bands) { for (const v of b.lo) min = Math.min(min, v); for (const v of b.hi) max = Math.max(max, v); }
    if (!isFinite(min)) return { min: 0, max: 1 };
    if (this.o.includeZero) { min = Math.min(min, 0); max = Math.max(max, 0); }
    const pad = (max - min) * 0.08 || Math.abs(max) * 0.01 || 1;
    return { min: min - pad, max: max + pad };
  }

  #onMove(e) {
    const r = this.canvas.getBoundingClientRect();
    this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #loop() {
    if (!this.host.isConnected) { this.ro.disconnect(); return; }
    const k = prefs.reduceMotion ? 1 : 0.14;
    for (const s of this.series) for (let i = 0; i < s.cur.length; i++) s.cur[i] += (s.to[i] - s.cur[i]) * k;
    for (const b of this.bands) for (let i = 0; i < b.curLo.length; i++) { b.curLo[i] += (b.lo[i] - b.curLo[i]) * k; b.curHi[i] += (b.hi[i] - b.curHi[i]) * k; }
    const target = this.#domain();
    if (!this.dom) this.dom = { ...target };
    this.dom.min += (target.min - this.dom.min) * k;
    this.dom.max += (target.max - this.dom.max) * k;
    this.reveal = Math.min(1, this.reveal + (prefs.reduceMotion ? 1 : 0.025));
    this.#draw();
    requestAnimationFrame(this._frame);
  }

  #draw() {
    const { ctx, w, h: H } = this;
    const { pad } = this.o;
    ctx.clearRect(0, 0, w, H);
    const n = this.x.length;
    if (n < 2) return;
    const iw = w - pad.l - pad.r, ih = H - pad.t - pad.b;
    const { min, max } = this.dom;
    const X = (i) => pad.l + (i / (n - 1)) * iw;
    const Y = (v) => pad.t + (1 - (v - min) / (max - min || 1)) * ih;
    const grid = css('--grid') || 'rgba(90,200,140,.12)';
    const label = css('--dim') || '#5d6a99';

    // grid + y labels
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = label;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const step = niceStep(max - min, this.o.yTicks);
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillText(this.o.yFormat(v), pad.l - 8, y);
    }
    ctx.setLineDash([]);
    if (this.o.zeroLine && min < 0 && max > 0) {
      ctx.strokeStyle = 'rgba(190,255,215,.25)';
      ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(w - pad.r, Y(0)); ctx.stroke();
    }
    // x labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xt = Math.min(this.o.xTicks, n);
    for (let j = 0; j < xt; j++) {
      const i = Math.round((j / (xt - 1)) * (n - 1));
      ctx.fillText(this.o.xFormat(this.x[i]), Math.min(w - pad.r - 18, Math.max(pad.l + 18, X(i))), H - pad.b + 10);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, 0, iw * this.#ease(this.reveal) + 1, H);
    ctx.clip();

    for (const b of this.bands) {
      ctx.beginPath();
      b.curHi.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(i), Y(b.curLo[i]));
      ctx.closePath();
      ctx.fillStyle = b.color;
      ctx.fill();
    }

    for (const s of this.series) {
      const pts = s.cur;
      if (s.fill) {
        const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
        g.addColorStop(0, hexA(s.color, 0.28));
        g.addColorStop(1, hexA(s.color, 0));
        ctx.beginPath();
        pts.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
        ctx.lineTo(X(n - 1), pad.t + ih);
        ctx.lineTo(X(0), pad.t + ih);
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.beginPath();
      pts.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 2;
      ctx.setLineDash(s.dash || []);
      if (s.glow) { ctx.shadowColor = s.color; ctx.shadowBlur = 10; }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);
    }
    ctx.restore();

    // live pulse on last point
    if (this.reveal >= 1) {
      for (const s of this.series.filter((q) => q.live)) {
        const x = X(n - 1), y = Y(s.cur[n - 1]);
        const t = (performance.now() % 1600) / 1600;
        ctx.beginPath(); ctx.arc(x, y, 4 + t * 10, 0, Math.PI * 2);
        ctx.fillStyle = hexA(s.color, 0.35 * (1 - t)); ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = s.color; ctx.fill();
        ctx.strokeStyle = '#04100a'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }

    // hover crosshair
    if (this.hover && this.hover.x >= pad.l && this.hover.x <= w - pad.r) {
      const i = Math.round(((this.hover.x - pad.l) / iw) * (n - 1));
      const x = X(i);
      ctx.strokeStyle = 'rgba(190,255,215,.35)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ih); ctx.stroke();
      ctx.setLineDash([]);
      const rows = [];
      for (const s of this.series) {
        const v = s.to[i];
        ctx.beginPath(); ctx.arc(x, Y(s.cur[i]), 4, 0, Math.PI * 2);
        ctx.fillStyle = s.color; ctx.fill();
        if (s.label) rows.push(`<div><i style="background:${s.color}"></i>${s.label}<b>${(this.o.tipFormat || this.o.yFormat)(v)}</b></div>`);
      }
      for (const b of this.bands) if (b.label) rows.push(`<div><i style="background:${b.swatch || b.color}"></i>${b.label}<b>${(this.o.tipFormat || this.o.yFormat)(b.lo[i])} – ${(this.o.tipFormat || this.o.yFormat)(b.hi[i])}</b></div>`);
      this.tip.innerHTML = `<span>${(this.o.tipX || this.o.xFormat)(this.x[i])}</span>${rows.join('')}`;
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = `${x + 14 + tw > w ? x - tw - 14 : x + 14}px`;
      this.tip.style.top = `${Math.max(4, this.hover.y - 30)}px`;
    }
  }

  #ease(t) { return 1 - Math.pow(1 - t, 3); }
}

// SVG donut with animated arcs.
export class Donut {
  constructor(host, { size = 156, stroke = 16 } = {}) {
    this.r = (size - stroke) / 2;
    this.c = 2 * Math.PI * this.r;
    const ns = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(ns, 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    this.svg.classList.add('donut');
    const track = document.createElementNS(ns, 'circle');
    Object.entries({ cx: size / 2, cy: size / 2, r: this.r, fill: 'none', stroke: 'rgba(90,200,140,.12)', 'stroke-width': stroke }).forEach(([k, v]) => track.setAttribute(k, v));
    this.svg.append(track);
    this.g = document.createElementNS(ns, 'g');
    this.g.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
    this.svg.append(this.g);
    this.size = size; this.stroke = stroke; this.ns = ns;
    this.arcs = [];
    host.append(this.svg);
  }

  set(items) {
    while (this.arcs.length < items.length) {
      const a = document.createElementNS(this.ns, 'circle');
      Object.entries({ cx: this.size / 2, cy: this.size / 2, r: this.r, fill: 'none', 'stroke-width': this.stroke, 'stroke-dasharray': `0 ${this.c}`, 'stroke-linecap': 'butt' }).forEach(([k, v]) => a.setAttribute(k, v));
      a.classList.add('arc');
      this.g.append(a);
      this.arcs.push(a);
    }
    let off = 0;
    const gap = 2;
    const plan = this.arcs.map((a, i) => {
      const it = items[i];
      if (!it) return { a, dash: `0 ${this.c}`, offset: -off };
      const len = Math.max(0, it.pct * this.c - gap);
      a.setAttribute('stroke', it.color);
      const p = { a, dash: `${len} ${this.c - len}`, offset: -off };
      off += it.pct * this.c;
      return p;
    });
    // next frame so the CSS transition runs from the previous (or empty) state
    requestAnimationFrame(() => plan.forEach(({ a, dash, offset }) => {
      a.setAttribute('stroke-dasharray', dash);
      a.setAttribute('stroke-dashoffset', offset);
    }));
  }
}

export function sparkline(canvas, values, color, { fill = true, width = 1.6 } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width, hgt = canvas.clientHeight || canvas.height;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = hgt * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  if (!values || values.length < 2) return;
  let min = Math.min(...values), max = Math.max(...values);
  if (max === min) { max += 1; min -= 1; }
  const X = (i) => (i / (values.length - 1)) * (w - 4) + 2;
  const Y = (v) => 3 + (1 - (v - min) / (max - min)) * (hgt - 6);
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.stroke();
  if (fill) {
    ctx.lineTo(X(values.length - 1), hgt);
    ctx.lineTo(X(0), hgt);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, hgt);
    g.addColorStop(0, hexA(color, 0.3));
    g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(X(values.length - 1), Y(values[values.length - 1]), 2.2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

export { hexA };

// Candlestick chart with volume, price levels, live last-price line and OHLC hover.
export class CandleChart {
  constructor(host, opts = {}) {
    this.host = host;
    this.o = { pad: { l: 12, r: 72, t: 12, b: 26 }, priceFormat: (v) => v.toFixed(2), timeFormat: (t) => String(t), ...opts };
    this.canvas = h('canvas');
    this.tip = h('div', { class: 'chart-tip', hidden: true });
    host.classList.add('chart-host');
    host.append(this.canvas, this.tip);
    this.ctx = this.canvas.getContext('2d');
    this.bars = [];
    this.levels = [];
    this.dom = null;
    this.reveal = 1;
    this.ro = new ResizeObserver(() => this.#resize());
    this.ro.observe(host);
    this.canvas.addEventListener('mousemove', (e) => { const r = this.canvas.getBoundingClientRect(); this.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; });
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.tip.hidden = true; });
    this.#resize();
    this._frame = () => this.#loop();
    requestAnimationFrame(this._frame);
  }

  #resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(50, r.width); this.h = Math.max(50, r.height);
    this.canvas.width = this.w * dpr; this.canvas.height = this.h * dpr;
    this.canvas.style.width = `${this.w}px`; this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setBars(bars, { fresh = false } = {}) {
    this.bars = bars;
    if (fresh && !prefs.reduceMotion) this.reveal = 0;
  }

  setLevels(levels) { this.levels = levels; }

  #loop() {
    if (!this.host.isConnected) { this.ro.disconnect(); return; }
    if (this.bars.length) {
      let min = Infinity, max = -Infinity;
      for (const b of this.bars) { min = Math.min(min, b.l); max = Math.max(max, b.h); }
      for (const l of this.levels) { min = Math.min(min, l.price); max = Math.max(max, l.price); }
      const pad = (max - min) * 0.06 || max * 0.001;
      const t = { min: min - pad, max: max + pad };
      const k = prefs.reduceMotion || !this.dom ? 1 : 0.15;
      this.dom = this.dom || { ...t };
      this.dom.min += (t.min - this.dom.min) * k;
      this.dom.max += (t.max - this.dom.max) * k;
      this.reveal = Math.min(1, this.reveal + 0.04);
      this.#draw();
    }
    requestAnimationFrame(this._frame);
  }

  #draw() {
    const { ctx, w, h: H, bars } = this;
    const { pad } = this.o;
    ctx.clearRect(0, 0, w, H);
    const n = bars.length, iw = w - pad.l - pad.r, ih = H - pad.t - pad.b;
    const volH = ih * 0.16;
    const { min, max } = this.dom;
    const slot = iw / n;
    const X = (i) => pad.l + slot * (i + 0.5);
    const Y = (v) => pad.t + (1 - (v - min) / (max - min || 1)) * ih;
    const dim = css('--dim') || '#52806a';
    const up = css('--green') || '#39ff88', down = css('--red') || '#ff3d6e';

    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = dim; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.strokeStyle = css('--grid') || 'rgba(90,200,140,.12)';
    ctx.setLineDash([2, 4]);
    const step = niceStep(max - min, 5);
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillText(this.o.priceFormat(v), w - pad.r + 8, y);
    }
    ctx.setLineDash([]);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let j = 0; j < 6; j++) {
      const i = Math.round((j / 5) * (n - 1));
      ctx.fillText(this.o.timeFormat(bars[i].t), Math.min(w - pad.r - 24, Math.max(pad.l + 24, X(i))), H - pad.b + 8);
    }

    const shown = Math.max(1, Math.ceil(n * (1 - Math.pow(1 - this.reveal, 3))));
    const vmax = Math.max(...bars.map((b) => b.v || 0)) || 1;
    const bw = Math.max(1, slot * 0.62);
    for (let i = 0; i < shown; i++) {
      const b = bars[i], x = X(i), col = b.c >= b.o ? up : down;
      ctx.fillStyle = hexA(col, 0.16);
      const vh = ((b.v || 0) / vmax) * volH;
      ctx.fillRect(x - bw / 2, pad.t + ih - vh, bw, vh);
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, Y(b.h)); ctx.lineTo(Math.round(x) + 0.5, Y(b.l)); ctx.stroke();
      const top = Y(Math.max(b.o, b.c)), bot = Y(Math.min(b.o, b.c));
      ctx.fillStyle = col;
      ctx.fillRect(x - bw / 2, top, bw, Math.max(1, bot - top));
    }

    for (const l of this.levels) {
      const y = Math.round(Y(l.price)) + 0.5;
      ctx.strokeStyle = l.color; ctx.setLineDash(l.dash || [4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = l.color; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(l.label, pad.l + 4, y - 2);
    }

    if (shown === n) {
      const last = bars[n - 1], y = Y(last.c), col = last.c >= last.o ? up : down;
      ctx.strokeStyle = col; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.fillRect(w - pad.r + 2, y - 9, pad.r - 4, 18);
      ctx.fillStyle = '#021007'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(this.o.priceFormat(last.c), w - pad.r + 6, y);
      const t = (performance.now() % 1600) / 1600;
      ctx.beginPath(); ctx.arc(X(n - 1), y, 3 + t * 9, 0, Math.PI * 2);
      ctx.fillStyle = hexA(col, 0.35 * (1 - t)); ctx.fill();
    }

    if (this.hover && this.hover.x >= pad.l && this.hover.x <= w - pad.r) {
      const i = Math.max(0, Math.min(n - 1, Math.floor((this.hover.x - pad.l) / slot)));
      const b = bars[i];
      ctx.strokeStyle = 'rgba(190,255,215,.35)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(i), pad.t); ctx.lineTo(X(i), pad.t + ih); ctx.stroke(); ctx.setLineDash([]);
      const f = this.o.priceFormat;
      this.tip.innerHTML = `<span>${this.o.tipTime ? this.o.tipTime(b.t) : this.o.timeFormat(b.t)}</span>
        <div>Open<b>${f(b.o)}</b></div><div>High<b>${f(b.h)}</b></div><div>Low<b>${f(b.l)}</b></div>
        <div>Close<b class="${b.c >= b.o ? 'up' : 'down'}">${f(b.c)}</b></div>`;
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth, x = X(i);
      this.tip.style.left = `${x + 14 + tw > w ? x - tw - 14 : x + 14}px`;
      this.tip.style.top = `${Math.max(4, this.hover.y - 40)}px`;
    }
  }
}
