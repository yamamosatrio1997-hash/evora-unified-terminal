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
  robotBlink: [
    '.....kk.....',
    '....kyyk....',
    '..kkkkkkkk..',
    '.kcccccccck.',
    'kcccccccccck',
    'kcckkcckkcck',
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
  rocket: [
    '..........kkkk..........',
    '.......kkkwwwwkkk.......',
    'kkk..kkwwwwwwwwwwkk.....',
    'krrkkwwwwwbbbwwwwwwkk...',
    'krrrwwwwwbcccbwwwwwwwkk.',
    'krrrwwwwwbcccbwwwwwwwwrk',
    'krrkkwwwwwbbbwwwwwwkk...',
    'kkk..kkwwwwwwwwwwkk.....',
    '.......kkkwwwwkkk.......',
    '..........kkkk..........',
  ],
  heart: [
    '..xxx...xxx..',
    '.xxxxx.xxxxx.',
    'xxxxxxxxxxxxx',
    'xxxxxxxxxxxxx',
    'xxxxxxxxxxxxx',
    '.xxxxxxxxxxx.',
    '..xxxxxxxxx..',
    '...xxxxxxx...',
    '....xxxxx....',
    '.....xxx.....',
    '......x......',
  ],
};

const BASE_PAL = { k: '#0a0f26', w: '#eef2ff', o: '#f5a04a', p: '#ff8fb1', y: '#ffd36b', r: '#ff5c7a', b: '#8aa0ff', c: '#33d6ff' };

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

export function brandLogo(canvas) {
  runScene(canvas, (ctx, t) => {
    ctx.clearRect(0, 0, 16, 16);
    const sweep = (t * 6) % 30 - 8;
    drawSprite(ctx, SPR.heart, 1, 3, {
      x: (i, j) => {
        if (Math.abs(i + j - sweep) < 1.2) return '#ffffff';
        const k = (i + j) / 22;
        return k < 0.5 ? lerpColor('#6ee7ff', '#8b7bff', k * 2) : lerpColor('#8b7bff', '#ff7ad9', (k - 0.5) * 2);
      },
    });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(3, 5, 1, 2);
    ctx.fillRect(4, 4, 1, 1);
  }, 10);
}

