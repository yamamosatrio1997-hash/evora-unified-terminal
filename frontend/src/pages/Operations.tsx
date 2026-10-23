import { useState } from "react";
import type { Me } from "../App";
import { Card, DataTag, Empty, ErrorNote, Kv, StatusBadge, Updated } from "../components/ui";
import { api } from "../lib/api";
import { age, ago, ts } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { SourceHealth } from "../lib/types";

export function N8nCenter(_: { me: Me }) {
  const d = useApi<any>("/n8n/status", 30000);
  const remote = d.data?.remote;
  return (
    <div className="grid" style={{ gap: 14 }}>
      <ErrorNote error={d.error} />
      <div className="notice info">
        Two sources, shown separately: <strong>callback reports</strong> that each workflow posts to the backend, and the <strong>n8n public API</strong> (only if N8N_API_KEY is set on the server). The n8n API key and editor are never exposed to this browser.
      </div>
      <Card title="Workflows (callback reports)" right={<Updated at={d.updatedAt} />}>
        {!d.data?.by_workflow?.length ? <Empty title="No workflow has reported yet">Import the workflows in /n8n/workflows, set the "TCC Service Token" credential, and activate them.</Empty> : (
          <table className="t"><thead><tr><th>Workflow</th><th>Last status</th><th>Last run</th><th>Runs 24h</th><th>Errors 24h</th><th>Avg duration</th><th>Last error</th></tr></thead><tbody>
            {d.data.by_workflow.map((w: any) => (
              <tr key={w.workflow_id}><td>{w.workflow_name ?? w.workflow_id}</td><td><StatusBadge value={w.last_status} /></td><td className="mono faint">{ago(w.last_at)}</td>
                <td>{w.runs_24h}</td><td className={w.errors_24h ? "bear" : ""}>{w.errors_24h}</td><td className="mono">{w.avg_duration_ms == null ? "—" : `${(w.avg_duration_ms / 1000).toFixed(1)}s`}</td>
                <td className="muted" style={{ fontSize: 12 }}>{w.last_error ?? ""}</td></tr>
            ))}</tbody></table>
        )}
      </Card>
      <div className="grid g2">
        <Card title="Recent executions">
          {!d.data?.recent?.length ? <Empty title="None" /> : (
            <div className="table-wrap"><table className="t"><thead><tr><th>Finished</th><th>Workflow</th><th>Execution</th><th>Status</th><th>Duration</th></tr></thead><tbody>
              {d.data.recent.map((r: any) => (
                <tr key={`${r.workflow_id}-${r.execution_id}`}><td className="mono faint">{ts(r.finished_at)}</td><td>{r.workflow_name ?? r.workflow_id}</td><td className="mono">{r.execution_id}</td>
                  <td><StatusBadge value={r.status} /></td><td className="mono">{r.duration_ms == null ? "—" : `${(r.duration_ms / 1000).toFixed(1)}s`}</td></tr>
              ))}</tbody></table></div>
          )}
        </Card>
        <Card title="n8n API" right={<StatusBadge value={remote?.status} />}>
          {remote?.status !== "ok" ? <div className="muted">{remote?.detail ?? "—"}</div> : (
            <>
              <table className="t"><thead><tr><th>Workflow</th><th>Active</th><th>Updated</th></tr></thead><tbody>
                {remote.workflows.map((w: any) => <tr key={w.id}><td>{w.name}</td><td><StatusBadge value={w.active ? "ok" : "idle"} label={w.active ? "active" : "inactive"} /></td><td className="mono faint">{ts(w.updatedAt)}</td></tr>)}
              </tbody></table>
              <div className="stat-label" style={{ marginTop: 12 }}>Executions</div>
              <table className="t"><tbody>{remote.executions.slice(0, 15).map((e: any) => (
                <tr key={e.id}><td className="mono">{e.id}</td><td>{e.workflowId}</td><td><StatusBadge value={e.status} /></td><td className="mono faint">{ts(e.startedAt)}</td></tr>
              ))}</tbody></table>
            </>
          )}
          <p className="faint" style={{ fontSize: 11.5 }}>Workflow activation and editing happen in the n8n editor, which should be reachable only over a private network or VPN.</p>
        </Card>
      </div>
    </div>
  );
}

