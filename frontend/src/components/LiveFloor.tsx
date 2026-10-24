import { useEffect, useMemo, useRef, useState } from "react";
import { useEvents } from "../lib/events";
import { useApi } from "../lib/hooks";
import type { AgentStatus, SystemEvent } from "../lib/types";
import { AGENTS, BY_ROLE } from "./Mascot";
import { TradingFloor, type FloorAgent, type WallCandle } from "./TradingFloor";
import { Office3D } from "./office3d/Office3D";
import { linkTarget } from "./office3d/links";
import type { CommLink, OfficeAgent } from "./office3d/types";

const ACTIVE_MS = 4500;
const DECISION_MS = 9000;
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
const TABLE_ROUNDS = new Set([2, 3, 4]);
const TABLE_ROLES = new Set(["macro", "fundamental", "onchain", "flow", "technical", "critic"]);

/*
 * A deterministic debate emits ~75 events in about a second. Playing them as they arrive would
 * flash past, so debate events are queued and released at a readable pace (shorter gaps when the
 * queue is long). Nothing is invented: every animation still maps to one real event, in order.
 */
const PACE_MS: Record<string, number> = { "debate.message": 420, "debate.round_started": 850, "debate.finished": 500, "agent.state": 110 };
const PACED = new Set(Object.keys(PACE_MS).concat(["debate.started", "debate.failed", "debate.round_finished"]));

export interface Played { ev: SystemEvent; at: number }

