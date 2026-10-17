// A pixel-art flying saucer with an alien pilot that cruises back and forth over the page.
// Drawn on its own low-resolution canvas fixed above the content; it never takes clicks.
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
// coordinates (not the viewport), so scrolling never drags it along: it roams the
// whole homepage on its own, picking random waypoints and switching moods.
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
  const size = () => ({ w: canvas.offsetWidth, h: canvas.offsetHeight });
  const bounds = () => {
    const { w, h } = size();
    return { maxX: Math.max(0, document.documentElement.clientWidth - w - 8), minY: 70, maxY: Math.max(140, app.scrollHeight - h - 20) };
  };
  const rand = (a, b) => a + Math.random() * (b - a);

  let { maxX, maxY, minY } = bounds();
  const pos = { x: rand(0, maxX), y: rand(minY, Math.min(maxY, 500)) };
  const vel = { x: 0, y: 0 };
  let mode = 'cruise', modeUntil = 0, target = null, speed = 160, beam = 0, loopC = null, loopA = 0;
  let last = performance.now(), raf = 0, stopped = false;
  const start = last;

  function nextMode(now) {
    ({ maxX, maxY, minY } = bounds());
    const r = Math.random();
    if (r < 0.5) { mode = 'cruise'; speed = rand(110, 230); target = { x: rand(0, maxX), y: rand(minY, maxY) }; modeUntil = now + 9000; }
    else if (r < 0.68) { mode = 'zip'; speed = rand(650, 900); target = { x: rand(0, maxX), y: rand(minY, maxY) }; modeUntil = now + 2500; }
    else if (r < 0.86) { mode = 'hover'; modeUntil = now + rand(2200, 4200); }
    else { mode = 'loop'; loopC = { x: pos.x, y: pos.y + 70 }; loopA = -Math.PI / 2; modeUntil = now + 2600; }
  }

  const frame = (now) => {
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = (now - start) / 1000;
    if (now > modeUntil) nextMode(now);
    if (mode === 'cruise' || mode === 'zip') {
      const dx = target.x - pos.x, dy = target.y - pos.y;
      const d = Math.hypot(dx, dy);
      if (d < 12) nextMode(now);
      // steer: velocity eases toward the desired heading, so turns are smooth arcs
      const k = mode === 'zip' ? 5 : 1.6;
      vel.x += ((dx / (d || 1)) * speed - vel.x) * Math.min(1, dt * k);
      vel.y += ((dy / (d || 1)) * speed - vel.y) * Math.min(1, dt * k);
    } else if (mode === 'hover') {
      vel.x += (-vel.x) * Math.min(1, dt * 3);
      vel.y += (Math.sin(t * 2) * 12 - vel.y) * Math.min(1, dt * 3);
    } else if (mode === 'loop') {
      loopA += dt * 2.6;
      const tx = loopC.x + Math.cos(loopA) * 70, ty = loopC.y + Math.sin(loopA) * 70;
      vel.x = (tx - pos.x) / Math.max(dt, 0.016); vel.y = (ty - pos.y) / Math.max(dt, 0.016);
    }
    pos.x = Math.min(maxX, Math.max(0, pos.x + vel.x * dt));
    pos.y = Math.min(maxY, Math.max(minY, pos.y + vel.y * dt));
    beam += ((mode === 'hover' ? 1 : 0) - beam) * Math.min(1, dt * 3);
    const tilt = Math.max(-18, Math.min(18, vel.x / 14));
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
    nextMode(last);
    raf = requestAnimationFrame(frame);
  }
  return () => { stopped = true; cancelAnimationFrame(raf); canvas.remove(); };
}
