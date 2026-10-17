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

// Mounts the saucer over `host` (the page) and returns a stop function.
// onMove receives x in 0..1 across the viewport, so audio can pan with it.
export function startUfo({ onMove } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.className = 'ufo pixel';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const scale = 3;
  let x = -W * scale, dir = 1, y = 0, beam = 0, beamUntil = 0, pauseUntil = 0;
  let last = performance.now(), raf = 0, stopped = false;
  const start = last;

  const frame = (now) => {
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = (now - start) / 1000;
    const vw = window.innerWidth, vh = window.innerHeight;
    const span = vw + W * scale * 2;
    // cruise across, ease in the turn, pause to beam now and then
    if (now > pauseUntil) {
      x += dir * (90 + 40 * Math.sin(t * 0.3)) * dt;
      if (Math.random() < dt * 0.08 && x > 80 && x < vw - 200) {
        pauseUntil = now + 2600;
        beamUntil = now + 2400;
      }
    }
    if (x > vw + 10) { dir = -1; }
    if (x < -W * scale - 10) { dir = 1; }
    beam += ((now < beamUntil ? 1 : 0) - beam) * Math.min(1, dt * 4);
    y = vh * 0.18 + Math.sin(t * 0.7) * vh * 0.1 + Math.sin(t * 2.3) * 6;
    const tilt = now < pauseUntil ? 0 : dir * 6;
    canvas.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) rotate(${tilt}deg)`;
    drawSaucer(ctx, t, beam);
    onMove?.((x + W * scale) / span, beam);
    raf = requestAnimationFrame(frame);
  };

  if (prefs.reduceMotion) {
    canvas.style.transform = `translate(${window.innerWidth - W * scale - 40}px, 90px)`;
    drawSaucer(ctx, 0, 0);
  } else {
    raf = requestAnimationFrame(frame);
  }
  return () => { stopped = true; cancelAnimationFrame(raf); canvas.remove(); };
}
