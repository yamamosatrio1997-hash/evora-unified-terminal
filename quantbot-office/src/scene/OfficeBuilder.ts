import {
  BoxGeometry, CanvasTexture, CylinderGeometry, DoubleSide, Group, IcosahedronGeometry, Mesh, MeshPhysicalMaterial,
  MeshStandardMaterial, PlaneGeometry, SphereGeometry, SRGBColorSpace, type Material,
} from 'three';
import { FLOOR_Y, type FloorId, type FurnitureDef, type OfficeLayout } from '../config/layout';
import type { Screens } from './Screens';

const cache = new Map<string, MeshStandardMaterial>();
const std = (color: string, roughness = 0.7, metalness = 0) => {
  const key = `${color}|${roughness}|${metalness}`;
  if (!cache.has(key)) cache.set(key, new MeshStandardMaterial({ color, roughness, metalness }));
  return cache.get(key)!;
};

const glass = new MeshPhysicalMaterial({
  color: '#9fd3ff', transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0, depthWrite: false, side: DoubleSide,
});

const M = {
  desk: std('#3a3f48', 0.5),
  deskTop: std('#d6d3cd', 0.6),
  wood: std('#7a5233', 0.6),
  darkWood: std('#4a3220', 0.55),
  metal: std('#9aa3ad', 0.35, 0.7),
  black: std('#14161a', 0.45),
  chair: std('#20242b', 0.6),
  wall: std('#e7e5e0', 0.9),
  frame: std('#5b6370', 0.4, 0.6),
  felt: std('#13643a', 0.95),
  blueTable: std('#1d3a8a', 0.6),
  white: std('#f3f4f6', 0.6),
  fabric: std('#3f4652', 0.95),
  leaf: std('#2f7d3a', 0.8),
  pot: std('#c7c2b8', 0.7),
  step: std('#8b8f96', 0.6),
  slab: std('#3a3f47', 0.85),
};

