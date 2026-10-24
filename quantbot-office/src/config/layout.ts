/**
 * Office layout: rooms, walls, furniture, walkable nav graph and "spots"
 * (seats / standing points the characters can occupy).
 *
 * Units are metres. +X = east, +Z = south, Y = up. Character heading uses
 * three.js rotation.y, where 0 faces +Z (south) and PI faces -Z (north).
 *
 * Ground floor (y = 0)                     Upper floor (y = 4.2)
 *  z=-16 ┌──────────┬────────┬────────┐
 *        │ Trading  │Meeting │ Odin   │
 *  z=-4  ├──────────┴────────┴────────┤
 *        │          corridor          │
 *  z=0   ├──────────┬──────┬───┬──────┤          ┌──────┬───┬──────┐
 *        │ Leads    │Pantry│St.│Lounge│          │ Yama │ L │ Game │
 *  z=12  └──────────┴──────┴───┴──────┘          └──────┴───┴──────┘
 *       x=-22      -4      8  12     22         -4      8  12     22
 */

export type Vec3 = [number, number, number];
export type FloorId = 0 | 1;
export type Posture = 'stand' | 'sit';

export const FLOOR_Y: Record<FloorId, number> = { 0: 0, 1: 4.2 };

/** Footprint of the upper floor slab (x0, z0, x1, z1) — used to hide it when looking underneath. */
export const UPPER_SLAB: [number, number, number, number] = [-4, 0, 22, 12];

export type RoomId =
  | 'trading' | 'meeting' | 'odin' | 'corridor' | 'leads' | 'pantry'
  | 'stairs' | 'lounge' | 'yama' | 'landing' | 'game';

export interface RoomDef {
  id: RoomId;
  name: string;
  floor: FloorId;
  rect: [number, number, number, number];
  color: string;
  label?: [number, number];
}

export interface WallDef {
  floor: FloorId;
  a: [number, number];
  b: [number, number];
  height: number;
  glass?: boolean;
}

export type FurnitureType =
  | 'traderDesk' | 'leadDesk' | 'execDesk' | 'chair' | 'meetingTable' | 'wallScreen'
  | 'counter' | 'coffeeMachine' | 'fridge' | 'highTable' | 'whiteboard' | 'plant'
  | 'sofa' | 'billiard' | 'pingpong' | 'tvConsole' | 'bookshelf' | 'pillar' | 'stairs';

export interface FurnitureDef {
  type: FurnitureType;
  pos: Vec3;
  rot?: number;
  size?: [number, number];
  /** Spot id of the seat that belongs to this desk (used for name plates). */
  seat?: string;
  screen?: 'chart' | 'wall' | 'meeting' | 'dashboard' | 'tv';
}

export interface NavNodeDef {
  id: string;
  pos: Vec3;
}

export interface SpotDef {
  id: string;
  pos: Vec3;
  facing: number;
  posture: Posture;
  /** Nav node this spot is reached from. */
  node: string;
  /** Optional intermediate point between the node and the spot (to walk around furniture). */
  approach?: Vec3;
  room: RoomId;
  tags: string[];
  /** Spots sharing a group form one conversation cluster (same table, same game...). */
  group?: string;
}

export interface OfficeLayout {
  rooms: RoomDef[];
  walls: WallDef[];
  furniture: FurnitureDef[];
  nodes: NavNodeDef[];
  edges: [string, string][];
  spots: SpotDef[];
}

export const FACE = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 } as const;

/** Heading that looks from `from` toward `to` (x, z pairs). */
export const headingTo = (from: [number, number], to: [number, number]): number =>
  Math.atan2(to[0] - from[0], to[1] - from[1]);

const g = (x: number, z: number): Vec3 => [x, FLOOR_Y[0], z];
const u = (x: number, z: number): Vec3 => [x, FLOOR_Y[1], z];

