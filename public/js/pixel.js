// Procedural pixel-art scenes drawn on low-resolution canvases.
import { prefs } from './util.js';

const SPR = {
  robot: [
    '.....kk.....',
    '....kyyk....',
    '..kkkkkkkk..',
    '.kcccccccck.',
    'kccwwccwwcck',
    'kccwkccwkcck',
    'kcccccccccck',
    'kccckkkkccck',
    '.kcccccccck.',
    '..kkkkkkkk..',
  ],
  cat: [
    '.k........k.',
    'kok......kok',
    'kookkkkkkook',
    'kooooooooook',
    'kookooookook',
    'kwwwoppowwwk',
    '.kwwwwwwwwk.',
    '..kkkkkkkk..',
    '.koowwwwook.',
    '.koowwwwook.',
    '.kooooooook.',
    '.kkkkkkkkkk.',
  ],
  // green alien head: big slanted black eyes with a white glint
  alien: [
    '....kkkkk....',
    '..kkllllgkk..',
    '.kllllllllgk.',
    'kllllllllllgk',
    'klllllllllggk',
    'keeeellleeeek',
    'keweellleewek',
    'kgeeellleeegk',
    '.kgelllllegk.',
    '.kglllllllgk.',
    '..kglllllgk..',
    '..kglkkklgk..',
    '...kglllgk...',
    '....kgggk....',
    '.....kkk.....',
  ],
  // tiny full-body alien for the street, two walking frames
  walkerA: [
    '..kkk..',
    '.klllk.',
    'klllllk',
    'keeleek',
    'klllllk',
    '.klllk.',
    '..kgk..',
    '.kgggk.',
    'kgggggk',
    '.kgggk.',
    '.k...k.',
    'kk...kk',
  ],
  walkerB: [
    '..kkk..',
    '.klllk.',
    'klllllk',
    'keeleek',
    'klllllk',
    '.klllk.',
    '..kgk..',
    '.kgggk.',
    'kgggggk',
    '.kgggk.',
    '..k.k..',
    '.kk.kk.',
  ],
  alienBlink: [
    '....kkkkk....',
    '..kkllllgkk..',
    '.kllllllllgk.',
    'kllllllllllgk',
    'klllllllllggk',
    'kllllllllllgk',
    'keeeellleeeek',
    'kgllllllllggk',
    '.kglllllllgk.',
    '.kglllllllgk.',
    '..kglllllgk..',
    '..kglkkklgk..',
    '...kglllgk...',
    '....kgggk....',
    '.....kkk.....',
  ],
};

const BASE_PAL = {
  k: '#021007', w: '#eafff2', o: '#f5a04a', p: '#ff8fb1', y: '#ffd36b', c: '#22f0ff',
  // alien skin: light, mid edge, eye
  l: '#5fd34a', g: '#2c9a39', e: '#020a04',
};
const NEON = { green: '#39ff88', cyan: '#22f0ff', magenta: '#ff2bd6' };

export function drawSprite(ctx, rows, x, y, pal = {}, s = 1) {
  const P = { ...BASE_PAL, ...pal };
  for (let j = 0; j < rows.length; j++) {
    const row = rows[j];
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '.') continue;
      ctx.fillStyle = typeof P[ch] === 'function' ? P[ch](i, j) : P[ch];
      ctx.fillRect(Math.round(x + i * s), Math.round(y + j * s), s, s);
    }
  }
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

function lerpColor(a, b, t) {
  const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((A >> s) & 255) + ((((B >> s) & 255) - ((A >> s) & 255)) * t));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Fill a vertical gradient as stepped bands with a dithered seam between bands.
