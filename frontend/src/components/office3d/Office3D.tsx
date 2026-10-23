import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AGENTS } from "../Mascot";
import { KIND_COLOR, LINK_LIFE_MS, type Lang, type OfficeSceneProps, type ViewKey } from "./types";
import { DESKS, VIEWS } from "./layout";

const OfficeCanvas = lazy(() => import("./OfficeScene"));

const T = {
  en: {
    views: { overview: "Overview", debate: "Debate room", research: "Research wing", risk: "Risk & review" } as Record<ViewKey, string>,
    follow: "Follow debate", mode3d: "3D office", mode2d: "2D floor", agents: "Agents",
    legend: [["evidence", "Evidence"], ["challenge", "Challenge"], ["reply", "Reply"], ["synthesis", "Synthesis"], ["quant_validation", "Quant"], ["risk_review", "Risk"], ["veto", "Veto"]],
    hint: "Drag to orbit · scroll to zoom · click an employee",
    hintLite: "Drag to orbit · click an employee",
  },
  id: {
    views: { overview: "Ikhtisar", debate: "Ruang debat", research: "Sayap riset", risk: "Risiko & tinjauan" } as Record<ViewKey, string>,
    follow: "Ikuti debat", mode3d: "Kantor 3D", mode2d: "Lantai 2D", agents: "Agen",
    legend: [["evidence", "Bukti"], ["challenge", "Tantangan"], ["reply", "Jawaban"], ["synthesis", "Sintesis"], ["quant_validation", "Kuant"], ["risk_review", "Risiko"], ["veto", "Veto"]],
    hint: "Seret untuk memutar · scroll untuk zoom · klik karyawan",
    hintLite: "Seret untuk memutar · klik karyawan",
  },
} satisfies Record<Lang, unknown>;

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

const PREF_KEY = "evora.floor.mode";
function readPref(): "3d" | "2d" | null {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "3d" || v === "2d" ? v : null;
  } catch {
    return null;
  }
}

class GLBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export interface Office3DProps extends OfficeSceneProps {
  /** The 2D floor, shown when WebGL is unavailable, reduced motion is requested, or the viewer picks 2D. */
  fallback: ReactNode;
  onSelect?: (role: string) => void;
  caption?: string;
  /** "full" (dashboard): orbit + zoom. "lite" (homepage): orbit only so the page still scrolls. */
  controls?: "full" | "lite";
  height?: number;
  /** Start with "follow the debate" camera on. */
  followDefault?: boolean;
  /** Hide the agent chips and hint (homepage, where the team is introduced elsewhere). */
  compact?: boolean;
  /** Number of real events waiting to be replayed (live view only). */
  queued?: number;
}

