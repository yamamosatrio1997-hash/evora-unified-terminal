import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Me } from "../App";
import { AGENTS, BY_ROLE, Mascot } from "../components/Mascot";
import { Card, Claims, DataTag, DecisionBadge, Empty, ErrorNote, Kv, StatusBadge } from "../components/ui";
import { api } from "../lib/api";
import { useEvents } from "../lib/events";
import { num, pct, ts } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { DebateDetail, DebateSummary } from "../lib/types";

const ROUND_NAMES: Record<number, string> = {
  1: "Independent research", 2: "Evidence exchange", 3: "Challenge / counterargument", 4: "Cross-domain synthesis",
  5: "Quant validation", 6: "Independent risk review", 7: "Fund Manager decision", 8: "Audit & persistence",
};
const AGENT: Record<string, string> = Object.fromEntries(AGENTS.map((a) => [a.role, a.name]));

export default function DebateRoom({ me }: { me: Me }) {
  const [params, setParams] = useSearchParams();
  const { tick } = useEvents();
  const list = useApi<DebateSummary[]>(`/debates?limit=30&t=${Math.floor(tick / 10)}`, 15000);
  const selected = params.get("session") ?? list.data?.[0]?.id ?? null;
  const detail = useApi<DebateDetail>(selected ? `/debates/${selected}?t=${Math.floor(tick / 3)}` : null, 0);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<"timeline" | "agents">("timeline");
  const canRun = me.role !== "viewer";

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ status: string }>("/service/debate", { symbol, wait: false });
      setMsg(`Debate ${r.status}. Progress appears below as rounds complete.`);
      window.setTimeout(list.reload, 1500);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const byRound = useMemo(() => {
    const m = new Map<number, DebateDetail["messages"]>();
    for (const x of detail.data?.messages ?? []) m.set(x.round, [...(m.get(x.round) ?? []), x]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [detail.data]);
  const d = detail.data;
  const dec = d?.decision?.details;

  return (
    <div className="grid g-main" style={{ gridTemplateColumns: "300px minmax(0,1fr)" }}>
      <div className="grid" style={{ gap: 14, alignContent: "start" }}>
        {canRun && (
          <Card title="Start debate">
            <div className="row">
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Symbol"><option>BTCUSDT</option><option>ETHUSDT</option></select>
              <button className="btn primary" onClick={run} disabled={busy}>{busy ? "Starting…" : "Run 8-round debate"}</button>
            </div>
            {msg && <div className="notice info" style={{ marginTop: 10 }}>{msg}</div>}
          </Card>
        )}
        <Card title="Sessions">
          <ErrorNote error={list.error} />
          {list.data?.length === 0 && <Empty title="No debates yet" />}
          {list.data?.map((s) => (
            <div key={s.id} onClick={() => setParams({ session: s.id })}
              style={{ padding: "8px 6px", borderBottom: "1px solid var(--line)", cursor: "pointer", background: s.id === selected ? "var(--accent-dim)" : undefined, borderRadius: 6 }}>
              <div className="row"><strong style={{ fontSize: 13 }}>{s.symbol}</strong><DecisionBadge value={s.final_decision} /><div style={{ flex: 1 }} /><StatusBadge value={s.status} /></div>
              <div className="faint mono" style={{ fontSize: 10.5, marginTop: 3 }}>{ts(s.created_at)} · {s.rounds_completed}/{s.max_rounds} · {s.trigger}</div>
            </div>
          ))}
        </Card>
      </div>
      <div className="grid" style={{ gap: 14, alignContent: "start" }}>
        {!d ? <Empty title="Select a session" /> : (
          <>
            <Card title={`Decision · ${d.session.symbol}`} right={<>{d.snapshot?.simulated && <DataTag kind="SIMULATED" />}<StatusBadge value={d.session.status} /></>}>
              <div className="row" style={{ marginBottom: 10 }}>
                <span style={{ fontSize: 22 }}><DecisionBadge value={d.session.final_decision} /></span>
                <span className="faint mono" style={{ fontSize: 11 }}>session {d.session.id.slice(0, 8)} · snapshot {d.snapshot?.hash.slice(0, 12)} · {ts(d.session.created_at)}</span>
              </div>
              {d.session.error && <div className="notice" style={{ marginBottom: 10 }}>{d.session.error}</div>}
              {dec && (
                <div className="grid g2">
                  <div>
                    <div className="stat-label">Mandatory gates (evaluated in order)</div>
                    <table className="t"><tbody>{(dec.gates as { gate: string; passed: boolean; detail: string }[]).map((g) => (
                      <tr key={g.gate}><td>{g.passed ? <span className="bull">✓</span> : <span className="bear">✗</span>}</td><td className="mono">{g.gate}</td><td className="muted">{g.detail}</td></tr>
                    ))}</tbody></table>
                    <p className="faint" style={{ fontSize: 11 }}>{dec.note}</p>
                  </div>
                  <div>
                    <Kv rows={[
                      ["Entry conditions", dec.entry_conditions ?? "—"],
                      ["Invalidation", dec.invalidation ?? "—"],
                      ["Risk estimate", !dec.risk_estimate ? "—" : dec.risk_estimate.verdict === "REJECTED" ? "Rejected by Risk Engine (see round 6)"
                        : `${dec.risk_estimate.verdict} · loss at stop ${num(dec.risk_estimate.estimated_loss)} (${pct(dec.risk_estimate.risk_fraction)})`],
                      ["LLM tokens / cost", `${d.session.tokens_used} / $${d.session.cost_usd}`],
                    ]} />
                    {dec.dissent?.length > 0 && (<><div className="stat-label" style={{ marginTop: 10 }}>Recorded dissent</div>
                      {dec.dissent.map((x: { agent: string; stance: string; conclusion: string }) => <div key={x.agent} className="claim"><strong>{AGENT[x.agent]}</strong> ({x.stance}): {x.conclusion}</div>)}</>)}
                    {dec.data_limitations?.length > 0 && (<><div className="stat-label" style={{ marginTop: 10 }}>Data limitations</div>
                      <ul style={{ margin: 4, paddingLeft: 18, fontSize: 12 }}>{dec.data_limitations.slice(0, 8).map((x: string) => <li key={x}>{x}</li>)}</ul></>)}
                  </div>
                </div>
              )}
              {!dec && d.session.status === "running" && <div className="muted">Debate in progress: round {d.session.rounds_completed + 1} of 8…</div>}
            </Card>
            <div className="tabs">
              <button className={tab === "timeline" ? "on" : ""} onClick={() => setTab("timeline")}>Timeline</button>
              <button className={tab === "agents" ? "on" : ""} onClick={() => setTab("agents")}>Agent outputs ({d.analyses.length})</button>
            </div>
            {tab === "timeline" ? (
              <Card>
                <div className="timeline">
                  {byRound.map(([round, msgs]) => (
                    <div key={round}>
                      <div className="tl-round">Round {round} · {ROUND_NAMES[round]}</div>
                      {msgs.map((m) => (
                        <div key={m.id} className={`tl-item ${m.kind}`} id={`m${m.id}`}>
                          <div className="row" style={{ gap: 6 }}>
                            <Mascot role={m.from} size={18} />
                            <strong style={{ fontSize: 12.5, color: BY_ROLE[m.from]?.color }}>{AGENT[m.from] ?? m.from}</strong>
                            {m.to && <span className="faint" style={{ fontSize: 12 }}>→ {AGENT[m.to] ?? m.to}</span>}
                            <span className="badge" style={{ fontSize: 9.5 }}>{m.kind.replace("_", " ")}</span>
                            {m.reply_to && <a href={`#m${m.reply_to}`} className="mono" style={{ fontSize: 10.5 }}>re #{m.reply_to}</a>}
                            <span className="faint mono" style={{ fontSize: 10.5 }}>#{m.id} · {m.created_at.slice(11, 19)}Z</span>
                          </div>
                          <div style={{ fontSize: 13, marginTop: 3, color: m.content.startsWith("BLOCKING") ? "var(--warn)" : undefined }}>{m.content}</div>
                        </div>
                      ))}
                    </div>
                  ))}
                  {byRound.length === 0 && <div className="faint">No messages yet.</div>}
                </div>
              </Card>
            ) : (
              <div className="grid g2">
                {d.analyses.map((a) => (
                  <Card key={`${a.role}-${a.round}`} title={<span className="row" style={{ gap: 6 }}><Mascot role={a.role} size={18} />R{a.round} · {AGENT[a.role]} · {BY_ROLE[a.role]?.title}</span>} right={<><StatusBadge value={a.status} /><StatusBadge value={a.output.stance} /></>}>
                    <p style={{ marginTop: 0, fontSize: 13 }}>{a.output.conclusion}</p>
                    <div className="stat-label">Supporting</div><Claims items={a.output.supporting_evidence} refs={a.output.source_references} />
                    <div className="stat-label" style={{ marginTop: 8 }}>Opposing</div><Claims items={a.output.opposing_evidence} refs={a.output.source_references} />
                    {a.output.missing_data.length > 0 && <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>Missing: {a.output.missing_data.join("; ")}</div>}
                    <div className="faint mono" style={{ fontSize: 10.5, marginTop: 8 }}>{a.output.prompt_version ?? ""}{a.output.llm_used ? ` · ${a.output.model}` : " · deterministic"}</div>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