function bandedSky(ctx, w, y0, y1, stops) {
  const bands = stops.length - 1;
  const hgt = y1 - y0;
  for (let y = y0; y < y1; y++) {
    const t = ((y - y0) / hgt) * bands;
    const i = Math.min(bands - 1, Math.floor(t));
    const f = t - i;
    const quant = Math.floor(f * 4) / 4;
    ctx.fillStyle = lerpColor(stops[i], stops[i + 1], quant);
    ctx.fillRect(0, y, w, 1);
    if (f * 4 - Math.floor(f * 4) > 0.75) {
      ctx.fillStyle = lerpColor(stops[i], stops[i + 1], Math.min(1, quant + 0.25));
      for (let x = (y % 2); x < w; x += 2) ctx.fillRect(x, y, 1, 1);
    }
  }
}

// Runs a pixel scene at a low frame rate until the canvas leaves the DOM.
export function runScene(canvas, draw, fps = 12) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  let last = 0;
  const start = performance.now();
  const loop = (now) => {
    if (!canvas.isConnected) return;
    if (now - last >= 1000 / fps) {
      last = now;
      draw(ctx, prefs.reduceMotion ? 0 : (now - start) / 1000);
    }
    if (!prefs.reduceMotion) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

export function botAvatar(canvas, color) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawSprite(ctx, SPR.robot, 0, 1, { c: color, y: shade(color, 1.3) }, 1);
}

// Brand mark: the alien, with a scanning glint and the odd blink.
export function brandLogo(canvas) {
  runScene(canvas, (ctx, t) => {
    ctx.clearRect(0, 0, 16, 16);
    const blink = Math.floor(t * 10) % 50 === 0;
    const sweep = ((t * 8) % 34) - 9;
    drawSprite(ctx, blink ? SPR.alienBlink : SPR.alien, 1.5, 0.5, {
      l: (i, j) => (Math.abs(i + j - sweep) < 1.1 ? '#c8ffd8' : BASE_PAL.l),
    });
  }, 10);
}

// A small saucer with an alien pilot under the glass dome.
function drawUfo(ctx, x, y, t) {
  const glass = 'rgba(34,240,255,.35)';
  ctx.fillStyle = glass;
  ctx.fillRect(x + 7, y, 6, 1); ctx.fillRect(x + 6, y + 1, 8, 1); ctx.fillRect(x + 5, y + 2, 10, 2);
  ctx.fillStyle = BASE_PAL.l; ctx.fillRect(x + 8, y + 1, 4, 2);
  ctx.fillStyle = BASE_PAL.e; ctx.fillRect(x + 8, y + 2, 1, 1); ctx.fillRect(x + 11, y + 2, 1, 1);
  ctx.fillStyle = '#5f8f75'; ctx.fillRect(x + 1, y + 4, 18, 1);
  ctx.fillStyle = '#2f5442'; ctx.fillRect(x, y + 5, 20, 1); ctx.fillRect(x + 2, y + 6, 16, 1);
  const lights = [NEON.green, NEON.magenta, NEON.cyan];
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = lights[(i + Math.floor(t * 6)) % 3];
    ctx.fillRect(x + 2 + i * 3, y + 5, 1, 1);
  }
  ctx.fillStyle = NEON.green; ctx.fillRect(x + 7, y + 7, 6, 1);
  if (Math.floor(t * 3) % 4) {
    for (let k = 1; k < 9; k++) {
      ctx.fillStyle = `rgba(57,255,136,${0.22 - k * 0.022})`;
      ctx.fillRect(x + 8 - k * 0.6, y + 7 + k, 4 + k * 1.2, 1);
    }
  }
}

// Draws a 1px-wide line with integer steps so it stays crisp when the canvas is scaled up.
function pixLine(ctx, x0, y0, x1, y1) {
  const steps = Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let k = 0; k <= steps; k++) ctx.fillRect(Math.round(x0 + ((x1 - x0) * k) / steps), Math.round(y0 + ((y1 - y0) * k) / steps), 1, 1);
}

