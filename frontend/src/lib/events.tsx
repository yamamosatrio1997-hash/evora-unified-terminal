import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { SystemEvent } from "./types";

interface EventsState {
  connected: boolean;
  events: SystemEvent[];
  /** Last event time per agent role (ms since epoch); only set by real backend events. */
  agentActivity: Record<string, number>;
  /** Monotonic counter bumped on each event; lets views refetch on change. */
  tick: number;
}

const Ctx = createContext<EventsState>({ connected: false, events: [], agentActivity: {}, tick: 0 });

const EDGE_EVENTS = new Set(["agent.state", "debate.message", "data.ingested", "risk.decision", "paper.order_filled",
  "debate.started", "debate.finished", "quant.backtest_started", "quant.backtest_finished", "debate.round_started"]);

export function EventsProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [state, setState] = useState<EventsState>({ connected: false, events: [], agentActivity: {}, tick: 0 });
  const retry = useRef(1000);

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      es = new EventSource("/api/events/stream", { withCredentials: true });
      es.onopen = () => {
        retry.current = 1000;
        setState((s) => ({ ...s, connected: true }));
      };
      es.onerror = () => {
        setState((s) => ({ ...s, connected: false }));
        es?.close();
        if (!closed) timer = window.setTimeout(connect, (retry.current = Math.min(retry.current * 2, 30000)));
      };
      const onAny = (msg: MessageEvent) => {
        try {
          const ev = JSON.parse(msg.data) as SystemEvent;
          setState((s) => {
            const act = { ...s.agentActivity };
            if (ev.agent && EDGE_EVENTS.has(ev.type)) act[ev.agent] = Date.now();
            if (ev.type.startsWith("data.")) act["data"] = Date.now();
            if (ev.type.startsWith("paper.")) act["paper"] = Date.now();
            return { ...s, events: [ev, ...s.events].slice(0, 300), agentActivity: act, tick: s.tick + 1 };
          });
        } catch {
          /* ignore malformed frames */
        }
      };
      es.onmessage = onAny;
      for (const t of ["agent.state", "debate.message", "debate.started", "debate.finished", "debate.failed",
        "debate.round_started", "debate.round_finished", "data.ingested", "data.source_error", "risk.decision",
        "risk.emergency_stop", "paper.order_filled", "paper.order_rejected", "paper.position_closed",
        "quant.backtest_started", "quant.backtest_finished", "n8n.execution", "telegram.request", "mexc.sync"]) {
        es.addEventListener(t, onAny as EventListener);
      }
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      es?.close();
    };
  }, [enabled]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const useEvents = () => useContext(Ctx);

/** True while the given key had a real event within `windowMs`. Re-renders once to expire. */
export function useRecentActivity(key: string, windowMs = 4000): boolean {
  const { agentActivity } = useEvents();
  const last = agentActivity[key] ?? 0;
  const [, force] = useState(0);
  useEffect(() => {
    const remaining = last + windowMs - Date.now();
    if (remaining <= 0) return;
    const t = window.setTimeout(() => force((x) => x + 1), remaining + 20);
    return () => window.clearTimeout(t);
  }, [last, windowMs]);
  return Date.now() - last < windowMs;
}
