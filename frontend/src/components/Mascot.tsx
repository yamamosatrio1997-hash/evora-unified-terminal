import type { CSSProperties } from "react";

/** The nine agents. Shared silhouette, unique colour; names are the brand personas. */
export interface AgentPersona {
  role: string;
  name: string;
  title: string;
  titleId: string;
  color: string;
  tagline: string;
}

export const AGENTS: AgentPersona[] = [
  { role: "macro", name: "Atlas", title: "Macro Analyst", titleId: "Analis Makro", color: "#FACC15", tagline: "Membaca suku bunga, dolar, likuiditas, dan inflasi." },
  { role: "fundamental", name: "Sage", title: "Fundamental Analyst", titleId: "Analis Fundamental", color: "#A3E635", tagline: "Menilai kapitalisasi, likuiditas, dan katalis aset." },
  { role: "onchain", name: "Cipher", title: "On-Chain Analyst", titleId: "Analis On-Chain", color: "#C084FC", tagline: "Memantau suplai stablecoin dan aktivitas DeFi." },
  { role: "flow", name: "Vortex", title: "Whale & Flow Analyst", titleId: "Analis Arus & Whale", color: "#22D3EE", tagline: "Mengukur funding rate dan open interest." },
  { role: "technical", name: "Chronos", title: "Technical Analyst", titleId: "Analis Teknikal", color: "#3B82F6", tagline: "Membaca struktur multi-timeframe dan level invalidasi." },
  { role: "quant", name: "Alpha", title: "Quant Researcher", titleId: "Peneliti Kuantitatif", color: "#F472B6", tagline: "Menguji apakah sebuah ide punya edge di luar sampel." },
  { role: "risk", name: "Sentinel", title: "Risk Manager", titleId: "Manajer Risiko", color: "#34D399", tagline: "Memegang hak veto. Plafon risiko 3% per trade." },
  { role: "critic", name: "Killjoy", title: "Critical Reviewer", titleId: "Peninjau Kritis", color: "#F87171", tagline: "Mencari alasan terkuat untuk tidak trading." },
  { role: "fund_manager", name: "Odin", title: "Fund Manager", titleId: "Manajer Dana", color: "#FB923C", tagline: "Mengambil keputusan akhir lewat gerbang deterministik." },
];

export const BY_ROLE: Record<string, AgentPersona> = Object.fromEntries(AGENTS.map((a) => [a.role, a]));

/*
 * 16 x 14 pixel silhouette.  B body · H highlight · S shade · E eye · . empty
 * Eyes are drawn separately so they can blink without redrawing the body.
 */
const GRID = [
  "....BBBBBBBB....",
  "..BBBBBBBBBBBB..",
  ".BHHBBBBBBBBBBB.",
  ".BHBBBBBBBBBBBB.",
  "BBBBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBBBB",
  ".BBBBBBBBBBBBBB.",
  ".SBBBBBBBBBBBBS.",
  "..SSBBBBBBBBSS..",
  "....SSSSSSSS....",
];
const EYES = [[4, 5], [10, 5]]; // top-left of each 2x3 eye

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  const r = c(n >> 16), g = c((n >> 8) & 255), b = c(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function runs(ch: string): { x: number; y: number; w: number }[] {
  const out: { x: number; y: number; w: number }[] = [];
  GRID.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== ch) { x++; continue; }
      let w = 1;
      while (row[x + w] === ch) w++;
      out.push({ x, y, w });
      x += w;
    }
  });
  return out;
}
const BODY = runs("B"), HIGHLIGHT = runs("H"), SHADOW = runs("S");

/** The silhouette as an SVG group in a 16x14 coordinate box (for embedding in scenes). */
export function MascotShape({ role, x = 0, y = 0, active = false, blinkDelay }: { role: string; x?: number; y?: number; active?: boolean; blinkDelay?: number }) {
  const color = BY_ROLE[role]?.color ?? "#94a3b8";
  const delay = blinkDelay ?? (AGENTS.findIndex((a) => a.role === role) * 0.7) % 5;
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className={`mascot-body${active ? " mascot-bob" : ""}`}>
        {BODY.map((r, i) => <rect key={`b${i}`} x={r.x} y={r.y} width={r.w} height={1} fill={color} />)}
        {HIGHLIGHT.map((r, i) => <rect key={`h${i}`} x={r.x} y={r.y} width={r.w} height={1} fill={shade(color, 0.28)} />)}
        {SHADOW.map((r, i) => <rect key={`s${i}`} x={r.x} y={r.y} width={r.w} height={1} fill={shade(color, -0.22)} />)}
        <g className="mascot-eyes" style={{ animationDelay: `${delay}s` }}>
          {EYES.map(([ex, ey]) => <rect key={ex} x={ex} y={ey} width={2} height={3} fill="#0b1020" />)}
        </g>
      </g>
    </g>
  );
}

export function Mascot({ role, size = 48, active = false, blinkDelay, title, style }: {
  role: string; size?: number; active?: boolean; blinkDelay?: number; title?: string; style?: CSSProperties;
}) {
  const a = BY_ROLE[role];
  const delay = blinkDelay ?? (AGENTS.findIndex((x) => x.role === role) * 0.7) % 5;
  return (
    <svg viewBox="0 0 16 14" width={size} height={(size * 14) / 16} shapeRendering="crispEdges"
      className="mascot" style={style} role="img" aria-label={title ?? a?.name ?? role}>
      <MascotShape role={role} active={active} blinkDelay={delay} />
    </svg>
  );
}

/** Mascot with its name label, used wherever an agent is identified. */
export function AgentBadge({ role, size = 28, active, showTitle = false }: { role: string; size?: number; active?: boolean; showTitle?: boolean }) {
  const a = BY_ROLE[role];
  if (!a) return <span>{role}</span>;
  return (
    <span className="agent-badge">
      <Mascot role={role} size={size} active={active} />
      <span>
        <span className="agent-badge-name" style={{ color: a.color }}>{a.name}</span>
        {showTitle && <span className="agent-badge-title">{a.title}</span>}
      </span>
    </span>
  );
}
