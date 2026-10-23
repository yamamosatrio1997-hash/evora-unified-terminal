import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Background, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEvents } from "../lib/events";
import type { AgentOutput, AgentStatus } from "../lib/types";
import { Claims, Kv, StatusBadge } from "./ui";
import { ago, ts } from "../lib/format";
import { useApi } from "../lib/hooks";

const ACTIVE_MS = 4500;

/** Re-render periodically only while some real event is inside the activity window. */
function useActivityClock(): number {
  const { agentActivity } = useEvents();
  const [now, setNow] = useState(Date.now());
  const latest = Math.max(0, ...Object.values(agentActivity));
  useEffect(() => {
    if (Date.now() - latest > ACTIVE_MS) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    const stop = window.setTimeout(() => window.clearInterval(t), ACTIVE_MS + 600);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(stop);
    };
  }, [latest]);
  return now;
}

const STATE_COLOR: Record<string, string> = {
  idle: "#56657a", waiting: "#7aa7ff", analyzing: "#67e8d6", exchanging: "#67e8d6", challenging: "#f5b85b",
  quant_review: "#b59cff", risk_review: "#7aa7ff", completed: "#3ddc97", warning: "#f5b85b", error: "#f0616d", veto: "#f0616d",
};

interface NodeData extends Record<string, unknown> {
  label: string;
  sub: string;
  state: string;
  active: boolean;
  onClick?: () => void;
}

function AgentNode({ data }: NodeProps<Node<NodeData>>) {
  const reduce = useReducedMotion();
  const color = STATE_COLOR[data.state] ?? "#56657a";
  return (
    <div
      onClick={data.onClick}
      style={{
        background: "linear-gradient(180deg,#121925,#0e131b)", border: `1px solid ${data.active ? color : "#263142"}`,
        borderRadius: 10, padding: "8px 12px", minWidth: 150, cursor: data.onClick ? "pointer" : "default",
        boxShadow: data.active ? `0 0 0 3px ${color}22, 0 0 18px ${color}33` : "none", position: "relative",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#263142", border: "none" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <motion.span
          style={{ width: 8, height: 8, borderRadius: 999, background: color, display: "inline-block" }}
          animate={data.active && !reduce ? { scale: [1, 1.8, 1], opacity: [1, 0.5, 1] } : { scale: 1, opacity: 1 }}
          transition={data.active && !reduce ? { duration: 1, repeat: Infinity } : { duration: 0.2 }}
        />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "#dfe7f1" }}>{data.label}</span>
      </div>
      <div style={{ fontSize: 10.5, color: "#8494a8", marginTop: 3, fontFamily: "IBM Plex Mono" }}>{data.sub}</div>
      <Handle type="source" position={Position.Right} style={{ background: "#263142", border: "none" }} />
    </div>
  );
}

const nodeTypes = { agent: AgentNode };

const LAYOUT: Record<string, [number, number]> = {
  data: [-20, 190], validation: [200, 190],
  macro: [430, 0], fundamental: [430, 95], onchain: [430, 190], flow: [430, 285], technical: [430, 380],
  critic: [690, 120], quant: [690, 300], risk: [930, 300], fund_manager: [1160, 210], paper: [1390, 210],
};

const EDGES: [string, string][] = [
  ["data", "validation"],
  ...["macro", "fundamental", "onchain", "flow", "technical"].flatMap((a) => [["validation", a], [a, "critic"]] as [string, string][]),
  ["technical", "quant"], ["critic", "quant"], ["quant", "risk"], ["risk", "fund_manager"], ["critic", "fund_manager"], ["fund_manager", "paper"],
];

export function AgentNetwork({ agents, onSelect }: { agents: AgentStatus[]; onSelect: (role: string) => void }) {
  const { agentActivity } = useEvents();
  const now = useActivityClock();
  const isActive = (k: string) => now - (agentActivity[k] ?? 0) < ACTIVE_MS || Date.now() - (agentActivity[k] ?? 0) < ACTIVE_MS;
  const byRole = useMemo(() => Object.fromEntries(agents.map((a) => [a.role, a])), [agents]);

  const nodes: Node<NodeData>[] = Object.entries(LAYOUT).map(([id, [x, y]]) => {
    const a = byRole[id];
    let label = a?.name ?? id;
    let sub = a ? `${a.state}${a.last_analysis ? ` · ${a.last_analysis.stance}` : ""}` : "";
    let state = a?.state ?? "idle";
    if (id === "data") { label = "Data Sources"; sub = "5 public sources"; state = isActive("data") ? "analyzing" : "idle"; }
    if (id === "validation") { label = "Validation & Snapshot"; sub = "schema · freshness · hash"; state = isActive("data") ? "analyzing" : "idle"; }
    if (id === "paper") { label = "Paper Trading"; sub = "simulation only · no live orders"; state = isActive("paper") ? "analyzing" : "idle"; }
    const activeKey = id === "validation" ? "data" : id;
    return { id, type: "agent", position: { x, y }, data: { label, sub, state, active: isActive(activeKey), onClick: a ? () => onSelect(id) : undefined }, draggable: false };
  });
  const edges: Edge[] = EDGES.map(([s, t]) => {
    const key = t === "validation" ? "data" : t;
    const active = isActive(key) && (isActive(s === "validation" ? "data" : s) || s === "data" || s === "validation");
    return {
      id: `${s}-${t}`, source: s, target: t, animated: active,
      style: { stroke: active ? "#67e8d6" : "#263142", strokeWidth: active ? 1.8 : 1 },
    };
  });
  return (
    <div style={{ height: 500 }} role="figure" aria-label="Agent network">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.08 }} nodesConnectable={false}
        elementsSelectable={false} panOnScroll={false} zoomOnScroll={false} proOptions={{ hideAttribution: true }} minZoom={0.3}>
        <Background color="#1c2533" gap={24} size={1} />
      </ReactFlow>
    </div>
  );
}

