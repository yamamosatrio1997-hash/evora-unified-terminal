import { chance, pick, rand } from '../core/random';

export type Side = 'LONG' | 'SHORT';

export interface Position {
  symbol: string;
  side: Side;
  size: number;
  entry: number;
}

export interface FundSnapshot {
  equity: number;
  startOfDay: number;
  pnlToday: number;
  pnlPct: number;
  drawdownPct: number;
  winRate: number;
  confidence: number;
  slippageBps: number;
  volatility: number;
  positions: (Position & { pnl: number })[];
}

/** Partial update pushed from a real Quantbot backend (see bridge/EventBridge.ts). */
export interface FundUpdate {
  equity?: number;
  startOfDay?: number;
  winRate?: number;
  confidence?: number;
  slippageBps?: number;
  volatility?: number;
  drawdownPct?: number;
  prices?: Record<string, number>;
  positions?: Position[];
}

const UNIVERSE: Record<string, { price: number; vol: number; mult: number; decimals: number }> = {
  BTCUSDT: { price: 67250, vol: 0.0009, mult: 1, decimals: 1 },
  ETHUSDT: { price: 3420, vol: 0.0011, mult: 10, decimals: 2 },
  SOLUSDT: { price: 162.4, vol: 0.0015, mult: 200, decimals: 2 },
  XAUUSD: { price: 2398.5, vol: 0.0004, mult: 100, decimals: 2 },
  EURUSD: { price: 1.0842, vol: 0.0002, mult: 100000, decimals: 5 },
  NAS100: { price: 19840, vol: 0.0005, mult: 10, decimals: 1 },
  USDJPY: { price: 151.32, vol: 0.0003, mult: 1000, decimals: 3 },
};

export const SYMBOLS = Object.keys(UNIVERSE);

/**
 * Simulated fund book. Drives the screens and the numbers Odin reports to Yama.
 * Once real data arrives through `apply()`, the random walk stops overriding it.
 */
export class FundState {
  prices: Record<string, number> = Object.fromEntries(SYMBOLS.map((s) => [s, UNIVERSE[s].price]));
  positions: Position[] = [];
  history: number[] = [];
  startOfDay = 1_000_000;
  realized = 0;
  peak = 1_000_000;
  winRate = 61;
  confidence = 74;
  slippageBps = 1.2;
  volatility = 0.4;
  external = false;
  private externalEquity: number | null = null;
  private externalDrawdown: number | null = null;
  private acc = 0;

  constructor() {
    for (const symbol of ['BTCUSDT', 'XAUUSD', 'ETHUSDT']) this.openRandom(symbol);
    for (let i = 0; i < 120; i++) this.step();
  }

  priceDecimals(symbol: string): number {
    return UNIVERSE[symbol]?.decimals ?? 2;
  }

  positionPnl(p: Position): number {
    const mult = UNIVERSE[p.symbol]?.mult ?? 1;
    const px = this.prices[p.symbol] ?? p.entry;
    return (px - p.entry) * p.size * mult * (p.side === 'LONG' ? 1 : -1);
  }

  get equity(): number {
    if (this.externalEquity !== null) return this.externalEquity;
    return this.startOfDay + this.realized + this.positions.reduce((s, p) => s + this.positionPnl(p), 0);
  }

  /** Advance the simulation by `dt` seconds of animation time. */
  tick(dt: number): void {
    if (this.external) return;
    this.acc += dt;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.step();
    }
  }

  apply(update: FundUpdate): void {
    this.external = true;
    if (update.prices) Object.assign(this.prices, update.prices);
    if (update.positions) this.positions = update.positions.map((p) => ({ ...p }));
    if (update.startOfDay !== undefined) this.startOfDay = update.startOfDay;
    if (update.equity !== undefined) this.externalEquity = update.equity;
    if (update.winRate !== undefined) this.winRate = update.winRate;
    if (update.confidence !== undefined) this.confidence = update.confidence;
    if (update.slippageBps !== undefined) this.slippageBps = update.slippageBps;
    if (update.volatility !== undefined) this.volatility = update.volatility;
    if (update.drawdownPct !== undefined) this.externalDrawdown = update.drawdownPct;
    this.record();
  }

  snapshot(): FundSnapshot {
    const equity = this.equity;
    const pnlToday = equity - this.startOfDay;
    return {
      equity,
      startOfDay: this.startOfDay,
      pnlToday,
      pnlPct: (pnlToday / this.startOfDay) * 100,
      drawdownPct: this.externalDrawdown ?? Math.max(0, ((this.peak - equity) / this.peak) * 100),
      winRate: this.winRate,
      confidence: this.confidence,
      slippageBps: this.slippageBps,
      volatility: this.volatility,
      positions: this.positions.map((p) => ({ ...p, pnl: this.positionPnl(p) })),
    };
  }

  /** Market is "quiet" when volatility is low — leads are more likely to take a game break. */
  get quiet(): boolean {
    return this.volatility < 0.35;
  }

  private step(): void {
    this.volatility = Math.min(1, Math.max(0.05, this.volatility + rand(-0.02, 0.02)));
    for (const s of SYMBOLS) {
      const { vol } = UNIVERSE[s];
      this.prices[s] *= 1 + rand(-1, 1.04) * vol * (0.5 + this.volatility);
    }
    if (chance(0.01) && this.positions.length > 1) {
      const closed = this.positions.splice(Math.floor(Math.random() * this.positions.length), 1)[0];
      const pnl = this.positionPnl(closed);
      this.realized += pnl;
      this.winRate = Math.round(Math.min(78, Math.max(45, this.winRate + (pnl > 0 ? 0.6 : -0.6))));
    }
    if (chance(0.012) && this.positions.length < 6) {
      const free = SYMBOLS.filter((s) => !this.positions.some((p) => p.symbol === s));
      if (free.length) this.openRandom(pick(free));
    }
    this.confidence = Math.round(Math.min(93, Math.max(55, this.confidence + rand(-1, 1))));
    this.slippageBps = Math.round(Math.min(4, Math.max(0.3, this.slippageBps + rand(-0.1, 0.1))) * 10) / 10;
    this.record();
  }

  private openRandom(symbol: string): void {
    const notional = rand(60_000, 220_000);
    const mult = UNIVERSE[symbol].mult;
    const size = Math.max(0.01, Math.round((notional / (this.prices[symbol] * mult)) * 100) / 100);
    this.positions.push({ symbol, side: chance(0.65) ? 'LONG' : 'SHORT', size, entry: this.prices[symbol] });
  }

  private record(): void {
    const eq = this.equity;
    this.peak = Math.max(this.peak, eq);
    this.history.push(eq);
    if (this.history.length > 240) this.history.shift();
  }
}

export const fmtMoney = (v: number): string =>
  `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export const fmtSigned = (v: number): string => `${v >= 0 ? '+' : '-'}${fmtMoney(Math.abs(v))}`;
