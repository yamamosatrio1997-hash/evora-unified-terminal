import type { ReactNode } from "react";
import { AGENTS, BY_ROLE, MascotShape } from "./Mascot";

export interface FloorAgent { state: string; active: boolean; bubble?: string | null }
export interface WallCandle { o: number; h: number; l: number; c: number }

const LED: Record<string, string> = {
  idle: "#475569", completed: "#34D399", warning: "#FACC15", error: "#F87171", veto: "#F87171",
  analyzing: "#22D3EE", exchanging: "#22D3EE", challenging: "#FB923C", quant_review: "#F472B6", risk_review: "#34D399", waiting: "#94a3b8",
};

const SCREEN_KIND: Record<string, [string, string, string]> = {
  macro: ["list", "map", "list"], fundamental: ["list", "doc", "list"], onchain: ["blocks", "bars", "list"],
  flow: ["bars", "flow", "list"], technical: ["list", "candles", "line"], quant: ["bars", "bars", "donut"],
  risk: ["gauge", "list", "alert"], critic: ["alert", "list", "checks"], fund_manager: ["checks", "flowchart", "checks"],
};

function seeded(i: number) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function Screen({ kind, x, y, w, h, color, live, seed }: { kind: string; x: number; y: number; w: number; h: number; color: string; live: boolean; seed: number }) {
  const ink = live ? color : "#3f8f6b";
  const els: ReactNode[] = [];
  const ix = x + 1.5, iy = y + 1.5, iw = w - 3, ih = h - 3;
  if (kind === "candles" || kind === "bars") {
    const n = Math.floor(iw / 2);
    for (let i = 0; i < n; i++) {
      const v = 0.25 + seeded(seed + i) * 0.7;
      const bh = Math.max(1, Math.round(v * ih));
      const up = kind === "bars" || seeded(seed * 3 + i) > 0.42;
      els.push(<rect key={i} x={ix + i * 2} y={iy + ih - bh} width={1} height={bh} fill={kind === "bars" ? ink : up ? "#34D399" : "#F87171"} />);
    }
  } else if (kind === "line" || kind === "flow") {
    let py = iy + ih / 2;
    for (let i = 0; i < iw; i += 1) {
      py = Math.max(iy, Math.min(iy + ih - 1, py + (seeded(seed + i) - 0.48) * 2));
      els.push(<rect key={i} x={ix + i} y={Math.round(py)} width={1} height={1} fill={ink} />);
    }
  } else if (kind === "map" || kind === "blocks") {
    for (let i = 0; i < iw; i += 2) for (let j = 0; j < ih; j += 2) {
      if (seeded(seed + i * 7 + j) > (kind === "map" ? 0.55 : 0.4)) els.push(<rect key={`${i}-${j}`} x={ix + i} y={iy + j} width={kind === "map" ? 1 : 1.5} height={kind === "map" ? 1 : 1.5} fill={ink} />);
    }
  } else if (kind === "donut" || kind === "gauge") {
    const cx = x + w / 2, cy = y + h / 2, r = Math.min(iw, ih) / 2 - 0.5;
    els.push(<circle key="d" cx={cx} cy={cy} r={r} fill="none" stroke="#1e3a2f" strokeWidth={1.4} />);
    els.push(<circle key="e" cx={cx} cy={cy} r={r} fill="none" stroke={kind === "gauge" ? "#34D399" : ink} strokeWidth={1.4}
      strokeDasharray={`${r * 4} ${r * 7}`} transform={`rotate(-90 ${cx} ${cy})`} />);
  } else if (kind === "alert") {
    for (let j = 0; j < ih - 1; j += 2) els.push(<rect key={j} x={ix} y={iy + j} width={iw * (0.5 + seeded(seed + j) * 0.5)} height={1} fill={j % 4 ? "#F87171" : ink} />);
  } else if (kind === "checks" || kind === "flowchart") {
    if (kind === "flowchart") {
      els.push(<rect key="a" x={x + w / 2 - 2} y={iy} width={4} height={2} fill="none" stroke={ink} strokeWidth={0.6} />);
      els.push(<rect key="b" x={ix + 1} y={iy + ih - 3} width={4} height={2} fill="none" stroke={ink} strokeWidth={0.6} />);
      els.push(<rect key="c" x={ix + iw - 5} y={iy + ih - 3} width={4} height={2} fill="none" stroke={ink} strokeWidth={0.6} />);
      els.push(<path key="p" d={`M${x + w / 2} ${iy + 2}V${iy + ih / 2}H${ix + 3}V${iy + ih - 3}M${x + w / 2} ${iy + ih / 2}H${ix + iw - 3}V${iy + ih - 3}`} stroke={ink} strokeWidth={0.5} fill="none" />);
    } else {
      for (let j = 0; j < ih - 1; j += 3) { els.push(<rect key={`c${j}`} x={ix} y={iy + j} width={2} height={2} fill="none" stroke={ink} strokeWidth={0.5} />); els.push(<rect key={`l${j}`} x={ix + 3} y={iy + j + 0.5} width={iw - 4} height={1} fill={ink} opacity={0.7} />); }
    }
  } else {
    for (let j = 0; j < ih; j += 2) els.push(<rect key={j} x={ix} y={iy + j} width={iw * (0.35 + seeded(seed + j) * 0.65)} height={1} fill={ink} opacity={kind === "doc" ? 0.9 : 0.75} />);
  }
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill="#1f2937" />
      <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} fill="#06110d" />
      <g className={live ? "screen-live" : undefined}>{els}</g>
      {live && <rect className="screen-scan" x={x + 0.5} y={y + 0.5} width={1} height={h - 1} fill={color} opacity={0.35} />}
    </g>
  );
}

