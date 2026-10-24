import { useState } from "react";
import type { Me } from "../App";
import { Histogram, SeriesChart } from "../components/charts";
import { Card, DataTag, Empty, ErrorNote, Kv, StatusBadge } from "../components/ui";
import { api } from "../lib/api";
import { num, pct, ts } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { BacktestSummary } from "../lib/types";

const METRICS: [string, string, (v: any) => string][] = [
  ["trades", "Trades", (v) => String(v ?? "—")],
  ["win_rate", "Win rate", (v) => pct(v, 1)],
  ["profit_factor", "Profit factor", (v) => (v == null ? "n/a" : num(v, 2))],
  ["expectancy_r", "Expectancy (R)", (v) => (v == null ? "—" : num(v, 3))],
  ["expectancy_per_trade", "Expectancy / trade", (v) => num(v, 2)],
  ["avg_win", "Avg win", (v) => num(v, 2)],
  ["avg_loss", "Avg loss", (v) => num(v, 2)],
  ["max_drawdown", "Max drawdown", (v) => pct(v, 1)],
  ["max_drawdown_duration_bars", "DD duration (bars)", (v) => String(v ?? "—")],
  ["sharpe", "Sharpe", (v) => (v == null ? "n/a" : num(v, 2))],
  ["sortino", "Sortino", (v) => (v == null ? "n/a" : num(v, 2))],
  ["gross_pnl", "Gross P&L", (v) => num(v, 2)],
  ["net_pnl", "Net P&L", (v) => num(v, 2)],
  ["total_fees", "Fees", (v) => num(v, 2)],
  ["total_slippage", "Slippage", (v) => num(v, 2)],
  ["total_funding", "Funding", (v) => num(v, 2)],
  ["exposure", "Exposure", (v) => pct(v, 1)],
  ["avg_holding_bars", "Avg holding (bars)", (v) => num(v, 1)],
];

