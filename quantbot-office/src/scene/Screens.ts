import { CanvasTexture, MeshBasicMaterial, SRGBColorSpace } from 'three';
import { fmtMoney, fmtSigned, type FundState } from '../sim/FundState';

type Kind = 'chart' | 'wall' | 'meeting' | 'dashboard' | 'tv';

interface Screen {
  ctx: CanvasRenderingContext2D;
  tex: CanvasTexture;
  mat: MeshBasicMaterial;
  interval: number;
  acc: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
}

const UP = '#22c55e';
const DOWN = '#ef4444';
const BG = '#070b12';
const FONT = '"JetBrains Mono", ui-monospace, monospace';

/** Animated canvas textures shown on monitors, the trading wall, meeting screen and TV. */
export class Screens {
  /** Shown on top of Yama's dashboard: when Odin's next report is due. */
  nextReport = '--:--';
  private readonly screens = new Map<Kind, Screen>();
  private candles: { o: number; c: number; h: number; l: number }[] = [];
  private tvT = 0;

  constructor(private readonly fund: FundState) {
    let px = 100;
    for (let i = 0; i < 40; i++) px = this.pushCandle(px);
    this.add('chart', 256, 160, 0.25, (c, w, h) => this.drawChart(c, w, h));
    this.add('wall', 1024, 256, 0.5, (c, w, h) => this.drawWall(c, w, h));
    this.add('meeting', 512, 288, 1, (c, w, h) => this.drawMeeting(c, w, h));
    this.add('dashboard', 512, 256, 0.5, (c, w, h) => this.drawDashboard(c, w, h));
    this.add('tv', 256, 144, 0.08, (c, w, h) => this.drawTv(c, w, h));
  }

  material(kind: Kind): MeshBasicMaterial {
    return this.screens.get(kind)!.mat;
  }

  update(dt: number): void {
    this.tvT += dt;
    for (const s of this.screens.values()) {
      s.acc += dt;
      if (s.acc < s.interval) continue;
      s.acc = 0;
      if (s === this.screens.get('chart')) this.pushCandle(this.candles[this.candles.length - 1].c);
      s.draw(s.ctx, s.ctx.canvas.width, s.ctx.canvas.height);
      s.tex.needsUpdate = true;
    }
  }

  private add(kind: Kind, w: number, h: number, interval: number, draw: Screen['draw']): void {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    const mat = new MeshBasicMaterial({ map: tex, toneMapped: false });
    draw(ctx, w, h);
    this.screens.set(kind, { ctx, tex, mat, interval, acc: Math.random() * interval, draw });
  }

  private pushCandle(open: number): number {
    const c = open * (1 + (Math.random() - 0.48) * 0.02);
    this.candles.push({ o: open, c, h: Math.max(open, c) * (1 + Math.random() * 0.006), l: Math.min(open, c) * (1 - Math.random() * 0.006) });
    if (this.candles.length > 40) this.candles.shift();
    return c;
  }

