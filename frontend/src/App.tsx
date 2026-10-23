import { useEffect, useState, type FormEvent } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { api, ApiError } from "./lib/api";
import { EventsProvider, useEvents } from "./lib/events";
import CommandCenter from "./pages/CommandCenter";
import MarketIntel from "./pages/MarketIntel";
import AgentNetworkPage from "./pages/AgentNetworkPage";
import DebateRoom from "./pages/DebateRoom";
import QuantLab from "./pages/QuantLab";
import RiskCenter from "./pages/RiskCenter";
import { DataMonitor, MexcPage, N8nCenter, TelegramControl } from "./pages/Operations";
import PaperTerminal from "./pages/PaperTerminal";
import SettingsPage from "./pages/Settings";

export interface Me { username: string; role: string }

const PAGES = [
  { path: "/", label: "Command Center", el: CommandCenter, section: "Monitor" },
  { path: "/market", label: "Market Intelligence", el: MarketIntel },
  { path: "/agents", label: "Agent Network", el: AgentNetworkPage },
  { path: "/debate", label: "Debate Room", el: DebateRoom },
  { path: "/quant", label: "Quant Lab", el: QuantLab, section: "Research & Risk" },
  { path: "/risk", label: "Risk Center", el: RiskCenter },
  { path: "/paper", label: "Paper Trading", el: PaperTerminal },
  { path: "/n8n", label: "n8n Control", el: N8nCenter, section: "Operations" },
  { path: "/data", label: "Data Monitor", el: DataMonitor },
  { path: "/telegram", label: "Telegram Control", el: TelegramControl },
  { path: "/mexc", label: "MEXC Integration", el: MexcPage },
  { path: "/settings", label: "Settings", el: SettingsPage },
] as const;

function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onLogin(await api.post<Me>("/auth/login", { username: u, password: p }));
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 429 ? "Too many attempts; wait a few minutes." : "Invalid credentials.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100%", padding: 16, position: "relative", zIndex: 1 }}>
      <motion.form onSubmit={submit} className="card" style={{ width: 360, padding: 26 }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="brand" style={{ padding: "0 0 18px" }}>
          <div className="brand-mark" />
          <div>
            <div className="brand-title">AI Trading Command Center</div>
            <div className="brand-sub">Research · Paper mode</div>
          </div>
        </div>
        <label className="field">Username<input autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} required /></label>
        <div style={{ height: 10 }} />
        <label className="field">Password<input type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required /></label>
        {err && <div className="notice bad" style={{ marginTop: 12 }}>{err}</div>}
        <button className="btn primary" style={{ width: "100%", justifyContent: "center", marginTop: 16 }} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="faint" style={{ fontSize: 11.5, marginTop: 14, marginBottom: 0 }}>Live order execution is disabled. All trading shown is simulated (paper).</p>
      </motion.form>
    </div>
  );
}

function LiveDot() {
  const { connected } = useEvents();
  return <span className={`badge ${connected ? "ok" : "warn"}`} title="Server-sent event stream"><span className="dot" />{connected ? "live" : "reconnecting"}</span>;
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const loc = useLocation();
  const reduce = useReducedMotion();
  const page = PAGES.find((p) => p.path === loc.pathname) ?? PAGES[0];
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-title">Command Center</div>
            <div className="brand-sub">Multi-agent · Paper</div>
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          {PAGES.map((p, i) => (
            <div key={p.path}>
              {"section" in p && p.section && <div className="nav-section">{p.section}</div>}
              <NavLink to={p.path} end={p.path === "/"}><span className="idx">{String(i + 1).padStart(2, "0")}</span>{p.label}</NavLink>
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="muted">{me.username} · <span className="mono">{me.role}</span></div>
          <button className="btn sm" style={{ marginTop: 8 }} onClick={onLogout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <h1>{page.label}</h1>
          <span className="badge info">Paper trading</span>
          <span className="badge">Live execution disabled</span>
          <div className="spacer" />
          <LiveDot />
        </header>
        <AnimatePresence mode="wait">
          <motion.div key={loc.pathname} className="page" initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0 }} transition={{ duration: 0.18 }}>
            <Routes location={loc}>
              {PAGES.map((p) => <Route key={p.path} path={p.path} element={<p.el me={me} />} />)}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    api.get<Me>("/auth/me").then(setMe).catch(() => setMe(null));
    const onUnauth = () => setMe(null);
    window.addEventListener("tcc:unauthorized", onUnauth);
    return () => window.removeEventListener("tcc:unauthorized", onUnauth);
  }, []);
  if (me === undefined) return null;
  if (me === null) return <Login onLogin={setMe} />;
  return (
    <EventsProvider enabled>
      <Shell me={me} onLogout={() => api.post("/auth/logout").finally(() => setMe(null))} />
    </EventsProvider>
  );
}
