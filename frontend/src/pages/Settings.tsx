import { useEffect, useState } from "react";
import type { Me } from "../App";
import { Card, ErrorNote, Kv, StatusBadge } from "../components/ui";
import { api } from "../lib/api";
import { pct, ts } from "../lib/format";
import { useApi } from "../lib/hooks";

const ROLES = ["macro", "fundamental", "onchain", "flow", "technical", "quant", "critic", "risk", "fund_manager"];

export default function SettingsPage({ me }: { me: Me }) {
  const s = useApi<any>("/settings");
  const audit = useApi<any>(me.role === "admin" ? "/audit?limit=100" : null);
  const [verify, setVerify] = useState<any>(null);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (s.data) setEnabled(s.data.agents.enabled ?? {}); }, [s.data]);
  const save = async () => {
    try {
      await api.put("/settings/agents", { enabled, schedules: s.data?.agents.schedules ?? {} });
      setMsg("Saved (audited).");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const d = s.data;
  return (
    <div className="grid" style={{ gap: 14 }}>
      <ErrorNote error={s.error} />
      {d && (
        <>
          <div className="notice info">{d.note}</div>
          <div className="grid g3">
            <Card title="Environment">
              <Kv rows={[["Environment", d.environment], ["Mode", d.mode], ["Live trading", String(d.live_trading_enabled)]]} />
            </Card>
            <Card title="LLM provider">
              <Kv rows={[["Provider", d.llm.provider], ["Model", d.llm.model], ["Configured", String(d.llm.configured)], ["Token budget / debate", d.llm.token_budget_per_debate],
                ["Cost budget / debate", `$${d.llm.cost_budget_per_debate_usd}`], ["Usage to date", `${d.llm.total_tokens} tokens · $${d.llm.total_cost_usd}`]]} />
            </Card>
            <Card title="Secrets (configured?)">
              <div className="row">{Object.entries(d.secrets_configured).map(([k, v]) => <StatusBadge key={k} value={v ? "configured" : "not_configured"} label={k.replace(/_/g, " ")} />)}</div>
            </Card>
          </div>
          <div className="grid g2">
            <Card title="Risk limits (server-enforced)">
              <Kv rows={Object.entries(d.risk).map(([k, v]) => [k.replace(/_/g, " "), typeof v === "string" && Number(v) < 1 && !k.includes("seconds") ? pct(v, 1) : String(v)])} />
            </Card>
            <Card title="Prompt versions & debate rounds">
              <Kv rows={Object.entries(d.prompt_versions).map(([k, v]) => [k, String(v)])} />
              <div className="stat-label" style={{ marginTop: 10 }}>Rounds</div>
              <Kv rows={Object.entries(d.debate_rounds).map(([k, v]) => [`R${k}`, String(v)])} />
            </Card>
          </div>
          <Card title="Agents enabled" right={me.role === "admin" ? <button className="btn sm primary" onClick={save}>Save</button> : <span className="faint">admin only</span>}>
            <div className="row">
              {ROLES.map((r) => (
                <label key={r} className="row muted" style={{ gap: 4, fontSize: 13 }}>
                  <input type="checkbox" checked={enabled[r] !== false} disabled={me.role !== "admin" || r === "risk" || r === "fund_manager"}
                    onChange={(e) => setEnabled({ ...enabled, [r]: e.target.checked })} />{r}
                </label>
              ))}
            </div>
            <p className="faint" style={{ fontSize: 11.5 }}>Risk Manager and Fund Manager cannot be disabled. Schedules are defined in the n8n workflows.</p>
            {msg && <div className="notice info">{msg}</div>}
          </Card>
        </>
      )}
      {me.role === "admin" && (
        <Card title="Audit log (append-only, hash-chained)" right={<button className="btn sm" onClick={() => api.get("/audit/verify").then(setVerify)}>Verify chain</button>}>
          {verify && <div className={`notice ${verify.ok ? "info" : "bad"}`} style={{ marginBottom: 10 }}>{verify.ok ? `Chain intact (checked ${ts(verify.checked_at)})` : `Chain broken at row ${verify.first_bad_id}`}</div>}
          <div className="table-wrap"><table className="t"><thead><tr><th>#</th><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody>
            {audit.data?.rows.map((r: any) => (
              <tr key={r.id}><td className="mono">{r.id}</td><td className="mono faint">{ts(r.ts)}</td><td>{r.actor}</td><td className="mono">{r.action}</td><td className="mono" style={{ fontSize: 11 }}>{r.target ?? ""}</td>
                <td className="mono faint" style={{ fontSize: 11 }}>{JSON.stringify(r.details).slice(0, 160)}</td></tr>
            ))}</tbody></table></div>
        </Card>
      )}
    </div>
  );
}