/** 3D office with HUD, lazy-loaded scene, and an automatic 2D fallback. */
export function Office3D(props: Office3DProps) {
  const { fallback, onSelect, caption, controls = "full", height = 560, lang, links, followDefault = false, compact = false } = props;
  const t = T[lang];
  const [mode, setMode] = useState<"3d" | "2d">(() => {
    const pref = readPref();
    if (pref) return pref;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    return reduce ? "2d" : "3d";
  });
  const gl = useMemo(() => webglAvailable(), []);
  const coarse = useMemo(() => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches, []);
  const [view, setView] = useState<ViewKey>("overview");
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(followDefault);
  const [visible, setVisible] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  // Pause rendering while off-screen or in a background tab.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "120px" });
    io.observe(el);
    const vis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", vis);
    return () => { io.disconnect(); document.removeEventListener("visibilitychange", vis); };
  }, [mode]);

  // Re-render while time-based effects (arcs, veto, decision) are running so they mount/unmount on time.
  const [, setTick] = useState(0);
  const latestFx = Math.max(0, ...links.map((l) => l.at), props.vetoAt ?? 0, props.decision?.at ?? 0, props.dataAt ?? 0);
  useEffect(() => {
    if (Date.now() - latestFx > 10000) return;
    const i = window.setInterval(() => setTick((n) => n + 1), 400);
    const stop = window.setTimeout(() => window.clearInterval(i), 10500);
    return () => { window.clearInterval(i); window.clearTimeout(stop); };
  }, [latestFx]);

  const live = links.filter((l) => Date.now() - l.at < LINK_LIFE_MS);
  const lastLink = links.reduce<(typeof links)[number] | null>((a, l) => (!a || l.at > a.at ? l : a), null);
  // Follow mode: hold each shot at least 2.5 s so the camera does not whip between speakers.
  const [followRole, setFollowRole] = useState<string | null>(null);
  const shotAt = useRef(0);
  useEffect(() => {
    if (!follow) { setFollowRole(null); return; }
    if (!lastLink || Date.now() - lastLink.at > 6000) return;
    if (Date.now() - shotAt.current < 2500 && followRole) return;
    shotAt.current = Date.now();
    setFollowRole(lastLink.from);
  }, [follow, lastLink?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusRole = (follow && lastLink ? followRole : null) ?? selected;
  const followAtTable = !!focusRole && !!props.agents[focusRole]?.atTable;
  const focusKey = focusRole ? `agent:${focusRole}:${followAtTable ? "table" : "desk"}` : `view:${view}`;
  const focusGoal = () => {
    if (focusRole && followAtTable) return VIEWS.debate;
    if (focusRole && DESKS[focusRole]) {
      const [x, z] = DESKS[focusRole];
      return { target: [x, 1, z - 0.6] as [number, number, number], pos: [x + 2, 6.6, z + 8] as [number, number, number] };
    }
    const v = VIEWS[view];
    return { target: v.target, pos: v.pos };
  };

  const choose = (m: "3d" | "2d") => {
    setMode(m);
    try { localStorage.setItem(PREF_KEY, m); } catch { /* storage blocked: keep in-memory choice */ }
  };
  const select = (role: string) => { setSelected(role); setFollow(false); onSelect?.(role); };
  const pickView = (v: ViewKey) => { setView(v); setSelected(null); setFollow(false); };

  const show3d = mode === "3d" && gl;
  const toggle = gl ? (
    <div className="o3-toggle" role="group" aria-label="Floor view">
      <button type="button" className={show3d ? "on" : ""} onClick={() => choose("3d")}>{t.mode3d}</button>
      <button type="button" className={!show3d ? "on" : ""} onClick={() => choose("2d")}>{t.mode2d}</button>
    </div>
  ) : null;

  if (!show3d) return <div className="o3-wrap o3-flat">{toggle}{fallback}</div>;

  return (
    <div className="o3-wrap" ref={box}>
      <div className="o3-stage" style={{ height }}>
        <GLBoundary fallback={fallback}>
          <Suspense fallback={<div className="o3-loading">Loading 3D office…</div>}>
            <OfficeCanvas {...props} links={live} selected={selected} focusKey={focusKey} focusGoal={focusGoal}
              onSelect={select} controls={coarse && controls === "lite" ? "none" : controls} paused={!visible} />
          </Suspense>
        </GLBoundary>
        <div className="o3-hud o3-hud-tl">
          {props.roundLabel && <div className="o3-chip-round">{props.roundLabel}</div>}
          {props.wallBadge && <span className="o3-badge">{props.wallBadge}</span>}
          {!!props.queued && <span className="o3-badge o3-queue">{lang === "id" ? `PUTAR ULANG · ${props.queued} antre` : `REPLAY · ${props.queued} queued`}</span>}
        </div>
        <div className="o3-hud o3-hud-tr">
          {toggle}
          <div className="o3-views" role="group" aria-label="Camera">
            {(Object.keys(VIEWS) as ViewKey[]).map((v) => (
              <button key={v} type="button" className={!focusRole && view === v ? "on" : ""} onClick={() => pickView(v)}>{t.views[v]}</button>
            ))}
            <button type="button" className={follow ? "on" : ""} aria-pressed={follow} onClick={() => setFollow((f) => !f)}>◉ {t.follow}</button>
          </div>
        </div>
        {!compact && <div className="o3-hud o3-hud-bl">
          <div className="o3-agents" role="group" aria-label={t.agents}>
            {AGENTS.map((a) => (
              <button key={a.role} type="button" className={`o3-agent${props.agents[a.role]?.active ? " on" : ""}${selected === a.role ? " sel" : ""}`}
                style={{ ["--agent" as string]: a.color }} onClick={() => select(a.role)} aria-label={`${a.name}, ${lang === "id" ? a.titleId : a.title}`}>
                <i />{a.name}
              </button>
            ))}
          </div>
        </div>}
        <div className="o3-hud o3-hud-br">
          <div className="o3-legend">
            {t.legend.map(([k, l]) => <span key={k}><i style={{ background: KIND_COLOR[k] }} />{l}</span>)}
          </div>
          {!compact && <div className="o3-hint">{controls === "full" ? t.hint : t.hintLite}</div>}
        </div>
      </div>
      {caption && <div className="floor-caption">{caption}</div>}
    </div>
  );
}
