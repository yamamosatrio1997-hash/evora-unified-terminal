import { useState } from "react";
import type { Me } from "../App";
import { EquityChart } from "../components/charts";
import { Card, DataTag, DecisionBadge, Empty, ErrorNote, Stat, StatusBadge } from "../components/ui";
import { api } from "../lib/api";
import { useEvents } from "../lib/events";
import { num, pct, ts } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { Overview } from "../lib/types";

export default function PaperTerminal({ me }: { me: Me }) {
  const { tick } = useEvents();
  const t = Math.floor(tick / 3);
  const sum = useApi<any>(`/paper/summary?t=${t}`, 30000);
  const pos = useApi<any[]>(`/paper/positions?t=${t}`, 30000);
  const ord = useApi<any[]>(`/paper/orders?t=${t}`, 30000);
  const ov = useApi<Overview>("/overview", 30000);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (fn: () => Promise<any>) => {
    setMsg(null);
    try {
      const r = await fn();
      setMsg(r.status ? `Result: ${r.status}${r.reject_reason ? ` — ${r.reject_reason}` : ""}` : "Done");
      sum.reload(); pos.reload(); ord.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const s = sum.data;
  const executable = (ov.data?.recent_decisions ?? []).filter((d) => d.decision === "LONG" || d.decision === "SHORT");
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="notice info">Everything on this page is simulated. No order reaches an exchange; paper balances are never mixed with exchange balances.</div>
      <ErrorNote error={sum.error} />
      {msg && <div className="notice">{msg}</div>}
      {s && (
        <div className="grid g4">
          <Card title="Equity" right={<DataTag kind="PAPER" />}><Stat label={`start ${num(s.starting_equity)}`} value={num(s.equity)} sub={`return ${pct(s.return_pct)}`} /></Card>
          <Card title="P&L" right={<DataTag kind="PAPER" />}><Stat label="realized / unrealized" value={`${num(s.realized_pnl)} / ${num(s.unrealized_pnl)}`} sub={`fees ${num(s.fees)}`} /></Card>
          <Card title="Drawdown" right={<DataTag kind="PAPER" />}><Stat label="current / max" value={`${pct(s.current_drawdown)} / ${pct(s.max_drawdown_period)}`} /></Card>
          <Card title="Trades" right={<DataTag kind="PAPER" />}><Stat label="closed" value={s.trades} sub={`win ${s.win_rate == null ? "n/a" : pct(s.win_rate, 0)} · PF ${s.profit_factor == null ? "n/a" : num(s.profit_factor)}${s.trades && s.trades < 30 ? " · small sample" : ""}`} /></Card>
        </div>
      )}
      <Card title="Equity curve" right={<DataTag kind="PAPER" />}>
        {s?.equity_curve?.length > 1 ? <EquityChart points={s.equity_curve} /> : <Empty title="No equity history yet" />}
        {s && <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>{s.methodology}</div>}
      </Card>
      {me.role !== "viewer" && (
        <Card title="Executable decisions" right={<button className="btn sm" onClick={() => act(() => api.post("/service/paper/mark"))}>Mark to market</button>}>
          {executable.length === 0 ? <Empty title="No LONG/SHORT decisions">Only decisions that passed every gate, including the Risk Engine, can become paper orders. Each decision can be executed once.</Empty> : (
            <table className="t"><tbody>{executable.map((d) => (
              <tr key={d.id}><td className="mono faint">{ts(d.created_at)}</td><td>{d.symbol}</td><td><DecisionBadge value={d.decision} /></td>
                <td><button className="btn sm primary" onClick={() => act(() => api.post(`/paper/execute-decision/${d.id}`))}>Paper execute</button></td></tr>
            ))}</tbody></table>
          )}
        </Card>
      )}
      <Card title="Positions">
        {pos.data?.length === 0 ? <Empty title="No positions" /> : (
          <div className="table-wrap"><table className="t"><thead><tr><th>Opened</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Stop</th><th>Target</th><th>Planned risk</th><th>Status</th><th>Exit</th><th>Fees</th><th>Realized</th><th /></tr></thead><tbody>
            {pos.data?.map((p) => (
              <tr key={p.id}><td className="mono faint">{ts(p.opened_at)}</td><td>{p.symbol}</td><td><StatusBadge value={p.side} /></td><td className="mono">{p.qty}</td>
                <td className="mono">{num(p.entry_price)}</td><td className="mono">{num(p.stop_loss)}</td><td className="mono">{num(p.take_profit)}</td><td className="mono">{num(p.planned_risk)}</td>
                <td><StatusBadge value={p.status === "open" ? "running" : "completed"} label={p.status} /></td><td className="mono">{p.exit_price ? `${num(p.exit_price)} (${p.exit_reason})` : "—"}</td>
                <td className="mono">{num(p.fees)}</td><td className={`mono ${Number(p.realized_pnl) >= 0 ? "bull" : "bear"}`}>{p.realized_pnl == null ? "—" : num(p.realized_pnl)}</td>
                <td>{p.status === "open" && me.role !== "viewer" && <button className="btn sm" onClick={() => act(() => api.post(`/paper/positions/${p.id}/close`))}>Close</button>}</td></tr>
            ))}</tbody></table></div>
        )}
      </Card>
      <Card title="Orders">
        {ord.data?.length === 0 ? <Empty title="No orders" /> : (
          <div className="table-wrap"><table className="t"><thead><tr><th>Time</th><th>Client ID</th><th>Symbol</th><th>Side</th><th>Purpose</th><th>Qty</th><th>Filled</th><th>Avg price</th><th>Fee</th><th>Slippage</th><th>Status</th><th>Reason</th></tr></thead><tbody>
            {ord.data?.map((o) => (
              <tr key={o.id}><td className="mono faint">{ts(o.created_at)}</td><td className="mono" style={{ fontSize: 11 }}>{o.client_order_id}</td><td>{o.symbol}</td><td>{o.side}</td><td>{o.purpose}</td>
                <td className="mono">{o.qty}</td><td className="mono">{o.filled_qty}</td><td className="mono">{num(o.avg_fill_price)}</td><td className="mono">{num(o.fee, 4)}</td><td className="mono">{num(o.slippage_cost, 4)}</td>
                <td><StatusBadge value={o.status === "FILLED" ? "filled" : o.status === "REJECTED" ? "rejected" : "warning"} label={o.status} /></td><td className="muted" style={{ fontSize: 12 }}>{o.reject_reason ?? ""}</td></tr>
            ))}</tbody></table></div>
        )}
      </Card>
    </div>
  );
}