export function heroScene(canvas) {
  const W = canvas.width, H = canvas.height;
  const rnd = seeded(77);
  const stars = Array.from({ length: 70 }, () => ({ x: Math.floor(rnd() * W), y: Math.floor(rnd() * H * 0.55), p: rnd() * 6.28, s: 0.6 + rnd() * 2 }));
  const clouds = Array.from({ length: 5 }, (_, i) => ({ x: rnd() * W, y: 10 + rnd() * 30, w: 18 + rnd() * 26, v: 1.2 + rnd() * 2.2, i }));
  const far = [], near = [];
  for (let x = 0; x < W;) { const w = 8 + Math.floor(rnd() * 16); far.push({ x, w, h: 22 + Math.floor(rnd() * 34) }); x += w + 1; }
  for (let x = -4; x < W;) { const w = 10 + Math.floor(rnd() * 18); near.push({ x, w, h: 14 + Math.floor(rnd() * 40), seed: Math.floor(rnd() * 1e6) }); x += w + 2; }
  const tallest = near.reduce((a, b) => (b.h > a.h ? b : a));
  const chart = [];
  let v = 0;
  for (let i = 0; i < 70; i++) { v += (rnd() - 0.38) * 3.2; chart.push(v); }
  const cMin = Math.min(...chart), cMax = Math.max(...chart);
  const trail = [];

  runScene(canvas, (ctx, t) => {
    bandedSky(ctx, W, 0, H, ['#070d2e', '#101d5c', '#24398f', '#4c63c9', '#7f8fe6']);
    // stars
    for (const s of stars) {
      const a = 0.5 + 0.5 * Math.sin(t * s.s + s.p);
      if (a < 0.35) continue;
      ctx.fillStyle = a > 0.85 ? '#ffffff' : '#9fb0ff';
      ctx.fillRect(s.x, s.y, 1, 1);
      if (a > 0.97) { ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillRect(s.x - 1, s.y, 3, 1); ctx.fillRect(s.x, s.y - 1, 1, 3); }
    }
    // moon
    const mx = W - 46, my = 16;
    ctx.fillStyle = 'rgba(255,240,200,.12)';
    for (let r = 12; r > 8; r -= 2) { ctx.beginPath(); ctx.arc(mx, my, r, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#f6f0c8';
    for (let y = -7; y <= 7; y++) { const hw = Math.floor(Math.sqrt(49 - y * y)); ctx.fillRect(mx - hw, my + y, hw * 2, 1); }
    ctx.fillStyle = '#d9d1a4';
    ctx.fillRect(mx - 3, my - 2, 2, 2); ctx.fillRect(mx + 2, my + 2, 2, 1); ctx.fillRect(mx - 1, my + 3, 1, 1);
    // clouds
    for (const c of clouds) {
      const x = ((c.x + t * c.v) % (W + 60)) - 50;
      ctx.fillStyle = 'rgba(160,176,255,.35)';
      ctx.fillRect(x, c.y + 3, c.w, 4);
      ctx.fillRect(x + 4, c.y, c.w * 0.55, 4);
      ctx.fillRect(x + c.w * 0.4, c.y - 2, c.w * 0.35, 3);
      ctx.fillStyle = 'rgba(220,228,255,.35)';
      ctx.fillRect(x + 5, c.y, c.w * 0.45, 1);
    }
    // far skyline
    for (const b of far) {
      ctx.fillStyle = '#1a2766';
      ctx.fillRect(b.x, H - b.h, b.w, b.h);
      ctx.fillStyle = 'rgba(140,160,255,.25)';
      for (let y = H - b.h + 3; y < H - 4; y += 4) for (let x = b.x + 2; x < b.x + b.w - 1; x += 3) if (((x * 7 + y * 13) % 5) === 0) ctx.fillRect(x, y, 1, 1);
    }
    // green performance line rising behind the near buildings
    const prog = Math.min(1, (t % 9) / 6);
    const n = Math.max(2, Math.floor(chart.length * prog));
    const cx0 = W * 0.42, cx1 = W - 8, cy0 = H - 24, cy1 = 30;
    let px = null, py = null;
    for (let i = 0; i < n; i++) {
      const x = Math.round(cx0 + (i / (chart.length - 1)) * (cx1 - cx0));
      const y = Math.round(cy0 - ((chart[i] - cMin) / (cMax - cMin)) * (cy0 - cy1));
      if (px != null) {
        const steps = Math.max(Math.abs(x - px), Math.abs(y - py));
        for (let k = 0; k <= steps; k++) {
          const xx = Math.round(px + ((x - px) * k) / steps), yy = Math.round(py + ((y - py) * k) / steps);
          ctx.fillStyle = 'rgba(34,227,155,.25)'; ctx.fillRect(xx - 1, yy - 1, 3, 3);
          ctx.fillStyle = '#22e39b'; ctx.fillRect(xx, yy, 1, 2);
        }
      }
      px = x; py = y;
    }
    if (px != null && Math.floor(t * 4) % 2) { ctx.fillStyle = '#c9ffe9'; ctx.fillRect(px - 1, py - 1, 3, 3); }
    // near skyline with flickering windows
    for (const b of near) {
      ctx.fillStyle = '#0c1540';
      ctx.fillRect(b.x, H - b.h, b.w, b.h);
      ctx.fillStyle = '#16225a';
      ctx.fillRect(b.x, H - b.h, b.w, 1);
      for (let y = H - b.h + 3; y < H - 2; y += 3) {
        for (let x = b.x + 2; x < b.x + b.w - 1; x += 3) {
          const hsh = (x * 73856093) ^ (y * 19349663) ^ b.seed;
          if ((hsh & 7) > 2) continue;
          const flick = ((hsh >> 4) & 63) === 0 && Math.sin(t * 3 + hsh) > 0.3;
          ctx.fillStyle = flick ? '#0c1540' : (hsh & 16) ? '#ffd36b' : '#6fe3ff';
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    if (Math.floor(t * 1.5) % 2) { ctx.fillStyle = '#ff5c7a'; ctx.fillRect(tallest.x + Math.floor(tallest.w / 2), H - tallest.h - 3, 1, 3); }
    // rocket with cat pilot
    const rx = Math.round(W * 0.6 + Math.sin(t * 0.7) * 10), ry = Math.round(H * 0.34 + Math.sin(t * 2.2) * 3);
    if (Math.random() < 0.9) trail.push({ x: rx - 2, y: ry + 4 + Math.round((Math.random() - 0.5) * 3), life: 1 });
    for (const p of trail) { p.x -= 2.4; p.life -= 0.06; }
    while (trail.length && trail[0].life <= 0) trail.shift();
    for (const p of trail) { ctx.fillStyle = p.life > 0.6 ? '#ffd36b' : p.life > 0.3 ? '#ff8a3d' : 'rgba(255,92,122,.6)'; ctx.fillRect(Math.round(p.x), p.y, 1 + (p.life > 0.6), 1); }
    const flame = Math.floor(t * 12) % 3;
    ctx.fillStyle = '#ff8a3d'; ctx.fillRect(rx - 3 - flame, ry + 3, 3 + flame, 4);
    ctx.fillStyle = '#ffd36b'; ctx.fillRect(rx - 2, ry + 4, 2 + flame, 2);
    drawSprite(ctx, SPR.cat, rx + 7, ry - 9, {}, 1);
    drawSprite(ctx, SPR.rocket, rx, ry, {}, 1);
  }, 14);
}

export function sunsetScene(canvas) {
  const W = canvas.width, H = canvas.height, hz = Math.round(H * 0.6);
  const rnd = seeded(5);
  const birds = Array.from({ length: 3 }, () => ({ x: rnd() * W, y: 10 + rnd() * 18, v: 3 + rnd() * 3 }));
  runScene(canvas, (ctx, t) => {
    bandedSky(ctx, W, 0, hz, ['#22134f', '#5a2b86', '#c2477d', '#ff8a5a', '#ffcf7a']);
    // sun with retro stripes
    const sx = Math.round(W * 0.42), r = 17;
    for (let y = -r; y <= 0; y++) {
      if ([-3, -6, -8].includes(y)) continue;
      const hw = Math.floor(Math.sqrt(r * r - y * y));
      ctx.fillStyle = lerpColor('#fff1a8', '#ff9a5a', (y + r) / r);
      ctx.fillRect(sx - hw, hz + y, hw * 2, 1);
    }
    bandedSky(ctx, W, hz, H, ['#5b3a8c', '#2d2366', '#151140']);
    for (let y = hz + 1; y < H; y += 2) {
      const spread = 6 + (y - hz) * 0.9;
      const off = Math.round(Math.sin(t * 2 + y * 0.8) * 3);
      ctx.fillStyle = (y - hz) < 10 ? '#ffd27a' : '#ff9a5a';
      ctx.fillRect(sx - spread / 2 + off, y, spread * (0.4 + 0.3 * Math.sin(t + y)), 1);
      ctx.fillStyle = 'rgba(255,190,140,.35)';
      if ((y + Math.floor(t * 3)) % 6 === 0) ctx.fillRect((y * 37 + Math.floor(t * 10)) % W, y, 4, 1);
    }
    for (const b of birds) {
      const x = ((b.x + t * b.v) % (W + 20)) - 10;
      const flap = Math.floor(t * 4 + b.x) % 2;
      ctx.fillStyle = '#2a1640';
      ctx.fillRect(x, b.y + flap, 1, 1); ctx.fillRect(x + 1, b.y + 1 - flap, 1, 1); ctx.fillRect(x + 2, b.y + 1, 1, 1);
      ctx.fillRect(x + 3, b.y + 1 - flap, 1, 1); ctx.fillRect(x + 4, b.y + flap, 1, 1);
    }
    // pier + fisher bot + cat
    const pierX = Math.round(W * 0.66);
    ctx.fillStyle = '#120a2a';
    ctx.fillRect(pierX, hz + 4, W - pierX, 3);
    for (let x = pierX + 3; x < W; x += 9) ctx.fillRect(x, hz + 7, 2, H - hz - 7);
    const botX = pierX + 8, botY = hz - 6;
    drawSprite(ctx, SPR.robot, botX, botY, { c: '#3d4f9e', y: '#ffd36b', w: '#c9d6ff' }, 1);
    drawSprite(ctx, SPR.cat, botX + 15, hz - 8, {}, 1);
    ctx.fillStyle = '#2a1640';
    const tipX = botX - 14, tipY = botY - 10;
    for (let i = 0; i <= 14; i++) ctx.fillRect(botX - i, botY + 4 - Math.round(i * 1.0), 1, 1);
    const bob = Math.round(Math.sin(t * 2.5) * 1.2);
    ctx.fillStyle = 'rgba(255,230,200,.6)';
    for (let y = tipY; y < hz + 10 + bob; y += 2) ctx.fillRect(tipX, y, 1, 1);
    ctx.fillStyle = '#ff5c7a'; ctx.fillRect(tipX - 1, hz + 10 + bob, 3, 2);
  }, 10);
}

export function mascotScene(canvas) {
  const W = canvas.width, H = canvas.height;
  const rnd = seeded(9);
  const winStars = Array.from({ length: 10 }, () => ({ x: 10 + Math.floor(rnd() * 40), y: 9 + Math.floor(rnd() * 12), p: rnd() * 6 }));
  const bars = Array.from({ length: 9 }, () => 1 + Math.floor(rnd() * 6));
  runScene(canvas, (ctx, t) => {
    ctx.fillStyle = '#0b1230'; ctx.fillRect(0, 0, W, H);
    // lamp glow
    const g = ctx.createRadialGradient(W * 0.72, 12, 2, W * 0.72, 12, 60);
    g.addColorStop(0, 'rgba(255,211,107,.18)'); g.addColorStop(1, 'rgba(255,211,107,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // window with night city
    ctx.fillStyle = '#1c2860'; ctx.fillRect(7, 7, 46, 34);
    bandedSky(ctx, 0, 0, 0, ['#000000', '#000000']);
    ctx.fillStyle = '#16205a'; ctx.fillRect(9, 9, 42, 30);
    for (const s of winStars) if (Math.sin(t * 2 + s.p) > -0.2) { ctx.fillStyle = '#c9d6ff'; ctx.fillRect(s.x, s.y, 1, 1); }
    ctx.fillStyle = '#0c1440';
    [[10, 28, 6, 11], [17, 24, 5, 15], [23, 30, 7, 9], [31, 22, 6, 17], [38, 27, 5, 12], [44, 25, 7, 14]].forEach(([x, y, w, hh]) => ctx.fillRect(x, y, w, hh));
    ctx.fillStyle = '#ffd36b';
    [[12, 31], [19, 27], [19, 33], [33, 25], [33, 30], [46, 28], [40, 31]].forEach(([x, y], i) => { if (Math.sin(t + i * 1.7) > -0.6) ctx.fillRect(x, y, 1, 1); });
    ctx.fillStyle = '#1c2860'; ctx.fillRect(29, 9, 2, 30); ctx.fillRect(9, 23, 42, 2);
    // plant
    const sway = Math.round(Math.sin(t * 1.3));
    ctx.fillStyle = '#22a374';
    [[100, 46], [97, 43], [103, 42], [95, 39], [105, 38], [99, 36]].forEach(([x, y]) => ctx.fillRect(x + sway, y, 3, 4));
    ctx.fillStyle = '#5b3a8c'; ctx.fillRect(96, 50, 10, 9); ctx.fillStyle = '#6f4aa6'; ctx.fillRect(95, 50, 12, 2);
    // desk
    ctx.fillStyle = '#26326e'; ctx.fillRect(0, 70, W, 3);
    ctx.fillStyle = '#18214f'; ctx.fillRect(0, 73, W, H - 73);
    ctx.fillStyle = '#121a42'; ctx.fillRect(6, 73, 3, H - 73); ctx.fillRect(W - 9, 73, 3, H - 73);
    // robot mascot behind laptop
    const blink = Math.floor(t * 10) % 40 === 0;
    const by = 38 + Math.round(Math.sin(t * 2) * 0.6);
    drawSprite(ctx, blink ? SPR.robotBlink : SPR.robot, 36, by, { c: '#3d6bff', y: '#ffd36b' }, 2);
    // laptop
    ctx.fillStyle = '#a7b4e6'; ctx.fillRect(30, 50, 34, 20);
    ctx.fillStyle = '#0d1b4d'; ctx.fillRect(32, 52, 30, 16);
    const live = Math.floor(t * 3);
    bars.forEach((b, i) => { const hh = 1 + ((b + live + i) % 7); ctx.fillStyle = (b + live + i) % 3 ? '#22e39b' : '#ff5c7a'; ctx.fillRect(34 + i * 3, 66 - hh, 2, hh); });
    ctx.fillStyle = '#c9d6ff'; ctx.fillRect(26, 69, 42, 2);
    // cat on desk, tail wag
    drawSprite(ctx, SPR.cat, 72, 58, {}, 1);
    const wag = Math.floor(t * 3) % 2;
    ctx.fillStyle = '#f5a04a'; ctx.fillRect(84, 66 - wag, 3, 1); ctx.fillRect(86, 64 - wag, 1, 2);
    // mug steam
    ctx.fillStyle = '#e6ecff'; ctx.fillRect(12, 62, 7, 8); ctx.fillRect(19, 64, 2, 3);
    for (let i = 0; i < 3; i++) { const y = 58 - ((t * 6 + i * 4) % 10); ctx.fillStyle = 'rgba(230,236,255,.35)'; ctx.fillRect(14 + Math.round(Math.sin(t * 3 + i)), Math.round(y), 1, 2); }
  }, 10);
}
