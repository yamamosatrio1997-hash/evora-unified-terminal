// A pixel-art flying saucer with an alien pilot that bobs and circles the whole page.
// Drawn on its own low-resolution canvas positioned over the content; it never takes clicks.
import { prefs } from './util.js';

const W = 44, H = 40; // sprite canvas in art pixels (scaled 3x on screen)
const PAL = {
  outline: '#1d2a33', hullLight: '#d5dde0', hull: '#a9b5ba', hullDark: '#76848a', rim: '#5e6a70',
  glass: 'rgba(120,215,255,.55)', glassHi: 'rgba(235,250,255,.9)', glassEdge: '#3b7fa6',
  skin: '#6fd34a', skinDark: '#3f9a2c', eye: '#0b0f10', light: '#ffd23b', lightOff: '#8a6d1a',
};

function px(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }

function drawSaucer(ctx, t, beam) {
  ctx.clearRect(0, 0, W, H);
  const cx = 22;
  // tractor beam (behind the hull)
  if (beam > 0) {
    for (let y = 22; y < H; y++) {
      const k = (y - 22) / (H - 22);
      const half = 4 + k * 12;
      ctx.fillStyle = `rgba(255,214,59,${(0.55 - k * 0.5) * beam})`;
      ctx.fillRect(Math.round(cx - half), y, Math.round(half * 2), 1);
    }
    for (let i = 0; i < 4; i++) {
      const y = 24 + ((t * 18 + i * 5) % 15);
      px(ctx, cx - 6 + ((i * 7) % 12), Math.round(y), 1, 1, `rgba(255,250,210,${0.8 * beam})`);
    }
  }
  // dome: glass with the alien inside
  const dome = [[15, 4], [12, 5], [10, 6], [9, 7], [8, 8], [8, 9], [8, 10], [8, 11]];
  dome.forEach(([x0, y], i) => px(ctx, x0 + (i < 1 ? 0 : 0), y, (cx - x0) * 2, 1, PAL.glass));
  px(ctx, 15, 3, 14, 1, PAL.glassEdge);
  // alien (head bobs a little, blinks now and then)
  const bob = Math.round(Math.sin(t * 3) * 0.6);
  const blink = Math.floor(t * 10) % 37 === 0;
  px(ctx, 18, 5 + bob, 8, 1, PAL.skin); px(ctx, 17, 6 + bob, 10, 4, PAL.skin); px(ctx, 18, 10 + bob, 8, 1, PAL.skin);
  px(ctx, 19, 11 + bob, 6, 1, PAL.skinDark); px(ctx, 16, 12, 12, 2, PAL.skin);
  if (blink) { px(ctx, 18, 8 + bob, 3, 1, PAL.eye); px(ctx, 23, 8 + bob, 3, 1, PAL.eye); }
  else {
    px(ctx, 18, 7 + bob, 3, 3, PAL.eye); px(ctx, 23, 7 + bob, 3, 3, PAL.eye);
    px(ctx, 18, 7 + bob, 1, 1, '#ffffff'); px(ctx, 25, 7 + bob, 1, 1, '#ffffff');
  }
  px(ctx, 21, 10 + bob, 2, 1, PAL.skinDark);
  // glass highlight
  px(ctx, 25, 5, 2, 1, PAL.glassHi); px(ctx, 27, 6, 1, 2, PAL.glassHi);
  // hull
  px(ctx, 6, 12, 32, 1, PAL.outline);
  px(ctx, 3, 13, 38, 1, PAL.outline); px(ctx, 4, 13, 36, 1, PAL.hullLight);
  px(ctx, 1, 14, 42, 1, PAL.outline); px(ctx, 2, 14, 40, 1, PAL.hullLight);
  px(ctx, 0, 15, 44, 4, PAL.outline); px(ctx, 1, 15, 42, 3, PAL.hull);
  px(ctx, 1, 17, 42, 1, PAL.hullDark);
  px(ctx, 2, 19, 40, 1, PAL.outline); px(ctx, 3, 19, 38, 1, PAL.rim);
  px(ctx, 6, 20, 32, 1, PAL.outline); px(ctx, 7, 20, 30, 1, PAL.hullDark);
  // underside pods
  for (const x of [12, 20, 28]) { px(ctx, x, 21, 4, 1, PAL.outline); px(ctx, x + 1, 21, 2, 1, PAL.hullLight); px(ctx, x, 22, 4, 1, PAL.outline); }
  // lights chase around the rim
  const lights = [4, 10, 16, 22, 28, 34, 39];
  lights.forEach((x, i) => {
    const on = (i + Math.floor(t * 5)) % 3 !== 0;
    px(ctx, x, 15, 2, 2, on ? PAL.light : PAL.lightOff);
    if (on) px(ctx, x, 15, 1, 1, '#fff6c8');
  });
}