// Tron-style night flight: a neon city scrolls past on a perspective light grid while
// the saucer overtakes it, leaving a light trail; the little alien still walks the grid.
export function heroScene(canvas) {
  const W = canvas.width, H = canvas.height;
  const HZ = Math.round(H * 0.6); // horizon
  const rnd = seeded(77);
  const stars = Array.from({ length: 55 }, () => ({ x: Math.floor(rnd() * W), y: Math.floor(rnd() * HZ * 0.8), p: rnd() * 6.28, s: 0.6 + rnd() * 2 }));
  // two looping skyline strips, each wider than the canvas so the wrap is never visible
  const strip = (len, minW, maxW, minH, maxH, gap) => {
    const out = [];
    for (let x = 0; x < len;) {
      const w = minW + Math.floor(rnd() * (maxW - minW));
      if (x + w > len) break;
      out.push({ x, w, h: minH + Math.floor(rnd() * (maxH - minH)), seed: Math.floor(rnd() * 1e6), edge: rnd() < 0.3 ? NEON.magenta : rnd() < 0.5 ? NEON.cyan : NEON.green });
      x += w + gap + Math.floor(rnd() * 3);
    }
    return out;
  };
  const FAR_LEN = W * 2, NEAR_LEN = W * 2;
  const far = strip(FAR_LEN, 8, 20, 10, 30, 1);
  const near = strip(NEAR_LEN, 12, 26, 16, 44, 5);
  const FLIGHT = 11; // seconds for one pass of the saucer

  const ufoAt = (t) => {
    const p = (((t + FLIGHT * 0.6) % FLIGHT) + FLIGHT) % FLIGHT / FLIGHT;
    return { x: -50 + p * (W + 90), y: 16 + Math.sin(p * Math.PI * 3) * 8 + Math.sin(t * 2.1) * 2, p };
  };

  function drawLayer(ctx, layer, len, off, base, far) {
    for (const b of layer) {
      let x = Math.round(((b.x - off) % len + len) % len);
      if (x > W) x -= len;
      if (x + b.w < 0 || x > W) continue;
      const top = base - b.h;
      ctx.fillStyle = far ? '#03140b' : '#010805';
      ctx.fillRect(x, top, b.w, b.h);
      // light edges: roof and both sides, dimmer on the far layer
      ctx.fillStyle = far ? 'rgba(34,240,255,.28)' : b.edge;
      ctx.fillRect(x, top, b.w, 1);
      if (!far) {
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x, top, 1, b.h); ctx.fillRect(x + b.w - 1, top, 1, b.h);
        ctx.globalAlpha = 0.18;
        ctx.fillRect(x - 1, top - 1, b.w + 2, 1);
        ctx.globalAlpha = 1;
      }
      // window strips
      for (let y = top + 3; y < base - 2; y += far ? 4 : 3) {
        const hsh = (y * 19349663) ^ b.seed;
        if ((hsh & 3) === 0) continue;
        ctx.fillStyle = far ? 'rgba(57,255,136,.16)' : (hsh & 12) === 12 ? 'rgba(255,43,214,.7)' : (hsh & 4) ? 'rgba(57,255,136,.75)' : 'rgba(34,240,255,.7)';
        const wx = x + 2 + ((hsh >> 3) & 1), ww = b.w - 4 - ((hsh >> 5) & 3);
        if (ww > 0) ctx.fillRect(wx, y, far ? 1 : ww, 1);
        if (far) for (let k = wx + 3; k < x + b.w - 2; k += 3) ctx.fillRect(k, y, 1, 1);
      }
      // antenna beacon on tall towers
      if (!far && b.h > 36) {
        ctx.fillStyle = 'rgba(255,43,214,.5)'; ctx.fillRect(x + (b.w >> 1), top - 4, 1, 4);
        if (Math.sin(performance.now() / 300 + b.seed) > 0) { ctx.fillStyle = NEON.magenta; ctx.fillRect(x + (b.w >> 1), top - 5, 1, 1); }
      }
    }
  }

  runScene(canvas, (ctx, t) => {
    bandedSky(ctx, W, 0, HZ, ['#010503', '#02100a', '#041d10', '#08301a', '#0d4524']);
    for (const s of stars) {
      const a = 0.5 + 0.5 * Math.sin(t * s.s + s.p);
      if (a < 0.4) continue;
      ctx.fillStyle = a > 0.85 ? '#eafff2' : '#5fae80';
      ctx.fillRect((s.x - Math.floor(t * 2) + W * 8) % W, s.y, 1, 1);
    }
    // holographic moon with scan gaps
    const mx = W - 46, my = 17;
    ctx.fillStyle = 'rgba(57,255,136,.08)';
    for (let r = 13; r > 8; r -= 2) { ctx.beginPath(); ctx.arc(mx, my, r, 0, 7); ctx.fill(); }
    for (let y = -7; y <= 7; y++) {
      if ((y + Math.floor(t * 4)) % 3 === 0) continue;
      const hw = Math.floor(Math.sqrt(49 - y * y));
      ctx.fillStyle = y < 0 ? '#c8ffdc' : '#8bf5b4';
      ctx.fillRect(mx - hw, my + y, hw * 2, 1);
    }
    // grid floor
    ctx.fillStyle = '#010604';
    ctx.fillRect(0, HZ, W, H - HZ);
    ctx.fillStyle = 'rgba(34,240,255,.5)';
    ctx.fillRect(0, HZ, W, 1);
    ctx.fillStyle = 'rgba(34,240,255,.12)';
    ctx.fillRect(0, HZ - 1, W, 1); ctx.fillRect(0, HZ + 1, W, 1);
    const vx = W / 2, run = (t * 1.6) % 1;
    for (let i = 1; i < 14; i++) {
      const z = i - run;
      const y = Math.round(HZ + 30 / z);
      if (y >= H || y <= HZ) continue;
      ctx.fillStyle = `rgba(57,255,136,${Math.min(0.75, 0.08 + (y - HZ) / (H - HZ) * 0.7)})`;
      ctx.fillRect(0, y, W, 1);
    }
    ctx.fillStyle = 'rgba(57,255,136,.4)';
    for (let j = -14; j <= 14; j++) pixLine(ctx, vx + j * 4, HZ + 1, vx + j * 40, H);
    // two light cycles racing along the grid
    for (const [lane, sp, col] of [[HZ + 9, 70, NEON.cyan], [HZ + 25, -95, NEON.magenta]]) {
      const hx = ((t * sp) % (W + 80) + W + 80) % (W + 80) - 40;
      const dir = Math.sign(sp);
      ctx.fillStyle = col; ctx.fillRect(Math.round(hx), lane, 3, 1);
      for (let k = 1; k < 26; k++) {
        ctx.globalAlpha = 0.6 * (1 - k / 26);
        ctx.fillRect(Math.round(hx - dir * k * 2), lane, 2, 1);
      }
      ctx.globalAlpha = 1;
    }
    // parallax skyline: far strip slow, near strip faster
    drawLayer(ctx, far, FAR_LEN, t * 6, HZ, true);
    drawLayer(ctx, near, NEAR_LEN, t * 16, HZ + 6, false);
    // the alien strolling along the front of the grid
    const span = W - 30;
    const pos = (t * 9) % (span * 2);
    const wx = Math.round(10 + (pos < span ? pos : span * 2 - pos));
    const hop = Math.floor(t * 5) % 2;
    ctx.fillStyle = 'rgba(57,255,136,.14)';
    ctx.fillRect(wx - 2, H - 15, 11, 15);
    drawSprite(ctx, hop ? SPR.walkerA : SPR.walkerB, wx, H - 12 - (hop ? 1 : 0), { g: '#1f6e2c' });
    // UFO overtaking the city, with a fading light trail behind it
    const u = ufoAt(t);
    for (let k = 14; k >= 1; k--) {
      const q = ufoAt(t - k * 0.06);
      if (q.p > u.p) continue; // don't draw a trail across the wrap
      ctx.fillStyle = `rgba(34,240,255,${0.5 * (1 - k / 14)})`;
      ctx.fillRect(Math.round(q.x + 2), Math.round(q.y + 10), 4, 2);
    }
    ctx.save();
    ctx.translate(Math.round(u.x), Math.round(u.y));
    ctx.scale(2, 2);
    drawUfo(ctx, 0, 0, t);
    ctx.restore();
  }, 30);
}

