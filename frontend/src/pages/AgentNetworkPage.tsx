import { useState } from "react";
import type { Me } from "../App";
import { AgentDrawer, AgentNetwork, CircularIntel } from "../components/agents";
import { LiveFloor } from "../components/LiveFloor";
import { AgentBadge } from "../components/Mascot";
import { Card, ErrorNote, StatusBadge, Updated } from "../components/ui";
import { useEvents } from "../lib/events";
import { ago } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { AgentStatus, DebateSummary } from "../lib/types";

export default function AgentNetworkPage(_: { me: Me }) {
  const { tick, events } = useEvents();
  // Refetch persisted state whenever a backend event arrives (debounced by polling interval).
  const agents = useApi<AgentStatus[]>(`/agents?t=${Math.floor(tick / 5)}`, 20000);
  const debates = useApi<DebateSummary[]>("/debates?limit=1", 20000);
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<"floor" | "flow" | "map">("floor");
  const list = agents.data ?? [];
  return (
    <div className="grid" style={{ gap: 14 }}>
      <ErrorNote error={agents.error} />
      <div className="tabs" role="tablist">
        {([["floor", "Trading floor"], ["flow", "Data flow"], ["map", "Circular map"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={view === k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{l}</button>
        ))}
        <div style={{ flex: 1 }} /><Updated at={agents.updatedAt} />
      </div>
      {view === "floor" && <LiveFloor agents={list} onSelect={setSel} decision={debates.data?.[0]?.final_decision} />}
      {view === "flow" && <Card title="Agent network · data flow">
        <div className="faint" style={{ fontSize: 11.5, marginBottom: 6 }}>
          DATA SOURCES → VALIDATION → SPECIALIZED AGENTS → DEBATE → QUANT VALIDATION → RISK ENGINE → FUND MANAGER → PAPER TRADING.
          Edges animate only when the backend emits a matching event; idle means nothing is running.
        </div>
        <AgentNetwork agents={list} onSelect={setSel} />
      </Card>}
      <div className={view === "map" ? "grid g2" : "grid"}>
        {view === "map" && <Card title="Circular intelligence map">
          <CircularIntel agents={list} decision={debates.data?.[0]?.final_decision} onSelect={setSel} />
          <div className="faint" style={{ fontSize: 11.5, textAlign: "center" }}>
            Segment colour = latest recorded stance (green bullish · red bearish/veto · blue neutral · grey no data). Pulses = real events in the last few seconds.
          </div>
        </Card>}
        <Card title="Agent states">
          <table className="t"><thead><tr><th>Agent</th><th>State</th><th>Last result</th><th>Updated</th></tr></thead><tbody>
            {list.map((a) => (
              <tr key={a.role} style={{ cursor: "pointer" }} onClick={() => setSel(a.role)}>
                <td><AgentBadge role={a.role} size={22} showTitle /></td><td><StatusBadge value={a.state} /></td>
                <td>{a.last_analysis ? <><StatusBadge value={a.last_analysis.status} /> <span className="muted">{a.last_analysis.stance}</span></> : <span className="faint">never run</span>}</td>
                <td className="faint mono" style={{ fontSize: 11 }}>{a.last_analysis ? ago(a.last_analysis.created_at) : "—"}</td>
              </tr>
            ))}
          </tbody></table>
          <div className="stat-label" style={{ marginTop: 14 }}>Recent agent events</div>
          <div style={{ maxHeight: 200, overflowY: "auto", marginTop: 6 }}>
            {events.filter((e) => e.agent).slice(0, 30).map((e) => (
              <div key={e.id} className="mono" style={{ fontSize: 11, padding: "2px 0" }}>
                <span className="faint">{e.ts.slice(11, 19)}</span> {e.agent} · {e.type}{typeof e.payload.state === "string" ? ` → ${e.payload.state}` : ""}
              </div>
            ))}
            {!events.some((e) => e.agent) && <div className="faint" style={{ fontSize: 12 }}>No agent events since this page opened.</div>}
          </div>
        </Card>
      </div>
      <AgentDrawer role={sel} onClose={() => setSel(null)} />
    </div>
  );
}