function box(w: number, h: number, d: number, mat: Material, x = 0, y = 0, z = 0, shadow = true): Mesh {
  const m = new Mesh(new BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

function cyl(rTop: number, rBot: number, h: number, mat: Material, x = 0, y = 0, z = 0, seg = 16): Mesh {
  const m = new Mesh(new CylinderGeometry(rTop, rBot, h, seg), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function textTexture(text: string, opts: { w?: number; h?: number; size?: number; color?: string; bg?: string; font?: string } = {}): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = opts.w ?? 512;
  canvas.height = opts.h ?? 96;
  const ctx = canvas.getContext('2d')!;
  if (opts.bg) { ctx.fillStyle = opts.bg; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.fillStyle = opts.color ?? '#e2e8f0';
  ctx.font = `${opts.size ?? 44}px ${opts.font ?? '"Chakra Petch", "JetBrains Mono", sans-serif'}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 16, canvas.height / 2);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export interface OfficeModel {
  root: Group;
  floors: Record<FloorId, Group>;
}

/**
 * Builds the procedural office from the layout. Replace or hide it when you
 * load your own environment .glb — characters only depend on the layout data.
 */
export function buildOffice(layout: OfficeLayout, screens: Screens, seatNames: Record<string, { name: string; sub?: string; color?: string }>): OfficeModel {
  const root = new Group();
  const floors: Record<FloorId, Group> = { 0: new Group(), 1: new Group() };
  root.add(floors[0], floors[1]);

  // Site ground
  const ground = new Mesh(new PlaneGeometry(120, 120), std('#11141a', 1));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  root.add(ground);

  // Room floors + labels
  for (const r of layout.rooms) {
    const [x0, z0, x1, z1] = r.rect;
    const y = FLOOR_Y[r.floor];
    const floor = new Mesh(new PlaneGeometry(x1 - x0, z1 - z0), std(r.color, 0.85));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((x0 + x1) / 2, y + 0.005, (z0 + z1) / 2);
    floor.receiveShadow = true;
    floors[r.floor].add(floor);
    if (r.name) {
      const label = new Mesh(
        new PlaneGeometry(4.5, 0.85),
        new MeshStandardMaterial({ map: textTexture(r.name, { color: '#7dd3fc' }), transparent: true, roughness: 1 }),
      );
      label.rotation.x = -Math.PI / 2;
      label.position.set(x0 + 2.6, y + 0.01, z1 - 0.6);
      floors[r.floor].add(label);
    }
  }

  // Upper slab (with stairwell opening) seen from below/side
  const slabT = 0.25;
  for (const [x0, z0, x1, z1] of [[-4, 0, 8, 12], [12, 0, 22, 12], [8, 10, 12, 12]] as const) {
    floors[1].add(box(x1 - x0, slabT, z1 - z0, M.slab, (x0 + x1) / 2, FLOOR_Y[1] - slabT / 2, (z0 + z1) / 2));
  }

  // Walls
  for (const w of layout.walls) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const horizontal = w.a[1] === w.b[1];
    const cx = (w.a[0] + w.b[0]) / 2;
    const cz = (w.a[1] + w.b[1]) / 2;
    const y = FLOOR_Y[w.floor];
    const g = new Group();
    g.position.set(cx, y, cz);
    g.rotation.y = horizontal ? 0 : Math.PI / 2;
    if (w.glass) {
      const pane = new Mesh(new BoxGeometry(len, w.height, 0.04), glass);
      pane.position.y = w.height / 2;
      pane.renderOrder = 2;
      g.add(pane, box(len, 0.06, 0.08, M.frame, 0, w.height, 0, false), box(len, 0.08, 0.1, M.frame, 0, 0.04, 0, false));
    } else {
      g.add(box(len, w.height, 0.16, M.wall, 0, w.height / 2, 0));
    }
    floors[w.floor].add(g);
  }

  for (const f of layout.furniture) {
    const obj = buildFurniture(f, screens, seatNames);
    if (!obj) continue;
    obj.position.set(f.pos[0], f.pos[1], f.pos[2]);
    obj.rotation.y = f.rot ?? 0;
    floors[f.pos[1] >= FLOOR_Y[1] - 0.01 && f.type !== 'stairs' ? 1 : 0].add(obj);
  }
  return { root, floors };
}

function monitor(screen: Material, x: number, y: number, z: number, w = 0.55, h = 0.32, yaw = 0): Group {
  const g = new Group();
  g.position.set(x, y, z);
  g.rotation.y = yaw;
  g.add(box(w + 0.03, h + 0.03, 0.03, M.black, 0, 0, 0));
  const s = new Mesh(new PlaneGeometry(w, h), screen);
  s.position.z = 0.017;
  g.add(s);
  g.add(box(0.04, 0.2, 0.04, M.black, 0, -h / 2 - 0.08, -0.02));
  return g;
}

function buildFurniture(f: FurnitureDef, screens: Screens, seatNames: Record<string, { name: string; sub?: string; color?: string }>): Group | null {
  const g = new Group();
  const scr = f.screen ? screens.material(f.screen) : screens.material('chart');
  switch (f.type) {
    // Desks: the user sits on local -Z side facing +Z; monitors stand on the far side.
    case 'traderDesk':
    case 'leadDesk':
    case 'execDesk': {
      const exec = f.type === 'execDesk';
      const w = exec ? 2.2 : 1.6;
      const d = exec ? 0.9 : 0.8;
      g.add(box(w, 0.05, d, exec ? M.darkWood : M.deskTop, 0, 0.74, 0));
      g.add(box(0.05, 0.72, d * 0.9, M.desk, -w / 2 + 0.05, 0.36, 0), box(0.05, 0.72, d * 0.9, M.desk, w / 2 - 0.05, 0.36, 0));
      g.add(box(w - 0.1, 0.4, 0.03, M.desk, 0, 0.5, d / 2 - 0.05));
      g.add(box(0.45, 0.02, 0.15, M.black, 0, 0.775, -0.15));
      const z = d / 2 - 0.2;
      if (f.type === 'traderDesk') {
        g.add(monitor(scr, -0.3, 1.02, z, 0.55, 0.32, Math.PI + 0.18), monitor(scr, 0.3, 1.02, z, 0.55, 0.32, Math.PI - 0.18));
      } else if (exec) {
        g.add(
          monitor(scr, 0, 1.06, z, 0.7, 0.4, Math.PI),
          monitor(screens.material('chart'), -0.72, 1.04, z - 0.05, 0.5, 0.3, Math.PI + 0.35),
          monitor(screens.material('chart'), 0.72, 1.04, z - 0.05, 0.5, 0.3, Math.PI - 0.35),
        );
      } else {
        g.add(monitor(scr, 0.15, 1.04, z, 0.6, 0.34, Math.PI));
        const lap = box(0.32, 0.015, 0.22, M.metal, -0.5, 0.775, -0.05);
        g.add(lap);
      }
      const owner = f.seat ? seatNames[f.seat] : undefined;
      if (owner && f.type !== 'traderDesk') {
        const plate = new Mesh(
          new PlaneGeometry(0.6, 0.12),
          new MeshStandardMaterial({ map: textTexture(owner.name.toUpperCase(), { w: 256, h: 52, size: 34, bg: owner.color ?? '#0f172a', color: '#ffffff' }) }),
        );
        plate.position.set(0, 0.6, d / 2 + 0.005);
        g.add(plate);
      }
      return g;
    }
    case 'chair': {
      g.add(box(0.48, 0.07, 0.46, M.chair, 0, 0.45, 0));
      g.add(box(0.46, 0.5, 0.06, M.chair, 0, 0.75, -0.24));
      g.add(cyl(0.03, 0.03, 0.4, M.metal, 0, 0.22, 0, 8));
      g.add(cyl(0.26, 0.26, 0.03, M.black, 0, 0.03, 0, 10));
      return g;
    }
    case 'meetingTable': {
      const [w, d] = f.size ?? [2, 5];
      g.add(box(w, 0.06, d, M.darkWood, 0, 0.74, 0));
      g.add(box(0.3, 0.7, d * 0.6, M.black, 0, 0.36, 0));
      for (let i = 0; i < 4; i++) g.add(box(0.12, 0.012, 0.2, M.white, (i % 2 ? 0.55 : -0.55), 0.775, -1.5 + i));
      return g;
    }
    case 'wallScreen': {
      const [w, h] = f.size ?? [4, 2];
      g.add(box(w + 0.12, h + 0.12, 0.08, M.black, 0, 0, -0.03));
      const s = new Mesh(new PlaneGeometry(w, h), scr);
      s.position.z = 0.015;
      g.add(s);
      return g;
    }
    case 'counter': {
      const [w, d] = f.size ?? [4, 0.7];
      g.add(box(w, 0.86, d, M.white, 0, 0.43, 0));
      g.add(box(w + 0.04, 0.05, d + 0.04, M.darkWood, 0, 0.88, 0));
      return g;
    }
    case 'coffeeMachine': {
      g.add(box(0.36, 0.44, 0.34, M.black, 0, 0.22, 0));
      g.add(box(0.2, 0.06, 0.12, M.metal, 0, 0.12, 0.15));
      g.add(cyl(0.02, 0.02, 0.02, std('#ef4444', 0.3), 0.12, 0.36, 0.175, 8));
      return g;
    }
    case 'fridge': {
      g.add(box(0.75, 1.85, 0.68, M.metal, 0, 0.925, 0));
      g.add(box(0.03, 0.5, 0.03, M.black, -0.28, 1.2, -0.35));
      return g;
    }
    case 'highTable': {
      g.add(cyl(0.5, 0.5, 0.04, M.darkWood, 0, 1.05, 0, 24));
      g.add(cyl(0.04, 0.04, 1.03, M.metal, 0, 0.52, 0, 8));
      g.add(cyl(0.28, 0.3, 0.03, M.black, 0, 0.015, 0, 18));
      g.add(cyl(0.045, 0.04, 0.1, M.white, 0.18, 1.12, 0.1, 10));
      return g;
    }
    case 'whiteboard': {
      const tex = textTexture('alpha = f(signal, risk)  ⟶  size', { w: 1024, h: 512, size: 52, color: '#1d4ed8', bg: '#f8fafc', font: '"Comic Sans MS", cursive' });
      const board = new Mesh(new PlaneGeometry(2, 1.1), new MeshStandardMaterial({ map: tex, roughness: 0.4 }));
      board.position.set(0, 1.45, 0.025);
      g.add(box(2.08, 1.18, 0.04, M.frame, 0, 1.45, 0));
      g.add(board);
      g.add(box(0.04, 0.9, 0.04, M.frame, -0.95, 0.45, 0), box(0.04, 0.9, 0.04, M.frame, 0.95, 0.45, 0));
      return g;
    }
    case 'plant': {
      g.add(cyl(0.22, 0.17, 0.42, M.pot, 0, 0.21, 0, 12));
      const leaf = new Mesh(new IcosahedronGeometry(0.42, 0), M.leaf);
      leaf.position.y = 0.85;
      leaf.scale.set(1, 1.3, 1);
      leaf.castShadow = true;
      g.add(leaf);
      return g;
    }
    case 'sofa': {
      const [w, d] = f.size ?? [2, 0.85];
      g.add(box(w, 0.42, d, M.fabric, 0, 0.21, 0));
      g.add(box(w, 0.5, 0.18, M.fabric, 0, 0.62, -d / 2 + 0.09));
      g.add(box(0.16, 0.25, d, M.fabric, -w / 2 + 0.08, 0.5, 0), box(0.16, 0.25, d, M.fabric, w / 2 - 0.08, 0.5, 0));
      return g;
    }
    case 'billiard': {
      g.add(box(1.4, 0.7, 2.6, M.darkWood, 0, 0.42, 0));
      g.add(box(1.25, 0.03, 2.45, M.felt, 0, 0.785, 0));
      for (const [x, z] of [[-0.6, -1.2], [0.6, -1.2], [-0.6, 1.2], [0.6, 1.2]]) g.add(box(0.12, 0.42, 0.12, M.darkWood, x, 0.21, z));
      const colors = ['#f8fafc', '#facc15', '#2563eb', '#dc2626', '#7c3aed', '#f97316', '#111827'];
      colors.forEach((c, i) => {
        const b = new Mesh(new SphereGeometry(0.03, 10, 8), std(c, 0.2));
        b.position.set(Math.sin(i * 2.1) * 0.35, 0.83, Math.cos(i * 1.3) * 0.8);
        g.add(b);
      });
      return g;
    }
    case 'pingpong': {
      g.add(box(1.525, 0.04, 2.74, M.blueTable, 0, 0.76, 0));
      g.add(box(0.02, 0.005, 2.74, M.white, 0, 0.783, 0));
      g.add(box(1.7, 0.15, 0.02, M.white, 0, 0.855, 0));
      for (const [x, z] of [[-0.65, -1.2], [0.65, -1.2], [-0.65, 1.2], [0.65, 1.2]]) g.add(box(0.05, 0.74, 0.05, M.black, x, 0.37, z));
      return g;
    }
    case 'tvConsole': {
      g.add(box(1.8, 0.45, 0.42, M.darkWood, 0, 0.225, 0));
      g.add(box(0.36, 0.08, 0.28, M.white, 0.5, 0.49, 0));
      g.add(box(1.5, 0.88, 0.05, M.black, 0, 1.2, -0.05));
      const s = new Mesh(new PlaneGeometry(1.42, 0.8), scr);
      s.position.set(0, 1.2, -0.02);
      g.add(s);
      return g;
    }
    case 'bookshelf': {
      g.add(box(1.4, 2, 0.35, M.wood, 0, 1, 0));
      const bookColors = ['#1e3a8a', '#7f1d1d', '#14532d', '#78350f', '#334155'];
      for (let shelf = 0; shelf < 4; shelf++) {
        for (let i = 0; i < 6; i++) {
          g.add(box(0.15, 0.32, 0.05, std(bookColors[(i + shelf) % 5], 0.8), -0.5 + i * 0.2, 0.3 + shelf * 0.45, 0.16, false));
        }
      }
      return g;
    }
    case 'pillar': {
      g.add(box(0.4, FLOOR_Y[1], 0.4, M.wall, 0, FLOOR_Y[1] / 2, 0));
      return g;
    }
    case 'stairs': {
      // Rises along +Z from f.pos up to the upper floor.
      const [w, run] = f.size ?? [3, 9];
      const steps = 16;
      const rise = FLOOR_Y[1] / steps;
      const depth = run / steps;
      for (let i = 0; i < steps; i++) {
        g.add(box(w, rise, depth, M.step, 0, rise * (i + 0.5), depth * (i + 0.5)));
      }
      const len = Math.hypot(run, FLOOR_Y[1]);
      const angle = Math.atan2(FLOOR_Y[1], run);
      for (const x of [-w / 2, w / 2]) {
        const rail = box(0.05, 0.05, len, M.metal, x, FLOOR_Y[1] / 2 + 0.95, run / 2);
        rail.rotation.x = -angle;
        g.add(rail);
      }
      return g;
    }
  }
  return null;
}