function MetricsTable({ cols }: { cols: [string, Record<string, any> | undefined][] }) {
  return (
    <div className="table-wrap"><table className="t">
      <thead><tr><th>Metric</th>{cols.map(([h]) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{METRICS.map(([k, label, f]) => (
        <tr key={k}><td className="muted">{label}</td>{cols.map(([h, m]) => <td key={h} className="mono">{m ? f(m[k]) : "—"}</td>)}</tr>
      ))}
        <tr><td className="muted">Win rate 95% CI</td>{cols.map(([h, m]) => <td key={h} className="mono">{m?.win_rate_ci95 ? `${pct(m.win_rate_ci95[0], 0)}–${pct(m.win_rate_ci95[1], 0)}` : "—"}</td>)}</tr>
      </tbody>
    </table></div>
  );
}

export default function QuantLab({ me }: { me: Me }) {
  const list = useApi<BacktestSummary[]>("/quant/backtests?limit=30", 30000);
  const strategies = useApi<{ name: string; description: string }[]>("/quant/strategies");
  const [sel, setSel] = useState<string | null>(null);
  const id = sel ?? list.data?.[0]?.id ?? null;
  const run = useApi<BacktestSummary>(id ? `/quant/backtests/${id}` : null);
  const [form, setForm] = useState({ strategy: "ema_trend", symbol: "BTCUSDT", interval: "4h", taker_fee_bps: 5, slippage_bps: 3, funding_rate_per_8h: 0.0001 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<BacktestSummary>("/quant/backtests", form);
      setSel(r.id);
      list.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const r = run.data?.results;
  const split = r?.split;
  const mc = r?.monte_carlo;
  const wf = r?.walk_forward;
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="notice info">
        Backtest results are historical simulations with stated cost assumptions. They are not paper-trading or live results, and they are not tuned to meet any target.
        Research goals (win rate &gt; 70%, profit factor &gt; 3, max drawdown &lt; 10%) are reported as measured, with sample size.
      </div>
      <div className="grid g-main" style={{ gridTemplateColumns: "320px minmax(0,1fr)" }}>
        <div className="grid" style={{ gap: 14, alignContent: "start" }}>
          {me.role !== "viewer" && (
            <Card title="New backtest">
              <div className="grid" style={{ gap: 8 }}>
                <label className="field">Strategy<select value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value })}>
                  {strategies.data?.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}</select></label>
                <div className="grid g2" style={{ gap: 8 }}>
                  <label className="field">Symbol<select value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}><option>BTCUSDT</option><option>ETHUSDT</option></select></label>
                  <label className="field">Interval<select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })}><option>1h</option><option>4h</option><option>1d</option></select></label>
                  <label className="field">Taker fee (bps/side)<input type="number" step="0.5" value={form.taker_fee_bps} onChange={(e) => setForm({ ...form, taker_fee_bps: Number(e.target.value) })} /></label>
                  <label className="field">Slippage (bps/side)<input type="number" step="0.5" value={form.slippage_bps} onChange={(e) => setForm({ ...form, slippage_bps: Number(e.target.value) })} /></label>
                </div>
                <label className="field">Funding per 8h (fraction)<input type="number" step="0.0001" value={form.funding_rate_per_8h} onChange={(e) => setForm({ ...form, funding_rate_per_8h: Number(e.target.value) })} /></label>
                <button className="btn primary" disabled={busy} onClick={submit}>{busy ? "Running (walk-forward + Monte Carlo)…" : "Run"}</button>
                <ErrorNote error={err} />
                <div className="faint" style={{ fontSize: 11 }}>{strategies.data?.find((s) => s.name === form.strategy)?.description}</div>
              </div>
            </Card>
          )}
          <Card title="Runs">
            {list.data?.length === 0 && <Empty title="No backtests yet" />}
            {list.data?.map((b) => (
              <div key={b.id} onClick={() => setSel(b.id)} style={{ padding: "7px 6px", borderBottom: "1px solid var(--line)", cursor: "pointer", borderRadius: 6, background: b.id === id ? "var(--accent-dim)" : undefined }}>
                <div className="row"><strong style={{ fontSize: 12.5 }}>{b.strategy}</strong><span className="muted" style={{ fontSize: 12 }}>{b.symbol} {b.interval}</span><div style={{ flex: 1 }} /><StatusBadge value={b.status} /></div>
                <div className="faint mono" style={{ fontSize: 10.5 }}>{ts(b.created_at)} · {b.dataset_kind} · OOS {b.oos.trades ?? 0} trades</div>
              </div>
            ))}
          </Card>
        </div>
        <div className="grid" style={{ gap: 14, alignContent: "start" }}>
          {!run.data ? <Empty title="Select or run a backtest" /> : (
            <>
              <Card title={`${run.data.strategy} · ${run.data.symbol} ${run.data.interval}`} right={<><DataTag kind="BACKTEST" />{run.data.dataset_kind === "simulated" && <DataTag kind="SIMULATED" />}</>}>
                <Kv rows={[["Data", `${run.data.data_source} · ${ts(run.data.data_start)} → ${ts(run.data.data_end)}`], ["Status", run.data.status],
                  ["Selected params (in-sample)", !split ? "—" : typeof split.selected_params === "string" ? "admin only" : JSON.stringify(split.selected_params)], ["Configs tried", split?.configs_tried ?? "—"]]} />
                {run.data.error && <div className="notice" style={{ marginTop: 8 }}>{run.data.error}</div>}
                {(r?.overfitting_warnings ?? []).length > 0 && (
                  <div className="notice" style={{ marginTop: 10 }}><strong>Overfitting / reliability warnings</strong>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{r.overfitting_warnings.map((w: string) => <li key={w}>{w}</li>)}</ul></div>
                )}
                {r?.research_goals_oos && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <span className="stat-label">Research goals (OOS):</span>
                    {[["win_rate_gt_70pct", "WR>70%"], ["profit_factor_gt_3", "PF>3"], ["max_drawdown_lt_10pct", "MDD<10%"]].map(([k, l]) => (
                      <span key={k} className={`badge ${r.research_goals_oos[k] ? "ok" : r.research_goals_oos[k] === false ? "bad" : ""}`}>{l}: {String(r.research_goals_oos[k] ?? "n/a")}</span>
                    ))}
                    <span className={`badge ${r.research_goals_oos.sample_sufficient ? "ok" : "warn"}`}>sample {r.research_goals_oos.sample_sufficient ? "≥30 trades" : "insufficient"}</span>
                  </div>
                )}
              </Card>
              {split && (
                <Card title="In-sample vs validation vs out-of-sample">
                  <MetricsTable cols={[["In-sample (60%)", split.in_sample], ["Validation (20%)", split.validation], ["Out-of-sample (20%)", split.out_of_sample], ["Full period, default params", r.default_params_full_period?.metrics]]} />
                </Card>
              )}
              <div className="grid g2">
                <Card title="Equity curve · full period, default params" right={<DataTag kind="BACKTEST" />}>
                  {r?.default_params_full_period?.equity_curve?.length > 1 ? <SeriesChart values={r.default_params_full_period.equity_curve} /> : <Empty title="No curve" />}
                </Card>
                <Card title="Monte Carlo (bootstrap of OOS trade R)">
                  {mc && !mc.error ? (
                    <>
                      <Histogram counts={mc.histogram_final_return} edges={mc.histogram_edges} />
                      <Kv rows={[["Runs × trades", `${mc.runs} × ${mc.trades_per_run} (${mc.trade_source})`],
                        ["Final return p5 / p50 / p95", `${pct(mc.final_return.p5, 1)} / ${pct(mc.final_return.p50, 1)} / ${pct(mc.final_return.p95, 1)}`],
                        ["Max DD p50 / p95 / p99", `${pct(mc.max_drawdown.p50, 1)} / ${pct(mc.max_drawdown.p95, 1)} / ${pct(mc.max_drawdown.p99, 1)}`],
                        ["P(loss)", pct(mc.prob_loss, 1)], ["P(DD > 10%)", pct(mc.prob_drawdown_gt_10pct, 1)]]} />
                      <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>{mc.assumptions}</div>
                    </>
                  ) : <Empty title="Monte Carlo unavailable">{mc?.error}</Empty>}
                </Card>
              </div>
              <Card title="Walk-forward (train → unseen test windows)">
                {wf?.folds?.length ? (
                  <>
                    <table className="t"><thead><tr><th>Fold</th><th>Test window</th><th>Params</th><th>Trades</th><th>Win rate</th><th>PF</th><th>Exp (R)</th><th>Max DD</th><th>Return</th></tr></thead><tbody>
                      {wf.folds.map((f: any) => (
                        <tr key={f.fold}><td>{f.fold}</td><td className="mono faint">{f.test[0].slice(0, 10)} → {f.test[1].slice(0, 10)}</td><td className="mono" style={{ fontSize: 11 }}>{typeof f.params === "string" ? "admin only" : JSON.stringify(f.params)}</td>
                          <td>{f.metrics.trades}</td><td>{pct(f.metrics.win_rate, 0)}</td><td>{f.metrics.profit_factor == null ? "n/a" : num(f.metrics.profit_factor)}</td>
                          <td>{f.metrics.expectancy_r == null ? "—" : num(f.metrics.expectancy_r, 3)}</td><td>{pct(f.metrics.max_drawdown, 1)}</td><td className={f.metrics.return_pct >= 0 ? "bull" : "bear"}>{pct(f.metrics.return_pct, 1)}</td></tr>
                      ))}</tbody></table>
                    <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Aggregate OOS: {wf.aggregate_oos.trades} trades · expectancy {wf.aggregate_oos.expectancy_r == null ? "—" : num(wf.aggregate_oos.expectancy_r, 3)}R · {wf.aggregate_oos.profitable_folds}/{wf.folds.length} profitable folds</div>
                  </>
                ) : <Empty title="Walk-forward unavailable">{wf?.error}</Empty>}
              </Card>
              {r?.sensitivity && !r.sensitivity.error && (
                <Card title="Parameter sensitivity">
                  <Kv rows={[["Configurations", r.sensitivity.configs], ["Best score", num(r.sensitivity.best, 3)], ["Median score", num(r.sensitivity.median, 3)],
                    ["Share positive", pct(r.sensitivity.share_positive, 0)], ["Fragile", String(r.sensitivity.fragile)]]} />
                </Card>
              )}
              {run.data.assumptions && <Card title="Assumptions"><pre className="pre">{JSON.stringify(run.data.assumptions, null, 2)}</pre></Card>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