// Promo card: synthwave horizon in green with a neon grid floor and the alien fishing on a pier.
export function sunsetScene(canvas) {
  const W = canvas.width, H = canvas.height, hz = Math.round(H * 0.6);
  runScene(canvas, (ctx, t) => {
    bandedSky(ctx, W, 0, hz, ['#010604', '#042214', '#0b4a27', '#18843f', '#7dffb4']);
    const sx = Math.round(W * 0.42), r = 17;
    for (let y = -r; y <= 0; y++) {
      if ([-3, -6, -8, -11].includes(y)) continue;
      const hw = Math.floor(Math.sqrt(r * r - y * y));
      ctx.fillStyle = lerpColor('#eafff2', '#39ff88', (y + r) / r);
      ctx.fillRect(sx - hw, hz + y, hw * 2, 1);
    }
    ctx.fillStyle = '#020c06';
    ctx.fillRect(0, hz, W, H - hz);
    // perspective grid scrolling toward the viewer
    ctx.fillStyle = 'rgba(57,255,136,.55)';
    for (let k = 0; k < 9; k++) {
      const f = ((k + (t * 0.8) % 1) / 9) ** 2;
      ctx.fillRect(0, Math.round(hz + 1 + f * (H - hz)), W, 1);
    }
    ctx.fillStyle = 'rgba(57,255,136,.35)';
    for (let i = -10; i <= 10; i++) {
      for (let y = hz + 1; y < H; y++) {
        const x = Math.round(sx + i * 3 + (i * 14 * (y - hz)) / (H - hz));
        if (x >= 0 && x < W) ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.fillStyle = NEON.green;
    ctx.fillRect(0, hz, W, 1);
    // pier, fishing alien and the cat
    const pierX = Math.round(W * 0.66);
    ctx.fillStyle = '#010603';
    ctx.fillRect(pierX, hz + 4, W - pierX, 3);
    for (let x = pierX + 3; x < W; x += 9) ctx.fillRect(x, hz + 7, 2, H - hz - 7);
    const ax = pierX + 7, ay = hz - 11;
    drawSprite(ctx, SPR.alien, ax, ay, {}, 1);
    drawSprite(ctx, SPR.cat, ax + 15, hz - 8, {}, 1);
    ctx.fillStyle = '#c8ffdc';
    const tipX = ax - 13, tipY = ay - 6;
    for (let i = 0; i <= 13; i++) ctx.fillRect(ax + 1 - i, ay + 7 - Math.round(i * 1.0), 1, 1);
    const bob = Math.round(Math.sin(t * 2.5) * 1.2);
    ctx.fillStyle = 'rgba(200,255,220,.55)';
    for (let y = tipY; y < hz + 10 + bob; y += 2) ctx.fillRect(tipX, y, 1, 1);
    ctx.fillStyle = NEON.magenta; ctx.fillRect(tipX - 1, hz + 10 + bob, 3, 2);
  }, 10);
}

export function mascotScene(canvas) {
  const W = canvas.width, H = canvas.height;
  const rnd = seeded(9);
  const winStars = Array.from({ length: 10 }, () => ({ x: 10 + Math.floor(rnd() * 40), y: 9 + Math.floor(rnd() * 12), p: rnd() * 6 }));
  const bars = Array.from({ length: 9 }, () => 1 + Math.floor(rnd() * 6));
  runScene(canvas, (ctx, t) => {
    ctx.fillStyle = '#030a06'; ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * 0.72, 12, 2, W * 0.72, 12, 60);
    g.addColorStop(0, 'rgba(57,255,136,.16)'); g.addColorStop(1, 'rgba(57,255,136,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // window onto the neon city
    ctx.fillStyle = '#0c2a18'; ctx.fillRect(7, 7, 46, 34);
    ctx.fillStyle = '#04140b'; ctx.fillRect(9, 9, 42, 30);
    for (const s of winStars) if (Math.sin(t * 2 + s.p) > -0.2) { ctx.fillStyle = '#8bf5b4'; ctx.fillRect(s.x, s.y, 1, 1); }
    ctx.fillStyle = '#020b06';
    [[10, 28, 6, 11], [17, 24, 5, 15], [23, 30, 7, 9], [31, 22, 6, 17], [38, 27, 5, 12], [44, 25, 7, 14]].forEach(([x, y, w, hh]) => ctx.fillRect(x, y, w, hh));
    [[12, 31], [19, 27], [19, 33], [33, 25], [33, 30], [46, 28], [40, 31]].forEach(([x, y], i) => {
      if (Math.sin(t + i * 1.7) > -0.6) { ctx.fillStyle = i % 3 ? NEON.green : NEON.magenta; ctx.fillRect(x, y, 1, 1); }
    });
    ctx.fillStyle = '#0c2a18'; ctx.fillRect(29, 9, 2, 30); ctx.fillRect(9, 23, 42, 2);
    // plant
    const sway = Math.round(Math.sin(t * 1.3));
    ctx.fillStyle = '#22a374';
    [[100, 46], [97, 43], [103, 42], [95, 39], [105, 38], [99, 36]].forEach(([x, y]) => ctx.fillRect(x + sway, y, 3, 4));
    ctx.fillStyle = '#123d26'; ctx.fillRect(96, 50, 10, 9); ctx.fillStyle = '#1b5a37'; ctx.fillRect(95, 50, 12, 2);
    // desk
    ctx.fillStyle = '#0f3a22'; ctx.fillRect(0, 70, W, 3);
    ctx.fillStyle = '#071a0f'; ctx.fillRect(0, 73, W, H - 73);
    ctx.fillStyle = '#04100a'; ctx.fillRect(6, 73, 3, H - 73); ctx.fillRect(W - 9, 73, 3, H - 73);
    // the alien behind the laptop
    const blink = Math.floor(t * 10) % 40 === 0;
    const ay = 19 + Math.round(Math.sin(t * 2) * 0.6);
    ctx.fillStyle = 'rgba(57,255,136,.10)';
    ctx.fillRect(30, ay - 2, 34, 32);
    drawSprite(ctx, blink ? SPR.alienBlink : SPR.alien, 34, ay, {}, 2);
    // laptop
    ctx.fillStyle = '#6f9e84'; ctx.fillRect(30, 50, 34, 20);
    ctx.fillStyle = '#010804'; ctx.fillRect(32, 52, 30, 16);
    const live = Math.floor(t * 3);
    bars.forEach((b, i) => { const hh = 1 + ((b + live + i) % 7); ctx.fillStyle = (b + live + i) % 3 ? NEON.green : '#ff3d6e'; ctx.fillRect(34 + i * 3, 66 - hh, 2, hh); });
    ctx.fillStyle = '#9dffc6'; ctx.fillRect(26, 69, 42, 2);
    // cat with a wagging tail
    drawSprite(ctx, SPR.cat, 72, 58, {}, 1);
    const wag = Math.floor(t * 3) % 2;
    ctx.fillStyle = '#f5a04a'; ctx.fillRect(84, 66 - wag, 3, 1); ctx.fillRect(86, 64 - wag, 1, 2);
    // mug steam
    ctx.fillStyle = '#d4ffe4'; ctx.fillRect(12, 62, 7, 8); ctx.fillRect(19, 64, 2, 3);
    for (let i = 0; i < 3; i++) { const y = 58 - ((t * 6 + i * 4) % 10); ctx.fillStyle = 'rgba(212,255,228,.35)'; ctx.fillRect(14 + Math.round(Math.sin(t * 3 + i)), Math.round(y), 1, 2); }
  }, 10);
}

// Alien sprite as SVG rects, for places that need vector output (the favicon).
export function alienSvg() {
  const rects = [];
  SPR.alien.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch !== '.') rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${BASE_PAL[ch]}"/>`);
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -0.5 15 16" shape-rendering="crispEdges">${rects.join('')}</svg>`;
}
