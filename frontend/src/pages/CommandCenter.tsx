import { Link } from "react-router-dom";
import type { Me } from "../App";
import { EquityChart } from "../components/charts";
import { Card, DataTag, DecisionBadge, Empty, ErrorNote, Stat, StatusBadge, Updated } from "../components/ui";
import { useEvents } from "../lib/events";
import { age, ago, num, pct, ts } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { Overview } from "../lib/types";

export default function CommandCenter(_: { me: Me }) {
  const { data, error, updatedAt } = useApi<Overview>("/overview", 15000);
  const { events } = useEvents();
  if (!data) return error ? <ErrorNote error={error} /> : <div className="muted">Loading…</div>;
  const s = data.system;
  const p = data.paper;
  return (
    <div className="grid" style={{ gap: 14 }}>
      {data.alerts.length > 0 && (
        <div className="grid" style={{ gap: 6 }}>
          {data.alerts.map((a, i) => (
            <div key={i} className={`notice ${a.level === "critical" ? "bad" : a.level === "info" ? "info" : ""}`}>{a.message}</div>
          ))}
        </div>
      )}
      <div className="grid g4">
        <Card title="System" right={<Updated at={updatedAt} error={error} />}>
          <div className="row">
            <StatusBadge value={s.database === "ok" ? "ok" : "error"} label={`db ${s.database}`} />
            <StatusBadge value={s.emergency_stop ? "error" : "ok"} label={s.emergency_stop ? "emergency stop" : "risk armed"} />
            <StatusBadge value={s.llm === "configured" ? "ok" : "not_configured"} label={`llm ${s.llm.replace("_", " ")}`} />
          </div>
          <div className="stat-sub" style={{ marginTop: 10 }}>
            Sources: {s.sources.map((x) => <span key={x.source} style={{ marginRight: 6 }}><StatusBadge value={x.status} label={x.source} /></span>)}
          </div>
        </Card>
        <Card title="Market regime" delay={0.04}>
          <Stat label={data.regime.simulated ? "From simulated data" : "BTC daily structure"} value={data.regime.label} sub={data.regime.basis} />
          {data.regime.volatility_atr_pct_1d != null && <div className="stat-sub">1d ATR {pct(data.regime.volatility_atr_pct_1d)}</div>}
        </Card>
        <Card title="Paper equity" right={<DataTag kind="PAPER" />} delay={0.08}>
          <Stat label="Equity" value={num(p.equity)} sub={`start ${num(p.starting_equity)} · return ${pct(p.return_pct)}`}
            tone={Number(p.return_pct) > 0 ? "bull" : Number(p.return_pct) < 0 ? "bear" : undefined} />
        </Card>
        <Card title="P&L · drawdown" right={<DataTag kind="PAPER" />} delay={0.12}>
          <Stat label="Realized / unrealized" value={`${num(p.realized_pnl)} / ${num(p.unrealized_pnl)}`}
            sub={`drawdown ${pct(p.current_drawdown)} (max ${pct(p.max_drawdown_period)}) · ${p.trades} closed · ${p.open_positions} open`} />
        </Card>
      </div>

      <div className="grid g-main">
        <div className="grid" style={{ gap: 14 }}>
          <div className="grid g2">
            {data.markets.map((m, i) => (
              <Card key={m.symbol} title={m.symbol} delay={0.05 * i}
                right={m.price == null ? <DataTag kind="UNAVAILABLE" /> : m.simulated ? <DataTag kind="SIMULATED" /> : (m.age_seconds ?? 0) > 7200 ? <DataTag kind="STALE" /> : <DataTag kind="DELAYED" />}>
                {m.price == null ? (
                  <Empty title="No price data">Ingestion has not produced candles for this symbol.</Empty>
                ) : (
                  <>
                    <Stat label="Last closed 1h candle" value={num(m.price)}
                      sub={<>{m.change_24h_pct != null && <span className={m.change_24h_pct >= 0 ? "bull" : "bear"}>{pct(m.change_24h_pct)} 24h · </span>}{m.price_source} · {ts(m.price_time)} ({age(m.age_seconds)} old)</>} />
                    <div className="row" style={{ marginTop: 8, fontSize: 12 }}>
                      {Object.entries(m.metrics).map(([k, v]) => (
                        <span key={k} className="badge" title={`${v.source} · ${ts(v.observed_at)}`}>{k.replace(/_/g, " ")}: {k.includes("rate") ? pct(v.value, 4) : num(v.value, 2)}</span>
                      ))}
                      {!Object.keys(m.metrics).length && <span className="faint">funding / OI unavailable</span>}
                    </div>
                  </>
                )}
              </Card>
            ))}
          </div>
          <Card title="Paper equity curve" right={<DataTag kind="PAPER" />}>
            {p.equity_curve.length < 2 ? <Empty title="No equity history yet">The curve appears after paper trades or mark-to-market snapshots exist.</Empty>
              : <EquityChart points={p.equity_curve} />}
          </Card>
          <Card title="Recent decisions" right={<Link to="/debate">Debate Room →</Link>}>
            {data.recent_decisions.length === 0 ? <Empty title="No decisions yet">Run a debate from the Debate Room or let the n8n schedule trigger one.</Empty> : (
              <table className="t"><thead><tr><th>Time</th><th>Symbol</th><th>Decision</th><th>Session</th></tr></thead><tbody>
                {data.recent_decisions.map((d) => (
                  <tr key={d.id}><td className="mono faint">{ts(d.created_at)}</td><td>{d.symbol}</td><td><DecisionBadge value={d.decision} /></td>
                    <td><Link className="mono" to={`/debate?session=${d.session_id}`}>{d.session_id.slice(0, 8)}</Link></td></tr>
                ))}</tbody></table>
            )}
          </Card>
        </div>
        <div className="grid" style={{ gap: 14, alignContent: "start" }}>
          <Card title="Agents" right={<Link to="/agents">Network →</Link>}>
            <table className="t"><tbody>
              {data.agents.map((a) => (
                <tr key={a.role}>
                  <td>{a.name}</td>
                  <td><StatusBadge value={a.state} /></td>
                  <td className="faint mono" style={{ fontSize: 11 }}>{a.last_analysis ? ago(a.last_analysis.created_at) : "—"}</td>
                </tr>
              ))}
            </tbody></table>
          </Card>
          <Card title="Live events">
            {events.length === 0 ? <div className="faint" style={{ fontSize: 12 }}>Waiting for backend events. Animations elsewhere only run when events arrive here.</div> : (
              <div style={{ maxHeight: 360, overflowY: "auto" }}>
                {events.slice(0, 40).map((e) => (
                  <div key={e.id} className="mono" style={{ fontSize: 11, padding: "3px 0", borderBottom: "1px solid #1c2533" }}>
                    <span className="faint">{e.ts.slice(11, 19)}</span> <span style={{ color: "var(--accent)" }}>{e.type}</span>{e.agent ? ` · ${e.agent}` : ""}
                    {typeof e.payload.state === "string" ? ` → ${e.payload.state}` : ""}{typeof e.payload.decision === "string" ? ` → ${e.payload.decision}` : ""}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