const RING = ["macro", "fundamental", "onchain", "flow", "technical", "quant", "critic", "risk"];
const RING_LABEL: Record<string, string> = {
  macro: "Macro", fundamental: "Fundamentals", onchain: "On-chain", flow: "Whale/Flow", technical: "Technical",
  quant: "Quant validation", critic: "Critical review", risk: "Risk management",
};

function stanceColor(a?: AgentStatus): string {
  const la = a?.last_analysis;
  if (!la) return "#263142";
  if (la.status === "veto" || la.status === "error") return "#f0616d";
  if (la.status === "insufficient_data") return "#56657a";
  return la.stance === "bullish" ? "#3ddc97" : la.stance === "bearish" ? "#f0616d" : "#7aa7ff";
}

export function CircularIntel({ agents, decision, onSelect }: { agents: AgentStatus[]; decision?: string | null; onSelect: (r: string) => void }) {
  const { agentActivity } = useEvents();
  const now = useActivityClock();
  const reduce = useReducedMotion();
  const byRole = Object.fromEntries(agents.map((a) => [a.role, a]));
  const R = 150, C = 200, GAP = 4;
  const seg = 360 / RING.length;
  const polar = (deg: number, r: number) => [C + r * Math.cos(((deg - 90) * Math.PI) / 180), C + r * Math.sin(((deg - 90) * Math.PI) / 180)];
  const arc = (a0: number, a1: number, r: number) => {
    const [x0, y0] = polar(a0, r), [x1, y1] = polar(a1, r);
    return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  const fm = byRole["fund_manager"];
  return (
    <svg viewBox="-50 -10 500 420" style={{ width: "100%", maxWidth: 500, display: "block", margin: "0 auto" }} role="img" aria-label="Circular intelligence map">
      <circle cx={C} cy={C} r={R + 22} fill="none" stroke="#1c2533" />
      <circle cx={C} cy={C} r={R - 22} fill="none" stroke="#1c2533" strokeDasharray="2 4" />
      {RING.map((role, i) => {
        const a0 = i * seg + GAP / 2, a1 = (i + 1) * seg - GAP / 2, mid = (a0 + a1) / 2;
        const active = now - (agentActivity[role] ?? 0) < ACTIVE_MS || Date.now() - (agentActivity[role] ?? 0) < ACTIVE_MS;
        const color = stanceColor(byRole[role]);
        const [lx, ly] = polar(mid, R + 40);
        const [sx, sy] = polar(mid, R - 14);
        return (
          <g key={role} style={{ cursor: "pointer" }} onClick={() => onSelect(role)}>
            <path d={arc(a0, a1, R)} stroke={color} strokeWidth={14} fill="none" strokeLinecap="butt" opacity={byRole[role]?.last_analysis ? 0.9 : 0.35} />
            {active && !reduce && (
              <motion.path d={arc(a0, a1, R)} stroke={color} strokeWidth={22} fill="none" initial={{ opacity: 0.5 }}
                animate={{ opacity: [0.5, 0.05, 0.5] }} transition={{ duration: 1.2, repeat: Infinity }} />
            )}
            <line x1={sx} y1={sy} x2={C} y2={C} stroke={active ? color : "#1c2533"} strokeWidth={active ? 1.2 : 0.8} strokeDasharray={active ? "0" : "2 3"} />
            {active && !reduce && (
              <motion.circle r={2.6} fill={color} initial={{ cx: sx, cy: sy }} animate={{ cx: [sx, C], cy: [sy, C] }}
                transition={{ duration: 1.1, repeat: Infinity, ease: "easeIn" }} />
            )}
            <text x={lx} y={ly} fill="#8494a8" fontSize={10} textAnchor="middle" dominantBaseline="middle" fontFamily="IBM Plex Sans">{RING_LABEL[role]}</text>
          </g>
        );
      })}
      <g style={{ cursor: "pointer" }} onClick={() => onSelect("fund_manager")}>
        <circle cx={C} cy={C} r={58} fill="#0e131b" stroke={stanceColor(fm)} strokeWidth={1.5} />
        <text x={C} y={C - 14} fill="#8494a8" fontSize={9} textAnchor="middle" letterSpacing="1.5" fontFamily="IBM Plex Mono">FUND MANAGER</text>
        <text x={C} y={C + 6} fill="#dfe7f1" fontSize={decision && decision.length > 10 ? 10 : 14} fontWeight={600} textAnchor="middle" fontFamily="IBM Plex Mono">{decision ?? "no decision"}</text>
        <text x={C} y={C + 24} fill="#56657a" fontSize={8.5} textAnchor="middle" fontFamily="IBM Plex Mono">{fm?.last_analysis ? ago(fm.last_analysis.created_at) : "idle"}</text>
      </g>
    </svg>
  );
}

export function AgentDrawer({ role, onClose }: { role: string | null; onClose: () => void }) {
  const { data } = useApi<{ role: string; name: string; history: { id: number; session_id: string; round: number; status: string; created_at: string; output: AgentOutput; error: string | null }[] }>(role ? `/agents/${role}` : null);
  const latest = data?.history[0];
  const o = latest?.output;
  return (
    <AnimatePresence>
      {role && (
        <>
          <motion.div className="drawer-bg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside className="drawer" initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ duration: 0.2 }}
            role="dialog" aria-label={`${data?.name ?? role} details`}>
            <div className="row" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>{data?.name ?? role}</h2>
              <div style={{ flex: 1 }} />
              <button className="btn sm" onClick={onClose}>Close</button>
            </div>
            {!o ? (
              <div className="empty"><strong>No analysis yet</strong>This agent has not run in any debate.</div>
            ) : (
              <>
                <div className="row" style={{ marginBottom: 10 }}>
                  <StatusBadge value={o.status} />
                  <StatusBadge value={o.stance} />
                  {o.llm_used ? <span className="badge info">LLM · {o.model}</span> : <span className="badge">deterministic</span>}
                  <span className="faint mono" style={{ fontSize: 11 }}>{ts(o.timestamp)}</span>
                </div>
                <p style={{ marginTop: 0 }}>{o.conclusion}</p>
                <Kv rows={[
                  ["Confidence", o.confidence == null ? "n/a" : o.confidence.toFixed(2)],
                  ["Snapshot", o.snapshot_id.slice(0, 8)],
                  ["Prompt", o.prompt_version],
                  ["Next action", o.recommended_next_action],
                ]} />
                <p className="faint" style={{ fontSize: 11 }}>{o.confidence_note}</p>
                {o.trade_idea && (
                  <div className="card" style={{ margin: "10px 0" }}>
                    <div className="stat-label">Trade idea (not an order)</div>
                    <Kv rows={[["Side", o.trade_idea.side], ["Entry", o.trade_idea.entry], ["Stop", o.trade_idea.stop_loss],
                      ["Target", o.trade_idea.take_profit ?? "—"], ["Trigger", o.trade_idea.entry_trigger], ["Invalidation", o.trade_idea.invalidation]]} />
                  </div>
                )}
                <h4 className="stat-label" style={{ marginTop: 16 }}>Supporting evidence</h4>
                <Claims items={o.supporting_evidence} refs={o.source_references} />
                <h4 className="stat-label" style={{ marginTop: 16 }}>Opposing evidence</h4>
                <Claims items={o.opposing_evidence} refs={o.source_references} />
                <h4 className="stat-label" style={{ marginTop: 16 }}>Uncertainty</h4>
                <p style={{ marginTop: 4, fontSize: 13 }}>{o.uncertainty}</p>
                {o.missing_data.length > 0 && (
                  <>
                    <h4 className="stat-label" style={{ marginTop: 16 }}>Missing data</h4>
                    <ul style={{ margin: "4px 0", paddingLeft: 18, fontSize: 12.5 }}>{o.missing_data.map((m) => <li key={m}>{m}</li>)}</ul>
                  </>
                )}
                {o.errors.length > 0 && (
                  <>
                    <h4 className="stat-label" style={{ marginTop: 16 }}>Errors / limitations</h4>
                    <div className="pre">{o.errors.join("\n")}</div>
                  </>
                )}
                <h4 className="stat-label" style={{ marginTop: 16 }}>Sources</h4>
                <table className="t"><tbody>{o.source_references.map((r) => (
                  <tr key={r.id}><td className="mono">{r.id}</td><td>{r.source}</td><td className="mono faint">{ts(r.observed_at)}</td><td className="warn">{r.note}</td></tr>
                ))}</tbody></table>
              </>
            )}
            {data && data.history.length > 1 && (
              <>
                <h4 className="stat-label" style={{ marginTop: 18 }}>History</h4>
                <table className="t"><tbody>{data.history.map((h) => (
                  <tr key={h.id}><td className="mono faint">{ts(h.created_at)}</td><td><StatusBadge value={h.status} /></td><td>{h.output.stance}</td><td className="mono faint">{h.session_id.slice(0, 8)}</td></tr>
                ))}</tbody></table>
              </>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
