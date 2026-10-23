import { useEffect, useMemo, useState } from "react";
import { useEvents } from "../lib/events";
import { useApi } from "../lib/hooks";
import type { AgentStatus } from "../lib/types";
import { AGENTS, BY_ROLE } from "./Mascot";
import { TradingFloor, type FloorAgent, type WallCandle } from "./TradingFloor";

const ACTIVE_MS = 4500;
const KIND_TEXT: Record<string, (to?: string) => string> = {
  hypothesis: () => "Hypothesis ready",
  evidence: () => "Sharing evidence",
  challenge: (to) => `Challenging ${to ? BY_ROLE[to]?.name ?? to : ""}`.trim(),
  reply: () => "Replying",
  synthesis: () => "Cross-domain map",
  quant_validation: () => "Backtest done",
  risk_review: () => "Risk approved",
  veto: () => "VETO",
};
const STATE_TEXT: Record<string, string> = {
  analyzing: "Analyzing…", challenging: "Reviewing…", quant_review: "Running tests…", risk_review: "Sizing risk…", exchanging: "Answering…",
};

/** Trading floor bound to real backend state. Nothing animates without a matching event. */
export function LiveFloor({ agents, onSelect, decision }: { agents: AgentStatus[]; onSelect: (r: string) => void; decision?: string | null }) {
  const { events, agentActivity } = useEvents();
  const [now, setNow] = useState(Date.now());
  const latest = Math.max(0, ...Object.values(agentActivity));
  useEffect(() => {
    setNow(Date.now());
    if (Date.now() - latest > ACTIVE_MS) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    const stop = window.setTimeout(() => { window.clearInterval(t); setNow(Date.now()); }, ACTIVE_MS + 600);
    return () => { window.clearInterval(t); window.clearTimeout(stop); };
  }, [latest]);
  const candles = useApi<{ rows: { open: number; high: number; low: number; close: number }[]; status: string }>("/market/candles?symbol=BTCUSDT&interval=4h&limit=60", 60000);
  const byRole = Object.fromEntries(agents.map((a) => [a.role, a]));

  const floor: Record<string, FloorAgent> = useMemo(() => Object.fromEntries(AGENTS.map(({ role }) => {
    const active = now - (agentActivity[role] ?? 0) < ACTIVE_MS;
    let bubble: string | null = null;
    if (active) {
      const ev = events.find((e) => e.agent === role && (e.type === "debate.message" || e.type === "agent.state"));
      if (ev?.type === "debate.message") bubble = KIND_TEXT[String(ev.payload.kind)]?.(ev.payload.to as string | undefined) ?? null;
      if (ev?.type === "agent.state") bubble = STATE_TEXT[String(ev.payload.state)] ?? null;
      if (role === "fund_manager") {
        const fin = events.find((e) => e.type === "debate.finished");
        if (fin && Date.now() - new Date(fin.ts).getTime() < ACTIVE_MS * 2) bubble = `Decision: ${fin.payload.decision}`;
      }
    }
    return [role, { state: byRole[role]?.state ?? "idle", active, bubble }];
  })), [now, agentActivity, events, byRole]);

  const rows = candles.data?.rows ?? [];
  const wall: WallCandle[] = rows.length ? rows.map((r) => ({ o: r.open, h: r.high, l: r.low, c: r.close })) : [{ o: 1, h: 1, l: 1, c: 1 }];
  const status = candles.data?.status;
  const badge = status === "simulated" ? "SIMULATED" : status === "stale" ? "STALE" : status === "unavailable" || !rows.length ? "NO DATA" : undefined;
  const clock = new Date(now).toISOString().slice(11, 16) + "Z";
  return (
    <TradingFloor agents={floor} candles={wall} wallLabel={`BTCUSDT · 4H${decision ? ` · last decision: ${decision}` : ""}`} wallBadge={badge}
      clock={clock} onSelect={onSelect}
      caption="Live view. Mascots move only when the backend emits an event for that agent. Click a desk for its latest analysis." />
  );
}
