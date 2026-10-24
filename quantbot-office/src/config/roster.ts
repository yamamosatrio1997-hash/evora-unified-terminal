/**
 * Who works in the office. `home` is a spot id from layout.ts.
 * Departments for the leads are editable placeholders — rename freely.
 */

export type Role = 'trader' | 'lead' | 'manager' | 'owner';

export interface Look {
  shirt: string;
  pants: string;
  skin: string;
  hair: string;
  accent: string;
  /** Height multiplier, ~0.95–1.05. */
  build?: number;
  suit?: boolean;
  headset?: boolean;
  hoodie?: boolean;
}

export interface CharacterDef {
  id: string;
  name: string;
  role: Role;
  title: string;
  department?: string;
  home: string;
  look: Look;
}

const SKIN = ['#e8c4a0', '#d9a77f', '#c68e63', '#a8744f', '#8d5e3c', '#f1d2b6'];
const HAIR = ['#1b1b1f', '#2b1d14', '#3d2a1c', '#14110f', '#5a3b22', '#262626'];

const lead = (
  id: string, name: string, department: string, accent: string, seat: number, skin: number, hair: number, build = 1,
): CharacterDef => ({
  id, name, role: 'lead', title: `Lead ${department}`, department, home: `lead-${seat}`,
  look: { shirt: accent, pants: '#2a2f3a', skin: SKIN[skin], hair: HAIR[hair], accent: '#f5f5f5', build },
});

export const LEADS: CharacterDef[] = [
  lead('atlas', 'Atlas', 'Macro Strategy', '#3b82f6', 0, 1, 0, 1.04),
  lead('sage', 'Sage', 'Research & Sentiment', '#22c55e', 1, 0, 2, 0.98),
  lead('cipher', 'Cipher', 'Quant Modeling', '#8b5cf6', 2, 3, 3, 1.0),
  lead('vortex', 'Vortex', 'Execution & Liquidity', '#f97316', 3, 2, 1, 1.02),
  lead('chronos', 'Chronos', 'Timing & Backtest', '#eab308', 4, 4, 5, 0.97),
  lead('alpha', 'Alpha', 'Portfolio & Alpha', '#ef4444', 5, 5, 4, 1.01),
  lead('sentinel', 'Sentinel', 'Risk Management', '#14b8a6', 6, 1, 0, 1.03),
  lead('killjoy', 'Killjoy', 'Compliance & Kill-Switch', '#ec4899', 7, 0, 3, 0.96),
];

export const ODIN: CharacterDef = {
  id: 'odin', name: 'Odin', role: 'manager', title: 'Fund Manager', home: 'odin-seat',
  look: { shirt: '#1e2a44', pants: '#151b2b', skin: SKIN[2], hair: '#9ca3af', accent: '#d4af37', suit: true, build: 1.05 },
};

export const YAMA: CharacterDef = {
  id: 'yama', name: 'Yama', role: 'owner', title: 'Founder · Quantbot', home: 'yama-seat',
  look: { shirt: '#0f172a', pants: '#1f2937', skin: SKIN[1], hair: HAIR[0], accent: '#38bdf8', hoodie: true, build: 1.0 },
};

const TRADER_NAMES = ['Raka', 'Dimas', 'Nadia', 'Bima', 'Sari', 'Fajar', 'Intan', 'Yoga', 'Putri', 'Reza', 'Laras', 'Arief'];

export const TRADERS: CharacterDef[] = TRADER_NAMES.map((name, i) => ({
  id: `trader-${String(i + 1).padStart(2, '0')}`,
  name,
  role: 'trader',
  title: `Desk Trader · Executor ${String(i + 1).padStart(2, '0')}`,
  home: `trader-${i}`,
  look: {
    shirt: ['#cbd5e1', '#94a3b8', '#e2e8f0', '#a5b4c8'][i % 4],
    pants: '#1f2937',
    skin: SKIN[(i * 5) % SKIN.length],
    hair: HAIR[(i * 7) % HAIR.length],
    accent: '#0ea5e9',
    headset: true,
    build: 0.96 + ((i * 3) % 5) * 0.02,
  },
}));

export const ROSTER: CharacterDef[] = [...LEADS, ODIN, YAMA, ...TRADERS];