function Desk({ role, agent, onSelect }: { role: string; agent: FloorAgent; onSelect?: (r: string) => void }) {
  const p = BY_ROLE[role];
  const kinds = SCREEN_KIND[role];
  const seed = AGENTS.findIndex((a) => a.role === role) * 31 + 7;
  return (
    <button type="button" className={`desk${agent.active ? " desk-active" : ""}`} onClick={() => onSelect?.(role)}
      aria-label={`${p.name}, ${p.title}: ${agent.state}`} style={{ ["--agent" as string]: p.color }}>
      {agent.bubble && <span className="bubble" key={agent.bubble}>{agent.bubble}</span>}
      <svg viewBox="0 0 64 42" shapeRendering="crispEdges" className="desk-svg" aria-hidden>
        <Screen kind={kinds[0]} x={3} y={3} w={17} h={13} color={p.color} live={agent.active} seed={seed} />
        <Screen kind={kinds[1]} x={22} y={1} w={20} h={15} color={p.color} live={agent.active} seed={seed + 50} />
        <Screen kind={kinds[2]} x={44} y={3} w={17} h={13} color={p.color} live={agent.active} seed={seed + 99} />
        <rect x={11} y={16} width={1} height={4} fill="#1f2937" /><rect x={31} y={16} width={2} height={4} fill="#1f2937" /><rect x={52} y={16} width={1} height={4} fill="#1f2937" />
        <MascotShape role={role} x={24} y={13} active={agent.active} />
        <rect x={1} y={26} width={62} height={2} fill="#4b5563" />
        <rect x={1} y={28} width={62} height={6} fill="#2b3442" />
        <rect x={4} y={34} width={2} height={7} fill="#1f2937" /><rect x={58} y={34} width={2} height={7} fill="#1f2937" />
        <rect x={20} y={24} width={14} height={2} fill="#111827" /><rect x={21} y={24.5} width={12} height={1} fill="#374151" />
        <rect x={8} y={23} width={3} height={3} fill="#e5e7eb" /><rect x={11} y={24} width={1} height={1} fill="#e5e7eb" />
        <rect x={46} y={24} width={7} height={2} fill="#9ca3af" />
      </svg>
      <span className="nameplate">
        <span className="led" style={{ background: LED[agent.state] ?? LED.idle }} />
        {p.name.toUpperCase()}
      </span>
      <span className="desk-role">{p.title}</span>
    </button>
  );
}

function WallScreen({ candles, label, badge }: { candles: WallCandle[]; label: string; badge?: string }) {
  const W = 300, H = 70;
  const hi = Math.max(...candles.map((c) => c.h)), lo = Math.min(...candles.map((c) => c.l));
  // top margin leaves room for the label row
  const y = (v: number) => 16 + (1 - (v - lo) / (hi - lo || 1)) * (H - 22);
  const step = (W - 20) / Math.max(1, candles.length);
  return (
    <div className="wall">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Market chart">
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="#13261e" strokeWidth={0.5} />)}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const x = 6 + i * step;
          return (
            <g key={i}>
              <rect x={x + step * 0.35} y={y(c.h)} width={0.8} height={Math.max(0.8, y(c.l) - y(c.h))} fill={up ? "#34D399" : "#F87171"} />
              <rect x={x} y={y(Math.max(c.o, c.c))} width={Math.max(1, step * 0.7)} height={Math.max(0.8, Math.abs(y(c.o) - y(c.c)))} fill={up ? "#34D399" : "#F87171"} />
            </g>
          );
        })}
      </svg>
      <span className="wall-label">{label}</span>
      {badge && <span className="wall-badge">{badge}</span>}
    </div>
  );
}

export function TradingFloor({ agents, candles, wallLabel, wallBadge, clock, onSelect, caption }: {
  agents: Record<string, FloorAgent>; candles: WallCandle[]; wallLabel: string; wallBadge?: string;
  clock?: string; onSelect?: (role: string) => void; caption?: ReactNode;
}) {
  return (
    <div className="floor" role="group" aria-label="AI agents trading floor">
      <div className="floor-top">
        <div className="banner" aria-hidden><svg viewBox="0 0 12 12" shapeRendering="crispEdges"><path d="M1 9h2V7h2V5h2v2h2V3h2" stroke="#e5e7eb" strokeWidth={1.2} fill="none" /></svg></div>
        <WallScreen candles={candles} label={wallLabel} badge={wallBadge} />
        <div className="floor-side">
          <div className="clock">{clock ?? "--:--"}</div>
          <div className="mini-map" aria-hidden />
        </div>
      </div>
      <div className="desks">
        {AGENTS.map((a) => <Desk key={a.role} role={a.role} agent={agents[a.role] ?? { state: "idle", active: false }} onSelect={onSelect} />)}
      </div>
      {caption && <div className="floor-caption">{caption}</div>}
    </div>
  );
}
