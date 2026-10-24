import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { api } from "./lib/api";
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
import Landing from "./pages/public/Landing";
import { LoginPage, SignupPage, TermsPage } from "./pages/public/Auth";
import { Mascot } from "./components/Mascot";

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

function LiveDot() {
  const { connected } = useEvents();
  return <span className={`badge ${connected ? "ok" : "warn"}`} title="Server-sent event stream"><span className="dot" />{connected ? "live" : "reconnecting"}</span>;
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const loc = useLocation();
  const reduce = useReducedMotion();
  const sub = loc.pathname.replace(/^\/app/, "") || "/";
  const page = PAGES.find((p) => p.path === sub) ?? PAGES[0];
  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand" style={{ color: "inherit" }}>
          <Mascot role="fund_manager" size={28} />
          <div>
            <div className="brand-title">Evora Terminal</div>
            <div className="brand-sub">Multi-agent · Paper</div>
          </div>
        </NavLink>
        <nav className="nav" aria-label="Main">
          {PAGES.map((p, i) => (
            <div key={p.path}>
              {"section" in p && p.section && <div className="nav-section">{p.section}</div>}
              <NavLink to={p.path === "/" ? "/app" : `/app${p.path}`} end={p.path === "/"}><span className="idx">{String(i + 1).padStart(2, "0")}</span>{p.label}</NavLink>
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
            <Routes>
              {PAGES.map((p) => p.path === "/"
                ? <Route key="index" index element={<p.el me={me} />} />
                : <Route key={p.path} path={p.path.slice(1)} element={<p.el me={me} />} />)}
              <Route path="*" element={<Navigate to="/app" replace />} />
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
  return (
    <Routes>
      <Route path="/" element={<Landing loggedIn={!!me} />} />
      <Route path="/login" element={me ? <Navigate to="/app" replace /> : <LoginPage onAuth={setMe} />} />
      <Route path="/signup" element={me ? <Navigate to="/app" replace /> : <SignupPage onAuth={setMe} />} />
      <Route path="/terms" element={<TermsPage loggedIn={!!me} />} />
      <Route path="/app/*" element={me ? (
        <EventsProvider enabled>
          <Shell me={me} onLogout={() => api.post("/auth/logout").finally(() => setMe(null))} />
        </EventsProvider>
      ) : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