function buildLayout(): OfficeLayout {
  const rooms: RoomDef[] = [
    { id: 'trading', name: 'TRADING FLOOR', floor: 0, rect: [-22, -16, -4, -4], color: '#1d232c' },
    { id: 'meeting', name: 'MEETING ROOM', floor: 0, rect: [-4, -16, 8, -4], color: '#2a2833' },
    { id: 'odin', name: 'FUND MANAGER · ODIN', floor: 0, rect: [8, -16, 22, -4], color: '#2e2924' },
    { id: 'corridor', name: '', floor: 0, rect: [-22, -4, 22, 0], color: '#2d3139' },
    { id: 'leads', name: 'DEPARTMENT LEADS', floor: 0, rect: [-22, 0, -4, 12], color: '#232a33' },
    { id: 'pantry', name: 'PANTRY', floor: 0, rect: [-4, 0, 8, 12], color: '#3a332c' },
    { id: 'stairs', name: '', floor: 0, rect: [8, 0, 12, 12], color: '#2d3139' },
    { id: 'lounge', name: 'LOUNGE · DISCUSSION', floor: 0, rect: [12, 0, 22, 12], color: '#26302d' },
    { id: 'yama', name: "YAMA'S OFFICE", floor: 1, rect: [-4, 0, 8, 12], color: '#30291f' },
    { id: 'landing', name: '', floor: 1, rect: [8, 10, 12, 12], color: '#2d3139' },
    { id: 'game', name: 'GAME ROOM', floor: 1, rect: [12, 0, 22, 12], color: '#2a2238' },
  ];

  const walls: WallDef[] = [];
  /** Axis-aligned wall from a to b with door gaps centred at `doors` (coordinate along the wall). */
  const wall = (
    floor: FloorId, a: [number, number], b: [number, number], height: number,
    opts: { glass?: boolean; doors?: number[]; doorWidth?: number } = {},
  ) => {
    const horizontal = a[1] === b[1];
    const [start, end] = horizontal ? [Math.min(a[0], b[0]), Math.max(a[0], b[0])] : [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    const half = (opts.doorWidth ?? 1.6) / 2;
    const push = (s: number, e: number) => walls.push({
      floor, height, glass: opts.glass,
      a: horizontal ? [s, a[1]] : [a[0], s],
      b: horizontal ? [e, a[1]] : [a[0], e],
    });
    let cursor = start;
    for (const d of [...(opts.doors ?? [])].sort((x, y) => x - y)) {
      if (d - half > cursor) push(cursor, d - half);
      cursor = d + half;
    }
    if (end > cursor) push(cursor, end);
  };

  // Ground floor shell: tall walls at the back (north/west), low walls toward the camera.
  wall(0, [-22, -16], [22, -16], 3.2);
  wall(0, [-22, -16], [-22, 12], 3.2);
  wall(0, [22, -16], [22, 12], 1.0);
  wall(0, [-22, 12], [22, 12], 1.0);
  // North row partitions
  wall(0, [-22, -4], [-4, -4], 1.0, { doors: [-13, -6] });
  wall(0, [-4, -16], [-4, -4], 2.6, { glass: true });
  wall(0, [-4, -4], [8, -4], 2.6, { glass: true, doors: [2] });
  wall(0, [8, -16], [8, -4], 2.6, { glass: true });
  wall(0, [8, -4], [22, -4], 2.6, { glass: true, doors: [14] });
  // South row partitions
  wall(0, [-22, 0], [-4, 0], 1.0, { doors: [-13, -6] });
  wall(0, [-4, 0], [8, 0], 1.0, { doors: [2] });
  wall(0, [12, 0], [22, 0], 1.0, { doors: [17], doorWidth: 2.4 });
  wall(0, [-4, 0], [-4, 12], 1.0);
  wall(0, [8, 0], [8, 12], 1.0);
  wall(0, [12, 0], [12, 12], 1.0);
  // Upper floor
  wall(1, [-4, 0], [8, 0], 1.1, { glass: true });
  wall(1, [-4, 0], [-4, 12], 2.6, { glass: true });
  wall(1, [-4, 12], [22, 12], 2.6, { glass: true });
  wall(1, [8, 0], [8, 12], 2.6, { glass: true, doors: [11] });
  wall(1, [12, 0], [12, 12], 2.6, { glass: true, doors: [11] });
  wall(1, [8, 0], [12, 0], 1.1, { glass: true });
  wall(1, [12, 0], [22, 0], 1.1, { glass: true });
  wall(1, [22, 0], [22, 12], 1.1, { glass: true });

  const furniture: FurnitureDef[] = [];
  const nodes: NavNodeDef[] = [];
  const edges: [string, string][] = [];
  const spots: SpotDef[] = [];

  const node = (id: string, pos: Vec3) => { nodes.push({ id, pos }); return id; };
  const chain = (...ids: string[]) => { for (let i = 1; i < ids.length; i++) edges.push([ids[i - 1], ids[i]]); };
  const spot = (s: SpotDef) => { spots.push(s); return s; };
  /** A seat spot; also places a chair unless `chair: false`. */
  const seat = (s: Omit<SpotDef, 'posture'>, chair = true) => {
    spot({ ...s, posture: 'sit' });
    if (chair) furniture.push({ type: 'chair', pos: s.pos, rot: s.facing });
  };
  /** Standing spots around a round table at (cx, cz). */
  const tableSpots = (
    group: string, room: RoomId, tags: string[], cx: number, cz: number, y: number,
    sides: Partial<Record<'W' | 'E' | 'N' | 'S', string>>,
  ) => {
    const dirs = { W: [-1, 0], E: [1, 0], N: [0, -1], S: [0, 1] } as const;
    for (const [side, nodeId] of Object.entries(sides) as ['W' | 'E' | 'N' | 'S', string][]) {
      const [dx, dz] = dirs[side];
      const pos: Vec3 = [cx + dx * 0.85, y, cz + dz * 0.85];
      spot({
        id: `${group}-${side}`, pos, posture: 'stand', node: nodeId, room, tags, group,
        facing: headingTo([pos[0], pos[2]], [cx, cz]),
        approach: [cx + dx * 1.6, y, cz + dz * 1.6],
      });
    }
  };

  // ── Corridor spine ──────────────────────────────────────────────
  const CX = [-21, -13, -6, 2, 10, 14, 17, 21];
  CX.forEach((x) => node(`C_${x}`, g(x, -2)));
  chain(...CX.map((x) => `C_${x}`));

  // Standing-chat spots along the corridor (pairs, kept off the walking line).
  const corridorPair = (group: string, x: number, z: number, nodeId: string) => {
    const a: Vec3 = g(x - 0.55, z);
    const b: Vec3 = g(x + 0.55, z);
    spot({ id: `${group}-a`, pos: a, facing: FACE.E, posture: 'stand', node: nodeId, room: 'corridor', tags: ['corridor'], group });
    spot({ id: `${group}-b`, pos: b, facing: FACE.W, posture: 'stand', node: nodeId, room: 'corridor', tags: ['corridor'], group });
  };
  corridorPair('corridor-a', -9.5, -2.9, 'C_-6');
  corridorPair('corridor-b', 6, -2.9, 'C_2');
  corridorPair('corridor-c', 19.5, -1.1, 'C_17');

  // ── Trading floor: 3 rows x 4 executor desks ────────────────────
  const TF_ROWS = [-14, -10.5, -7];
  const TF_COLS = [-19, -15, -11, -7];
  const TF_AISLE_X = [-21, -19, -15, -13, -11, -7, -5];
  TF_ROWS.forEach((zDesk, r) => {
    TF_AISLE_X.forEach((x) => node(`TF_${r}_${x}`, g(x, zDesk + 1.8)));
    chain(...TF_AISLE_X.map((x) => `TF_${r}_${x}`));
    if (r > 0) {
      edges.push([`TF_${r - 1}_-21`, `TF_${r}_-21`], [`TF_${r - 1}_-5`, `TF_${r}_-5`]);
    }
    TF_COLS.forEach((x, c) => {
      const idx = r * TF_COLS.length + c;
      const id = `trader-${idx}`;
      const seatPos = g(x, zDesk + 0.9);
      furniture.push({ type: 'traderDesk', pos: g(x, zDesk), rot: FACE.N, seat: id, screen: 'chart' });
      seat({ id, pos: seatPos, facing: FACE.N, node: `TF_${r}_${x}`, room: 'trading', tags: ['trader-seat'] });
      const standPos = g(x + 1.1, zDesk + 1.25);
      spot({
        id: `${id}-instruct`, pos: standPos, posture: 'stand', node: `TF_${r}_${x}`, room: 'trading',
        tags: ['instruct'], facing: headingTo([standPos[0], standPos[2]], [seatPos[0], seatPos[2]]),
      });
    });
  });
  node('TF_front', g(-13, -15));
  chain('TF_front', 'TF_0_-13');
  spot({ id: 'tf-brief', pos: g(-13, -15), facing: FACE.S, posture: 'stand', node: 'TF_front', room: 'trading', tags: ['tf-brief'] });
  node('D_TF1', g(-13, -4));
  node('D_TF2', g(-6, -4));
  chain('C_-13', 'D_TF1', 'TF_2_-13');
  chain('C_-6', 'D_TF2', 'TF_2_-7');
  chain('D_TF2', 'TF_2_-5');
  furniture.push(
    { type: 'wallScreen', pos: [-13, 1.9, -15.85], rot: FACE.S, size: [10, 2.4], screen: 'wall' },
    { type: 'plant', pos: g(-21.2, -15.2) },
    { type: 'plant', pos: g(-4.8, -15.2) },
  );

  // ── Meeting room: Odin at the head, 8 lead chairs ───────────────
  node('D_MR', g(2, -4));
  node('MR_in', g(2, -5.3));
  node('MR_L0', g(-1, -6.5));
  node('MR_L1', g(-1, -14.8));
  node('MR_H', g(2, -15.1));
  node('MR_R1', g(5, -14.8));
  node('MR_R0', g(5, -6.5));
  chain('C_2', 'D_MR', 'MR_in');
  chain('MR_in', 'MR_L0', 'MR_L1', 'MR_H', 'MR_R1', 'MR_R0', 'MR_in');
  furniture.push(
    { type: 'meetingTable', pos: g(2, -10.5), size: [2.2, 6] },
    { type: 'wallScreen', pos: [2, 1.7, -15.85], rot: FACE.S, size: [4, 2.1], screen: 'meeting' },
    { type: 'plant', pos: g(-3.2, -15.2) },
    { type: 'plant', pos: g(7.2, -4.8) },
  );
  seat({ id: 'meeting-head', pos: g(2, -14.3), facing: FACE.S, node: 'MR_H', room: 'meeting', tags: ['meeting-head'] });
  [-12.6, -11.2, -9.8, -8.4].forEach((z, i) => {
    seat({ id: `meeting-L${i}`, pos: g(0.35, z), facing: FACE.E, node: 'MR_L0', approach: g(-0.6, z), room: 'meeting', tags: ['meeting-chair'] });
    seat({ id: `meeting-R${i}`, pos: g(3.65, z), facing: FACE.W, node: 'MR_R0', approach: g(4.6, z), room: 'meeting', tags: ['meeting-chair'] });
  });

  // ── Odin's office ──────────────────────────────────────────────
  node('D_OD', g(14, -4));
  node('OD_in', g(14, -5.5));
  node('OD_side', g(12, -12.1));
  chain('C_14', 'D_OD', 'OD_in', 'OD_side');
  seat({ id: 'odin-seat', pos: g(15, -12.1), facing: FACE.S, node: 'OD_side', room: 'odin', tags: ['odin-seat'] });
  furniture.push(
    { type: 'execDesk', pos: g(15, -11.2), rot: FACE.S, seat: 'odin-seat', screen: 'dashboard' },
    { type: 'bookshelf', pos: g(15, -15.7), rot: FACE.S },
    { type: 'bookshelf', pos: g(18, -15.7), rot: FACE.S },
    { type: 'sofa', pos: g(20.8, -8.5), rot: FACE.W, size: [2.2, 0.85] },
    { type: 'plant', pos: g(21.2, -15.2) },
    { type: 'plant', pos: g(9, -15.2) },
  );

  // ── Department leads: 2 rows x 4 desks ─────────────────────────
  const LD_ROWS = [4, 9.5];
  const LD_COLS = [-19, -15, -11, -7];
  const LD_AISLE_X = [-21, -19, -15, -13, -11, -7, -6, -5];
  LD_ROWS.forEach((zDesk, r) => {
    LD_AISLE_X.forEach((x) => node(`LD_${r}_${x}`, g(x, zDesk - 2)));
    chain(...LD_AISLE_X.map((x) => `LD_${r}_${x}`));
    if (r > 0) edges.push([`LD_${r - 1}_-21`, `LD_${r}_-21`], [`LD_${r - 1}_-5`, `LD_${r}_-5`]);
    LD_COLS.forEach((x, c) => {
      const idx = r * LD_COLS.length + c;
      const id = `lead-${idx}`;
      const seatPos = g(x, zDesk - 0.9);
      furniture.push({ type: 'leadDesk', pos: g(x, zDesk), rot: FACE.S, seat: id, screen: 'chart' });
      seat({ id, pos: seatPos, facing: FACE.S, node: `LD_${r}_${x}`, room: 'leads', tags: ['lead-seat'] });
      const visit = g(x + 1.05, zDesk - 1.55);
      spot({
        id: `${id}-visit`, pos: visit, posture: 'stand', node: `LD_${r}_${x}`, room: 'leads', tags: ['desk-visit'],
        facing: headingTo([visit[0], visit[2]], [seatPos[0], seatPos[2]]),
      });
    });
  });
  node('D_LD1', g(-13, 0));
  node('D_LD2', g(-6, 0));
  chain('C_-13', 'D_LD1', 'LD_0_-13');
  chain('C_-6', 'D_LD2', 'LD_0_-6');
  furniture.push(
    { type: 'plant', pos: g(-21.2, 11.2) },
    { type: 'plant', pos: g(-4.8, 11.2) },
    { type: 'bookshelf', pos: g(-21.7, 6.5), rot: FACE.E },
  );

  // ── Pantry ─────────────────────────────────────────────────────
  node('D_PT', g(2, 0));
  node('PT_in', g(2, 1.5));
  node('PT_c', g(2, 8.5));
  chain('C_2', 'D_PT', 'PT_in', 'PT_c');
  furniture.push(
    { type: 'counter', pos: g(-0.5, 11.45), size: [6, 0.7] },
    { type: 'coffeeMachine', pos: [-2.3, 0.9, 11.5] },
    { type: 'fridge', pos: g(4.3, 11.5) },
    { type: 'highTable', pos: g(0, 5.5) },
    { type: 'highTable', pos: g(5, 7.5) },
    { type: 'plant', pos: g(7.2, 0.8) },
  );
  [[-2.3, 'pantry-coffee'], [-0.5, 'pantry-counter-2'], [1.3, 'pantry-counter-3']].forEach(([x, id]) => {
    spot({ id: id as string, pos: g(x as number, 10.5), facing: FACE.S, posture: 'stand', node: 'PT_c', room: 'pantry', tags: ['pantry-counter'], group: 'pantry-counter' });
  });
  tableSpots('pantry-A', 'pantry', ['pantry-table'], 0, 5.5, 0, { W: 'PT_c', E: 'PT_c', N: 'PT_in', S: 'PT_c' });
  tableSpots('pantry-B', 'pantry', ['pantry-table'], 5, 7.5, 0, { W: 'PT_c', E: 'PT_in', N: 'PT_in', S: 'PT_c' });

  // ── Stairs to the upper floor ──────────────────────────────────
  node('ST_b', g(10, 0.6));
  node('ST_t', u(10, 9.6));
  node('UP_land', u(10, 11));
  chain('C_10', 'ST_b', 'ST_t', 'UP_land');
  furniture.push({ type: 'stairs', pos: g(10, 0.6), size: [3, 9] });

  // ── Lounge: standing discussions between leads ─────────────────
  node('D_LG', g(17, 0));
  node('LG_in', g(17, 1.5));
  node('LG_c', g(17, 6.5));
  chain('C_17', 'D_LG', 'LG_in', 'LG_c');
  furniture.push(
    { type: 'highTable', pos: g(14.8, 4.2) },
    { type: 'highTable', pos: g(19.2, 9.3) },
    { type: 'whiteboard', pos: g(21.6, 5), rot: FACE.W },
    { type: 'plant', pos: g(12.8, 11.2) },
    { type: 'plant', pos: g(21.2, 0.8) },
  );
  tableSpots('lounge-1', 'lounge', ['lounge-table'], 14.8, 4.2, 0, { W: 'LG_c', E: 'LG_in', N: 'LG_in', S: 'LG_c' });
  tableSpots('lounge-2', 'lounge', ['lounge-table'], 19.2, 9.3, 0, { W: 'LG_c', E: 'LG_c', N: 'LG_c', S: 'LG_c' });
  ([[20.6, 4.2], [20.6, 5.8], [19.4, 5]] as [number, number][]).forEach(([x, z], i) => {
    spot({
      id: `whiteboard-${i}`, pos: g(x, z), posture: 'stand', node: 'LG_c', room: 'lounge',
      tags: ['whiteboard'], group: 'whiteboard', facing: i === 2 ? FACE.E : headingTo([x, z], [21.6, 5]),
    });
  });

  // Pillars carrying the upper slab
  [-3.8, 7.8, 12.2, 21.8].forEach((x) => furniture.push({ type: 'pillar', pos: g(x, 0.2) }));

  // ── Upper floor: Yama's office ─────────────────────────────────
  node('D_YO', u(8, 11));
  node('YO_c', u(4.5, 8.5));
  node('YO_f', u(4.5, 2.5));
  chain('UP_land', 'D_YO', 'YO_c', 'YO_f');
  seat({ id: 'yama-seat', pos: u(2, 4.9), facing: FACE.N, node: 'YO_c', approach: u(2, 6.3), room: 'yama', tags: ['yama-seat'] });
  spot({ id: 'yama-report', pos: u(2, 2.5), facing: FACE.S, posture: 'stand', node: 'YO_f', room: 'yama', tags: ['yama-report'] });
  furniture.push(
    { type: 'execDesk', pos: u(2, 4.0), rot: FACE.N, seat: 'yama-seat', screen: 'dashboard' },
    { type: 'sofa', pos: u(-2.8, 9), rot: FACE.E, size: [2.2, 0.85] },
    { type: 'bookshelf', pos: u(-3.7, 4.5), rot: FACE.E },
    { type: 'plant', pos: u(-3.2, 0.8) },
    { type: 'plant', pos: u(7.2, 11.2) },
  );

  // ── Upper floor: game room ─────────────────────────────────────
  node('D_GR', u(12, 11));
  node('GR_c', u(16.6, 7.4));
  node('GR_s', u(16.8, 1.2));
  chain('UP_land', 'D_GR', 'GR_c', 'GR_s');
  furniture.push(
    { type: 'billiard', pos: u(14.8, 3.6) },
    { type: 'pingpong', pos: u(19.7, 4) },
    { type: 'sofa', pos: u(18.6, 9.6), rot: FACE.E, size: [2.2, 0.85] },
    { type: 'tvConsole', pos: u(21.4, 9.6), rot: FACE.W, screen: 'tv' },
    { type: 'plant', pos: u(12.8, 0.8) },
  );
  spot({ id: 'billiard-a', pos: u(14.8, 1.5), facing: FACE.S, posture: 'stand', node: 'GR_s', room: 'game', tags: ['billiard'], group: 'billiard' });
  spot({ id: 'billiard-b', pos: u(14.8, 5.7), facing: FACE.N, posture: 'stand', node: 'GR_c', room: 'game', tags: ['billiard'], group: 'billiard' });
  spot({ id: 'pingpong-a', pos: u(19.7, 1.5), facing: FACE.S, posture: 'stand', node: 'GR_s', room: 'game', tags: ['pingpong'], group: 'pingpong' });
  spot({ id: 'pingpong-b', pos: u(19.7, 6.5), facing: FACE.N, posture: 'stand', node: 'GR_c', room: 'game', tags: ['pingpong'], group: 'pingpong' });
  seat({ id: 'ps-1', pos: u(18.65, 9.1), facing: FACE.E, node: 'GR_c', approach: u(17.7, 9.1), room: 'game', tags: ['ps'], group: 'ps' }, false);
  seat({ id: 'ps-2', pos: u(18.65, 10.1), facing: FACE.E, node: 'GR_c', approach: u(17.7, 10.1), room: 'game', tags: ['ps'], group: 'ps' }, false);

  return { rooms, walls, furniture, nodes, edges, spots };
}

export const LAYOUT: OfficeLayout = buildLayout();