  private drawChart(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#111c2b';
    for (let y = 20; y < h; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    const hi = Math.max(...this.candles.map((c) => c.h));
    const lo = Math.min(...this.candles.map((c) => c.l));
    const y = (v: number) => 22 + (1 - (v - lo) / (hi - lo || 1)) * (h - 30);
    const cw = w / this.candles.length;
    this.candles.forEach((c, i) => {
      ctx.strokeStyle = ctx.fillStyle = c.c >= c.o ? UP : DOWN;
      const x = i * cw + cw / 2;
      ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
      ctx.fillRect(x - cw * 0.3, Math.min(y(c.o), y(c.c)), cw * 0.6, Math.max(1, Math.abs(y(c.o) - y(c.c))));
    });
    ctx.fillStyle = '#94a3b8';
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillText('QB · EXEC 1m', 6, 14);
  }

  private equityLine(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const hist = this.fund.history;
    if (hist.length < 2) return;
    const hi = Math.max(...hist);
    const lo = Math.min(...hist);
    const up = hist[hist.length - 1] >= hist[0];
    ctx.beginPath();
    hist.forEach((v, i) => {
      const px = x + (i / (hist.length - 1)) * w;
      const py = y + (1 - (v - lo) / (hi - lo || 1)) * h;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    });
    ctx.strokeStyle = up ? UP : DOWN;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    ctx.fillStyle = up ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
    ctx.fill();
  }

  private drawWall(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const s = this.fund.snapshot();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#38bdf8';
    ctx.font = `bold 26px ${FONT}`;
    ctx.fillText('QUANTBOT // LIVE BOOK', 24, 40);
    const tiles: [string, string, string][] = [
      ['EQUITY', fmtMoney(s.equity), '#e2e8f0'],
      ['PNL TODAY', fmtSigned(s.pnlToday), s.pnlToday >= 0 ? UP : DOWN],
      ['DRAWDOWN', `${s.drawdownPct.toFixed(2)}%`, s.drawdownPct > 1.5 ? DOWN : '#fbbf24'],
      ['WIN RATE', `${s.winRate.toFixed(0)}%`, '#e2e8f0'],
    ];
    tiles.forEach(([label, value, color], i) => {
      const x = 24 + i * 150;
      ctx.fillStyle = '#64748b';
      ctx.font = `14px ${FONT}`;
      ctx.fillText(label, x, 76);
      ctx.fillStyle = color;
      ctx.font = `bold 22px ${FONT}`;
      ctx.fillText(value, x, 102);
    });
    this.equityLine(ctx, 24, 120, 560, 120);
    ctx.font = `15px ${FONT}`;
    s.positions.slice(0, 6).forEach((p, i) => {
      const y = 76 + i * 28;
      ctx.fillStyle = p.side === 'LONG' ? UP : DOWN;
      ctx.fillText(`${p.side.padEnd(5)} ${p.symbol.padEnd(8)}`, 640, y);
      ctx.fillStyle = p.pnl >= 0 ? UP : DOWN;
      ctx.fillText(fmtSigned(p.pnl).padStart(10), 860, y);
    });
    ctx.fillStyle = '#334155';
    ctx.fillRect(0, h - 26, w, 26);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = `14px ${FONT}`;
    const tape = Object.entries(this.fund.prices).map(([k, v]) => `${k} ${v.toFixed(this.fund.priceDecimals(k))}`).join('   ·   ');
    const offset = (performance.now() / 25) % (w + 400);
    ctx.fillText(tape, w - offset, h - 8);
  }

  private drawMeeting(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const s = this.fund.snapshot();
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#38bdf8';
    ctx.font = `bold 24px ${FONT}`;
    ctx.fillText('DAILY ALPHA SYNC', 24, 40);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = `16px ${FONT}`;
    ['1. Macro & sentiment', '2. Model signals', '3. Execution & risk', '4. Allocation decision'].forEach((t, i) => ctx.fillText(t, 24, 80 + i * 26));
    this.equityLine(ctx, 270, 70, 220, 110);
    ctx.fillStyle = s.pnlToday >= 0 ? UP : DOWN;
    ctx.font = `bold 20px ${FONT}`;
    ctx.fillText(`PnL ${fmtSigned(s.pnlToday)}`, 24, 230);
  }

  private drawDashboard(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const s = this.fund.snapshot();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#38bdf8';
    ctx.font = `bold 20px ${FONT}`;
    ctx.fillText('EVORA · FUND OVERVIEW', 16, 30);
    ctx.fillStyle = '#94a3b8';
    ctx.font = `14px ${FONT}`;
    ctx.fillText(`Next Odin report  ${this.nextReport}`, 16, 54);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = `bold 26px ${FONT}`;
    ctx.fillText(fmtMoney(s.equity), 16, 92);
    ctx.fillStyle = s.pnlToday >= 0 ? UP : DOWN;
    ctx.font = `18px ${FONT}`;
    ctx.fillText(`${fmtSigned(s.pnlToday)}  (${s.pnlPct.toFixed(2)}%)`, 16, 118);
    this.equityLine(ctx, 16, 140, w - 32, 100);
  }

  private drawTv(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const t = this.tvT;
    ctx.fillStyle = '#166534';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    ctx.beginPath(); ctx.moveTo(w / 2, 8); ctx.lineTo(w / 2, h - 8); ctx.stroke();
    ctx.beginPath(); ctx.arc(w / 2, h / 2, 20, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = i < 5 ? '#3b82f6' : '#ef4444';
      const x = w / 2 + Math.sin(t * 0.8 + i * 1.7) * (w * 0.38);
      const y = h / 2 + Math.cos(t * 1.1 + i * 2.3) * (h * 0.35);
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(w / 2 + Math.sin(t * 1.9) * w * 0.4, h / 2 + Math.sin(t * 2.7) * h * 0.3, 3, 0, Math.PI * 2); ctx.fill();
    ctx.font = `bold 12px ${FONT}`;
    ctx.fillText(`QB FC ${Math.floor(t / 37) % 4} - ${Math.floor(t / 53) % 3} EVORA UTD`, 12, 22);
  }
}