// Mounts the saucer on the page and returns a stop function. It flies in page
// coordinates (not the viewport), so scrolling never drags it along. The flight is a
// fixed routine: bob up and down in place (beaming at the end), then fly one full lap
// around the whole page along a rounded rectangle hugging its edges, then bob again.
// onMove receives its x in 0..1 across the page width, so audio can pan with it.
export function startUfo({ onMove } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.className = 'ufo pixel';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const app = document.getElementById('app');
  const BOB_TIME = 6, LAP_SPEED = 420, APPROACH_SPEED = 520;
  let maxX = 0, minY = 70, maxY = 140, path = null;

  // Rounded-rectangle loop around the page, parameterised by arc length (clockwise).
  function measure() {
    maxX = Math.max(0, document.documentElement.clientWidth - canvas.offsetWidth - 8);
    maxY = Math.max(minY + 140, app.scrollHeight - canvas.offsetHeight - 20);
    const w = maxX, h = maxY - minY, r = Math.min(220, w / 3, h / 3);
    const straight = [w - 2 * r, h - 2 * r, w - 2 * r, h - 2 * r];
    const arc = (Math.PI / 2) * r;
    path = { w, h, r, straight, arc, len: straight.reduce((a, b) => a + b, 0) + 4 * arc };
  }

  function pointAt(s) {
    const { w, h, r, straight, arc, len } = path;
    s = ((s % len) + len) % len;
    // corner centres in order: top-right, bottom-right, bottom-left, top-left
    const corners = [[w - r, r], [w - r, h - r], [r, h - r], [r, r]];
    const starts = [[r, 0], [w, r], [w - r, h], [0, h - r]];
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (let i = 0; i < 4; i++) {
      if (s <= straight[i]) return { x: starts[i][0] + dirs[i][0] * s, y: minY + starts[i][1] + dirs[i][1] * s };
      s -= straight[i];
      if (s <= arc || i === 3) {
        const a = -Math.PI / 2 + (i * Math.PI) / 2 + Math.min(1, s / arc) * (Math.PI / 2);
        return { x: corners[i][0] + Math.cos(a) * r, y: minY + corners[i][1] + Math.sin(a) * r };
      }
      s -= arc;
    }
    return { x: r, y: minY };
  }

  function nearestS(p) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 240; i++) {
      const s = (i / 240) * path.len, q = pointAt(s);
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  measure();
  const pos = { x: maxX * 0.62, y: minY + 160 };
  const vel = { x: 0, y: 0 };
  let phase = 'bob', phaseT = 0, baseY = pos.y, s = 0, lapLeft = 0, beam = 0;
  let last = performance.now(), raf = 0, stopped = false;
  const start = last;

  function begin(next) {
    phase = next; phaseT = 0;
    if (next === 'bob') baseY = pos.y;
    if (next === 'approach') { measure(); s = nearestS(pos); }
    if (next === 'lap') lapLeft = path.len;
  }

  const frame = (now) => {
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = (now - start) / 1000;
    phaseT += dt;
    const prev = { x: pos.x, y: pos.y };
    if (phase === 'bob') {
      // up and down in place, a slow sway sideways, beam on in the second half
      pos.y = baseY + Math.sin(phaseT * 2.4) * 46 * Math.min(1, phaseT);
      pos.x += Math.sin(phaseT * 0.9) * 12 * dt;
      if (phaseT > BOB_TIME) begin('approach');
    } else if (phase === 'approach') {
      const q = pointAt(s), dx = q.x - pos.x, dy = q.y - pos.y, d = Math.hypot(dx, dy);
      const step = Math.min(d, APPROACH_SPEED * dt);
      if (d < 4) begin('lap');
      else { pos.x += (dx / d) * step; pos.y += (dy / d) * step; }
    } else if (phase === 'lap') {
      // ease in and out of the lap so it never starts or stops with a jerk
      const done = path.len - lapLeft;
      const ease = Math.min(1, 0.25 + done / 500, 0.25 + lapLeft / 500);
      const ds = LAP_SPEED * ease * dt;
      s += ds; lapLeft -= ds;
      const q = pointAt(s);
      pos.x = q.x; pos.y = q.y;
      if (lapLeft <= 0) begin('bob');
    }
    pos.x = Math.min(maxX, Math.max(0, pos.x));
    vel.x += ((pos.x - prev.x) / Math.max(dt, 0.001) - vel.x) * Math.min(1, dt * 6);
    vel.y += ((pos.y - prev.y) / Math.max(dt, 0.001) - vel.y) * Math.min(1, dt * 6);
    const beamOn = phase === 'bob' && phaseT > BOB_TIME * 0.45 && phaseT < BOB_TIME - 0.4;
    beam += ((beamOn ? 1 : 0) - beam) * Math.min(1, dt * 4);
    const tilt = Math.max(-18, Math.min(18, vel.x / 20));
    const wobble = Math.sin(t * 2.3) * 4;
    canvas.style.transform = `translate(${Math.round(pos.x)}px, ${Math.round(pos.y + wobble)}px) rotate(${tilt.toFixed(1)}deg)`;
    drawSaucer(ctx, t, beam);
    onMove?.(maxX ? pos.x / maxX : 0.5, beam);
    raf = requestAnimationFrame(frame);
  };

  if (prefs.reduceMotion) {
    canvas.style.transform = `translate(${maxX - 30}px, 90px)`;
    drawSaucer(ctx, 0, 0);
  } else {
    raf = requestAnimationFrame(frame);
  }
  return () => { stopped = true; cancelAnimationFrame(raf); canvas.remove(); };
}
