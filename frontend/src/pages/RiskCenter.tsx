import { useState } from "react";
import type { Me } from "../App";
import { Card, DataTag, Empty, ErrorNote, Kv, Stat, StatusBadge } from "../components/ui";
import { api } from "../lib/api";
import { num, pct, ts } from "../lib/format";
import { useApi } from "../lib/hooks";

interface RiskStatus {
  limits: Record<string, string | number>;
  emergency_stop: { active: boolean; reason: string | null; updated_by: string | null; updated_at: string | null };
  portfolio: { equity: string; peak_equity: string; available_margin: string; realized_pnl_today: string; drawdown: string; exposure_notional: string; exposure_ratio: string; open_positions: any[]; data_kind: string };
  contract_specs: Record<string, any>;
  disclosure: string;
}
interface RiskDec { id: number; created_at: string; symbol: string; approved: boolean; verdict: string; reasons: string[]; estimated_loss: string; risk_fraction: string; hash: string }

export default function RiskCenter({ me }: { me: Me }) {
  const st = useApi<RiskStatus>("/risk/status", 15000);
  const decs = useApi<RiskDec[]>("/risk/decisions?limit=50", 15000);
  const [reason, setReason] = useState("");
  const [calc, setCalc] = useState({ symbol: "BTCUSDT", side: "long", entry_price: "", stop_loss: "", take_profit: "", leverage: "1", risk_fraction: "0.01" });
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  const toggleStop = async (active: boolean) => {
    setErr(null);
    try {
      await api.post("/risk/emergency-stop", { active, reason: reason || (active ? "manual stop from Risk Center" : "manual release") });
      setReason("");
      st.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const evaluate = async () => {
    setErr(null);
    try {
      const body = Object.fromEntries(Object.entries(calc).filter(([, v]) => v !== ""));
      setResult(await api.post("/risk/evaluate", body));
      decs.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const s = st.data;
  const L = s?.limits ?? {};
  return (
    <div className="grid" style={{ gap: 14 }}>
      <ErrorNote error={st.error ?? err} />
      {s && <div className="notice">{s.disclosure}</div>}
      <div className="grid g4">
        <Card title="Per-trade risk ceiling"><Stat label="Hard ceiling (cannot be raised)" value={pct(L.max_planned_risk_per_trade, 1)} sub="Engine may size lower or reject" /></Card>
        <Card title="Daily loss limit"><Stat label="Of equity" value={pct(L.max_daily_loss, 1)} sub={s ? `today ${num(s.portfolio.realized_pnl_today)}` : ""} /></Card>
        <Card title="Drawdown" right={<DataTag kind="PAPER" />}><Stat label="Current" value={s ? pct(s.portfolio.drawdown, 2) : "—"} sub={`reduce from ${pct(L.drawdown_risk_reduction_start, 0)} · halt at ${pct(L.max_drawdown_halt, 0)}`} /></Card>
        <Card title="Exposure" right={<DataTag kind="PAPER" />}><Stat label="Notional / equity" value={s ? `${num(s.portfolio.exposure_ratio, 2)}x` : "—"} sub={`cap ${L.max_portfolio_exposure}x · correlated risk cap ${pct(L.max_correlated_risk, 0)} · leverage ≤ ${L.max_leverage}x`} /></Card>
      </div>
      <div className="grid g2">
        <Card title="Emergency stop" right={s && <StatusBadge value={s.emergency_stop.active ? "error" : "ok"} label={s.emergency_stop.active ? "ACTIVE" : "inactive"} />}>
          {s?.emergency_stop.updated_at && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Last change {ts(s.emergency_stop.updated_at)} by {s.emergency_stop.updated_by}: {s.emergency_stop.reason}</div>}
          {me.role === "viewer" ? <div className="faint">Operator role required.</div> : (
            <div className="row">
              <input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
              <button className="btn danger" onClick={() => toggleStop(true)} disabled={s?.emergency_stop.active}>Engage stop</button>
              <button className="btn" onClick={() => toggleStop(false)} disabled={!s?.emergency_stop.active || me.role !== "admin"} title="Admin only">Release</button>
            </div>
          )}
          <p className="faint" style={{ fontSize: 11.5, marginBottom: 0 }}>While active, the Risk Engine rejects every proposal and the paper engine rejects fills. Releasing requires an admin.</p>
        </Card>
        <Card title="Position sizing calculator">
          {me.role === "viewer" ? <div className="faint">Operator role required.</div> : (
            <div className="grid g3" style={{ gap: 8 }}>
              <label className="field">Symbol<select value={calc.symbol} onChange={(e) => setCalc({ ...calc, symbol: e.target.value })}><option>BTCUSDT</option><option>ETHUSDT</option></select></label>
              <label className="field">Side<select value={calc.side} onChange={(e) => setCalc({ ...calc, side: e.target.value })}><option>long</option><option>short</option></select></label>
              <label className="field">Leverage<input value={calc.leverage} onChange={(e) => setCalc({ ...calc, leverage: e.target.value })} /></label>
              <label className="field">Entry (blank = latest)<input value={calc.entry_price} onChange={(e) => setCalc({ ...calc, entry_price: e.target.value })} /></label>
              <label className="field">Stop-loss<input value={calc.stop_loss} onChange={(e) => setCalc({ ...calc, stop_loss: e.target.value })} /></label>
              <label className="field">Take-profit<input value={calc.take_profit} onChange={(e) => setCalc({ ...calc, take_profit: e.target.value })} /></label>
              <label className="field">Risk fraction<input value={calc.risk_fraction} onChange={(e) => setCalc({ ...calc, risk_fraction: e.target.value })} /></label>
              <div style={{ alignSelf: "end" }}><button className="btn primary" onClick={evaluate}>Evaluate</button></div>
            </div>
          )}
          {result && (
            <div style={{ marginTop: 12 }}>
              <div className="row"><StatusBadge value={result.approved ? "approved" : "rejected"} label={result.verdict} /><span className="faint mono" style={{ fontSize: 11 }}>decision #{result.risk_decision_id} (recorded, immutable)</span></div>
              {result.approved ? (
                <Kv rows={[["Quantity", result.qty], ["Notional", num(result.notional)], ["Margin", num(result.margin_required)], ["Est. loss at stop", `${num(result.estimated_loss)} (${pct(result.risk_fraction)})`],
                  ["Breakdown", Object.entries(result.loss_breakdown).map(([k, v]) => `${k} ${num(v)}`).join(" · ")]]} />
              ) : <ul style={{ margin: "6px 0", paddingLeft: 18, fontSize: 12.5 }}>{result.reasons.map((r: string) => <li key={r} className="bear">{r}</li>)}</ul>}
              <table className="t" style={{ marginTop: 6 }}><tbody>{result.checks.map((c: any, i: number) => <tr key={i}><td>{c.passed ? "✓" : "✗"}</td><td className="mono">{c.name}</td><td className="muted">{c.detail}</td></tr>)}</tbody></table>
            </div>
          )}
        </Card>
      </div>
      <Card title="Risk decisions (append-only, hash-recorded)">
        {decs.data?.length === 0 ? <Empty title="No risk evaluations yet" /> : (
          <div className="table-wrap"><table className="t"><thead><tr><th>#</th><th>Time</th><th>Symbol</th><th>Verdict</th><th>Est. loss</th><th>Reasons</th><th>Hash</th></tr></thead><tbody>
            {decs.data?.map((d) => (
              <tr key={d.id}><td className="mono">{d.id}</td><td className="mono faint">{ts(d.created_at)}</td><td>{d.symbol}</td><td><StatusBadge value={d.approved ? "approved" : "veto"} label={d.verdict} /></td>
                <td className="mono">{d.approved ? `${num(d.estimated_loss)} (${pct(d.risk_fraction)})` : "—"}</td><td className="muted" style={{ fontSize: 12 }}>{d.reasons.join("; ") || "—"}</td><td className="mono faint">{d.hash.slice(0, 10)}</td></tr>
            ))}</tbody></table></div>
        )}
      </Card>
      {s && <Card title="Contract specifications (paper venue configuration)"><pre className="pre">{JSON.stringify(s.contract_specs, null, 2)}</pre></Card>}
    </div>
  );
}