export function DataMonitor({ me }: { me: Me }) {
  const d = useApi<{ sources: SourceHealth[]; freshness: any[]; missing_by_design: string[]; as_of: string }>("/data/sources", 30000);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const ingest = async () => {
    setBusy(true);
    try {
      setRes(await api.post("/service/ingest", { sources: [] }));
      d.reload();
    } catch (e) {
      setRes({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid" style={{ gap: 14 }}>
      <ErrorNote error={d.error} />
      <Card title="Source health" right={<>{me.role !== "viewer" && <button className="btn sm" onClick={ingest} disabled={busy}>{busy ? "Ingesting…" : "Run ingestion now"}</button>}<Updated at={d.updatedAt} /></>}>
        <div className="table-wrap"><table className="t"><thead><tr><th>Source</th><th>Status</th><th>Last success</th><th>Failures</th><th>Latency</th><th>Rate limit</th><th>Last error</th></tr></thead><tbody>
          {d.data?.sources.map((s) => (
            <tr key={s.source}><td>{s.source}</td><td><StatusBadge value={s.status} /></td><td className="mono faint">{ago(s.last_success_at)}</td><td>{s.consecutive_failures}</td>
              <td className="mono">{s.latency_ms == null ? "—" : `${s.latency_ms}ms`}</td><td className="mono" style={{ fontSize: 11 }}>{Object.keys(s.rate_limit).length ? JSON.stringify(s.rate_limit) : "—"}</td>
              <td className="muted" style={{ fontSize: 12 }}>{s.last_error ?? ""}</td></tr>
          ))}</tbody></table></div>
        {res && <pre className="pre" style={{ marginTop: 10 }}>{JSON.stringify(res, null, 2)}</pre>}
      </Card>
      <Card title="Freshness by series">
        {!d.data?.freshness.length ? <Empty title="No stored data">Nothing has been ingested yet. Market APIs must be reachable from the server.</Empty> : (
          <div className="table-wrap"><table className="t"><thead><tr><th>Series</th><th>Kind</th><th>Source</th><th>Latest observation</th><th>Age</th><th>Quality</th></tr></thead><tbody>
            {d.data.freshness.map((f) => (
              <tr key={`${f.key}-${f.source}`}><td className="mono">{f.key}</td><td>{f.kind}</td><td>{f.source}</td><td className="mono faint">{ts(f.last)}</td><td className="mono">{age(f.age_seconds)}</td>
                <td>{f.quality === "simulated" ? <DataTag kind="SIMULATED" /> : f.stale ? <DataTag kind="STALE" /> : <StatusBadge value="ok" label="fresh" />}</td></tr>
            ))}</tbody></table></div>
        )}
      </Card>
      <Card title="Known gaps (no free verified source configured)">
        <div className="row">{d.data?.missing_by_design.map((m) => <span key={m} className="badge warn">{m}</span>)}</div>
      </Card>
    </div>
  );
}

export function TelegramControl(_: { me: Me }) {
  const d = useApi<any>("/telegram/status", 30000);
  const s = d.data;
  return (
    <div className="grid" style={{ gap: 14 }}>
      <ErrorNote error={d.error} />
      {s && (
        <div className="grid g4">
          <Card title="Bot token"><StatusBadge value={s.bot_configured ? "configured" : "not_configured"} /></Card>
          <Card title="Webhook secret"><StatusBadge value={s.webhook_secret_configured ? "configured" : "not_configured"} /></Card>
          <Card title="Authorized users"><div className="stat-value">{s.authorized_users_configured}</div><div className="stat-sub">IDs are kept server-side</div></Card>
          <Card title="Rate limit"><div className="stat-value">{s.rate_limit_per_minute}/min</div><div className="stat-sub">per user</div></Card>
        </div>
      )}
      <div className="notice info">The bot answers only allow-listed user IDs, checked before any data is read. Chat messages cannot place orders or change risk/security settings. Replies are built from persisted backend data, in Indonesian by default.</div>
      <div className="grid g2">
        <Card title="Recent requests">
          {!s?.requests?.length ? <Empty title="No requests yet" /> : (
            <table className="t"><thead><tr><th>Time</th><th>User</th><th>Intent</th><th>Status</th><th>Latency</th></tr></thead><tbody>
              {s.requests.map((r: any) => (
                <tr key={r.id}><td className="mono faint">{ts(r.created_at)}</td><td className="mono">{String(r.user_id)}</td><td>{r.intent ?? "—"}</td><td><StatusBadge value={r.status} /></td><td className="mono">{r.latency_ms ?? "—"}ms</td></tr>
              ))}</tbody></table>
          )}
        </Card>
        <Card title="Scheduled deliveries">
          {!s?.deliveries?.length ? <Empty title="No deliveries yet" /> : (
            <table className="t"><tbody>{s.deliveries.map((n: any, i: number) => (
              <tr key={i}><td className="mono faint">{ts(n.created_at)}</td><td>{n.kind}</td><td><StatusBadge value={n.status} /></td><td className="muted" style={{ fontSize: 12 }}>{n.error ?? ""}</td></tr>
            ))}</tbody></table>
          )}
        </Card>
      </div>
    </div>
  );
}

export function MexcPage({ me }: { me: Me }) {
  const d = useApi<any>("/mexc/status", 30000);
  const [res, setRes] = useState<any>(null);
  const sync = async () => {
    try {
      setRes(await api.post("/mexc/sync"));
      d.reload();
    } catch (e) {
      setRes({ error: (e as Error).message });
    }
  };
  const s = d.data;
  return (
    <div className="grid" style={{ gap: 14 }}>
      <ErrorNote error={d.error} />
      {s && (
        <>
          <div className="grid g4">
            <Card title="Connection"><StatusBadge value={s.configured ? "configured" : "not_configured"} /></Card>
            <Card title="Mode"><span className="badge info">read-only</span></Card>
            <Card title="Live execution"><span className="badge bad">disabled</span></Card>
            <Card title="Live API verified"><StatusBadge value={s.verified_against_live_api ? "ok" : "warning"} label={s.verified_against_live_api ? "yes" : "not yet"} /></Card>
          </div>
          <div className="notice">{s.verification_note} {s.data_kind}.</div>
          <Card title="Account snapshots" right={<>{me.role !== "viewer" && <button className="btn sm" onClick={sync} disabled={!s.configured}>Sync now</button>}<DataTag kind="ACTUAL" /></>}>
            <table className="t"><thead><tr><th>Snapshot</th><th>Status</th><th>Fetched</th><th>Freshness</th><th>Detail</th></tr></thead><tbody>
              {Object.entries(s.snapshots).map(([k, v]: [string, any]) => (
                <tr key={k}><td>{k}</td><td><StatusBadge value={v.status} /></td><td className="mono faint">{ts(v.fetched_at)}</td><td>{v.fetched_at ? (v.stale ? <DataTag kind="STALE" /> : "fresh") : "—"}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{v.error ?? (v.payload ? <pre className="pre" style={{ maxHeight: 160 }}>{JSON.stringify(v.payload, null, 1)}</pre> : "")}</td></tr>
              ))}</tbody></table>
            {res && <pre className="pre" style={{ marginTop: 10 }}>{JSON.stringify(res, null, 2)}</pre>}
          </Card>
          <Card title="Activation requirements for live trading (all must pass; none are met)">
            <Kv rows={[["Separate explicit authorization", "not given"], ["Paper-trading validation period", "not completed"], ["Security review", "not done"],
              ["Contract-specific risk verified vs exchange", "not verified"], ["Order reconciliation vs exchange", "not verified"], ["Emergency stop tested end-to-end with exchange", "not done"]]} />
          </Card>
        </>
      )}
    </div>
  );
}