function usePacedEvents(events: SystemEvent[]) {
  const seen = useRef<Set<number> | null>(null);
  const queue = useRef<SystemEvent[]>([]);
  const [played, setPlayed] = useState<Played[]>([]);
  const [queued, setQueued] = useState(0);
  if (seen.current === null) seen.current = new Set(events.map((e) => e.id)); // history before mount is not replayed
  useEffect(() => {
    const fresh = events.filter((e) => !seen.current!.has(e.id)).reverse(); // context keeps newest first
    if (!fresh.length) return;
    for (const e of fresh) seen.current!.add(e.id);
    const now = Date.now();
    const instant = fresh.filter((e) => !PACED.has(e.type));
    queue.current.push(...fresh.filter((e) => PACED.has(e.type)));
    if (instant.length) setPlayed((p) => [...instant.reverse().map((ev) => ({ ev, at: now })), ...p].slice(0, 300));
    setQueued(queue.current.length);
  }, [events]);
  useEffect(() => {
    // Release on a wall-clock schedule so late timers (busy main thread) catch up instead of drifting.
    let due = 0;
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (!queue.current.length) { due = 0; return; }
      if (!due || now - due > 2000) due = now;
      const out: Played[] = [];
      while (queue.current.length && now >= due) {
        const ev = queue.current.shift()!;
        out.push({ ev, at: now });
        const next = queue.current[0];
        const squeeze = queue.current.length > 90 ? 0.35 : queue.current.length > 45 ? 0.7 : 1;
        due += next ? (PACE_MS[next.type] ?? 60) * squeeze : 0;
      }
      if (out.length) {
        setPlayed((p) => [...out.reverse(), ...p].slice(0, 300));
        setQueued(queue.current.length);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, []);
  return { played, queued };
}

/** Trading floor bound to real backend state. Nothing animates without a matching event. */
export function LiveFloor({ agents, onSelect, decision }: { agents: AgentStatus[]; onSelect: (r: string) => void; decision?: string | null }) {
  const { events } = useEvents();
  const { played, queued } = usePacedEvents(events);
  const [now, setNow] = useState(Date.now());
  const latest = played[0]?.at ?? 0;
  useEffect(() => {
    setNow(Date.now());
    if (Date.now() - latest > DECISION_MS) return;
    const t = window.setInterval(() => setNow(Date.now()), 400);
    const stop = window.setTimeout(() => { window.clearInterval(t); setNow(Date.now()); }, DECISION_MS + 600);
    return () => { window.clearInterval(t); window.clearTimeout(stop); };
  }, [latest]);
  const candles = useApi<{ rows: { open: number; high: number; low: number; close: number }[]; status: string; source: string | null;
    quote?: { price: number; realtime: boolean; age_seconds: number } | null }>("/market/candles?symbol=BTCUSDT&interval=4h&limit=60", 30000);
  const byRole = Object.fromEntries(agents.map((a) => [a.role, a]));

  const lastAt: Record<string, number> = {};
  for (const p of played) if (p.ev.agent && !(p.ev.agent in lastAt)) lastAt[p.ev.agent] = p.at;
  const find = (pred: (e: SystemEvent) => boolean) => played.find((p) => pred(p.ev));
  const idx = (p?: Played) => (p ? played.indexOf(p) : Infinity);

  // Debate in progress = latest played debate.started is newer than the latest finished/failed.
  const started = find((e) => e.type === "debate.started");
  const ended = find((e) => e.type === "debate.finished" || e.type === "debate.failed");
  const running = !!started && idx(started) < idx(ended);
  const roundP = running ? find((e) => e.type === "debate.round_started") : undefined;
  const round = roundP && idx(roundP) < idx(started) ? Number(roundP.ev.payload.round) : 0;
  const finished = ended?.ev.type === "debate.finished" && now - ended.at < DECISION_MS ? ended : undefined;

  const floor: Record<string, FloorAgent> = useMemo(() => Object.fromEntries(AGENTS.map(({ role }) => {
    const active = now - (lastAt[role] ?? 0) < ACTIVE_MS;
    let bubble: string | null = null;
    if (active) {
      const p = played.find((x) => x.ev.agent === role && (x.ev.type === "debate.message" || x.ev.type === "agent.state"));
      if (p?.ev.type === "debate.message") bubble = KIND_TEXT[String(p.ev.payload.kind)]?.(p.ev.payload.to as string | undefined) ?? null;
      if (p?.ev.type === "agent.state") bubble = STATE_TEXT[String(p.ev.payload.state)] ?? null;
    }
    if (role === "fund_manager" && finished) bubble = `Decision: ${String(finished.ev.payload.decision)}`;
    return [role, { state: byRole[role]?.state ?? "idle", active: active || (role === "fund_manager" && !!finished), bubble }];
  })), [now, played, byRole]); // eslint-disable-line react-hooks/exhaustive-deps

  const links: CommLink[] = played.filter((p) => p.ev.type === "debate.message" && p.ev.agent && now - p.at < 4000)
    .map((p) => ({ id: String(p.ev.id), from: p.ev.agent as string, to: linkTarget(String(p.ev.payload.kind), p.ev.payload.to), kind: String(p.ev.payload.kind), at: p.at }))
    .filter((l) => l.from !== l.to);
  const veto = find((e) => e.type === "debate.message" && e.payload.kind === "veto");
  const ingest = find((e) => e.type.startsWith("data."));
  const office: Record<string, OfficeAgent> = Object.fromEntries(AGENTS.map(({ role }) => [role, {
    ...floor[role], atTable: running && TABLE_ROUNDS.has(round) && TABLE_ROLES.has(role),
    // the 3D view shows the decision as a card over the table instead
    ...(role === "fund_manager" && finished ? { bubble: null } : {}),
  }]));

  const rows = candles.data?.rows ?? [];
  const wall: WallCandle[] = rows.length ? rows.map((r) => ({ o: r.open, h: r.high, l: r.low, c: r.close })) : [{ o: 1, h: 1, l: 1, c: 1 }];
  const status = candles.data?.status;
  const badge = status === "simulated" ? "SIMULATED" : status === "stale" ? "STALE" : status === "unavailable" || !rows.length ? "NO DATA" : undefined;
  const clock = new Date(now).toISOString().slice(11, 16) + "Z";
  const SOURCE_NAME: Record<string, string> = { tradingview: "TradingView", binance: "Binance", synthetic: "synthetic" };
  const src = candles.data?.source ? SOURCE_NAME[candles.data.source] ?? candles.data.source : null;
  const q = candles.data?.quote;
  const quoteText = q ? ` · ${q.price.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${q.realtime ? "LIVE" : `DELAYED ${Math.round(q.age_seconds / 60)}m`}` : "";
  const wallBase = `BTCUSDT · 4H${src ? ` · ${src}` : ""}${quoteText}`;
  const flat = (
    <TradingFloor agents={floor} candles={wall} wallLabel={`${wallBase}${decision ? ` · last decision: ${decision}` : ""}`} wallBadge={badge}
      clock={clock} onSelect={onSelect}
      caption="Live view. Mascots move only when the backend emits an event for that agent. Click a desk for its latest analysis." />
  );
  return (
    <Office3D lang="en" agents={office} links={links} candles={wall} wallLabel={`${wallBase}${decision ? ` · last: ${decision}` : ""}`} wallBadge={badge}
      roundLabel={running && roundP ? `R${round} · ${String(roundP.ev.payload.name ?? "").replace(/_/g, " ")}` : null}
      queued={queued}
      decision={finished ? { text: `Decision: ${String(finished.ev.payload.decision)}`, at: finished.at } : null}
      vetoAt={veto ? veto.at : null} dataAt={ingest ? ingest.at : null}
      onSelect={onSelect} fallback={flat} controls="full" followDefault
      caption="Live view. Employees work, walk to the debate room and send messages only for real backend events, replayed in order at a readable pace. Click an employee for its latest analysis." />
  );
}
