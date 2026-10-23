import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import type { Claim, SourceRef } from "../lib/types";
import { ts } from "../lib/format";

export function Card({ title, right, children, className = "", delay = 0 }: {
  title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; delay?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.section
      className={`card ${className}`}
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: reduce ? 0 : delay, ease: "easeOut" }}
    >
      {(title || right) && (
        <div className="card-h">
          {title && <h3>{title}</h3>}
          <div className="spacer" />
          {right}
        </div>
      )}
      {children}
    </motion.section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "bull" | "bear" | "warn" }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ""}`}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

const TONE: Record<string, string> = {
  ok: "ok", completed: "ok", healthy: "ok", success: "ok", filled: "ok", approved: "ok", answered: "ok", configured: "ok", ready: "ok", sent: "ok",
  running: "accent", analyzing: "accent", exchanging: "accent", challenging: "warn", quant_review: "violet", risk_review: "info", waiting: "info",
  degraded: "warn", warning: "warn", stale: "warn", insufficient_data: "warn", unconfigured: "warn", not_configured: "warn", resized: "warn",
  never_run: "", never_synced: "", idle: "", unknown: "", skipped: "",
  down: "bad", error: "bad", failed: "bad", veto: "bad", rejected: "bad", unauthorized: "bad", unreachable: "bad", rate_limited: "warn",
  long: "ok", short: "bad", bullish: "ok", bearish: "bad", neutral: "", no_view: "",
};

export function StatusBadge({ value, label }: { value?: string | null; label?: string }) {
  const v = (value ?? "unknown").toLowerCase();
  return (
    <span className={`badge ${TONE[v] ?? ""}`}>
      <span className="dot" />
      {label ?? v.replace(/_/g, " ")}
    </span>
  );
}

const DECISION_TONE: Record<string, string> = {
  LONG: "ok", SHORT: "bad", REJECT: "bad", "NO TRADE": "", WATCHLIST: "info", "WAIT FOR CONFIRMATION": "warn",
};

export function DecisionBadge({ value }: { value?: string | null }) {
  return <span className={`badge ${DECISION_TONE[value ?? ""] ?? ""}`}>{value ?? "—"}</span>;
}

/** Provenance labels shown wherever data is displayed. */
export function DataTag({ kind }: { kind: "PAPER" | "SIMULATED" | "STALE" | "ACTUAL" | "BACKTEST" | "UNAVAILABLE" | "DELAYED" }) {
  const tone = { PAPER: "info", SIMULATED: "violet", STALE: "warn", ACTUAL: "ok", BACKTEST: "accent", UNAVAILABLE: "bad", DELAYED: "warn" }[kind];
  return <span className={`badge ${tone}`}>{kind}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="notice bad">Request failed: {error}</div>;
}

export function Claims({ items, refs }: { items: Claim[]; refs?: SourceRef[] }) {
  if (!items.length) return <div className="faint" style={{ fontSize: 12 }}>None recorded.</div>;
  const byId = new Map((refs ?? []).map((r) => [r.id, r]));
  return (
    <div>
      {items.map((c, i) => (
        <div className="claim" key={i}>
          <span className={`kind ${c.kind}`}>{c.kind}</span>
          {c.statement}
          {c.source_refs.length > 0 && (
            <div className="faint mono" style={{ fontSize: 10.5, marginTop: 3 }}>
              {c.source_refs.map((r) => {
                const ref = byId.get(r);
                return (
                  <span key={r} style={{ marginRight: 10 }} title={ref?.note ?? ""}>
                    ↳ {r}
                    {ref?.observed_at ? ` · ${ts(ref.observed_at)}` : ""}
                    {ref?.note?.includes("STALE") ? " · STALE" : ""}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Updated({ at, error }: { at: Date | null; error?: string | null }) {
  return (
    <span className="faint mono" style={{ fontSize: 11 }}>
      {error ? <span className="bear">refresh failed</span> : at ? `updated ${at.toISOString().slice(11, 19)}Z` : "loading…"}
    </span>
  );
}
