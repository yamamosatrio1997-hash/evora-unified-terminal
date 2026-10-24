import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Billboard, Html, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { Line2 } from "three-stdlib";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { AGENTS, BY_ROLE } from "../Mascot";
import type { WallCandle } from "../TradingFloor";
import { KIND_COLOR, LINK_LIFE_MS, type CommLink, type Lang, type OfficeAgent, type OfficeSceneProps } from "./types";
import { DESKS, VIEWS } from "./layout";

/*
 * 3D office. Agents are uniform voxel "AI employees" that differ only by colour (same rule as the
 * 2D mascots). Everything that moves in response to work is driven by props; the only ambient
 * motion is decor (server-rack LEDs, hologram ring, idle breathing).
 */

type V2 = [number, number];
const TABLE: V2 = [0.5, 0.5];
const TABLE_R = 2.55;


const RESEARCH = new Set(["macro", "fundamental", "onchain", "flow", "technical"]);
const RACKS: V2[] = [[-11.6, -8.6], [-10.1, -8.6], [-8.6, -8.6], [-11.6, -5.6]];

const ROOMS: { key: string; rect: [number, number, number, number]; color: string; en: string; id: string }[] = [
  { key: "data", rect: [-12.6, -7.4, -9.6, -3.6], color: "#38bdf8", en: "DATA CENTER", id: "PUSAT DATA" },
  { key: "quant", rect: [-6.6, 0.6, -9.6, -4.4], color: "#F472B6", en: "QUANT LAB", id: "LAB KUANT" },
  { key: "risk", rect: [5, 12.6, -9.6, -3.4], color: "#34D399", en: "RISK VAULT", id: "BRANKAS RISIKO" },
  { key: "research", rect: [-12.6, -3.4, -2.4, 9.6], color: "#FACC15", en: "RESEARCH WING", id: "SAYAP RISET" },
  { key: "debate", rect: [-2.6, 3.6, -3, 4], color: "#C084FC", en: "DEBATE ROOM", id: "RUANG DEBAT" },
  { key: "review", rect: [5, 12.6, -2.4, 3.2], color: "#F87171", en: "REVIEW BOOTH", id: "BILIK TINJAUAN" },
  { key: "office", rect: [5, 12.6, 4.2, 9.6], color: "#FB923C", en: "FUND MANAGER", id: "MANAJER DANA" },
];



function seatAt(role: string): { pos: V2; rot: number } {
  const i = AGENTS.findIndex((a) => a.role === role);
  const a = (i / AGENTS.length) * Math.PI * 2 + Math.PI / 9;
  const x = TABLE[0] + Math.sin(a) * TABLE_R;
  const z = TABLE[1] + Math.cos(a) * TABLE_R;
  return { pos: [x, z], rot: Math.atan2(TABLE[0] - x, TABLE[1] - z) };
}
const homeOf = (role: string): V2 => [DESKS[role][0], DESKS[role][1] - 0.85];

/** Live world positions of each agent's head, shared with the effects layer. */
type PosMap = Record<string, THREE.Vector3>;

const dampAngle = (a: number, b: number, k: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

// ---------------------------------------------------------------- agents

function Employee({ role, agent, positions, selected, hovered, onHover, onSelect, lang }: {
  role: string; agent: OfficeAgent; positions: PosMap; selected: boolean; hovered: boolean;
  onHover: (r: string | null) => void; onSelect: (r: string) => void; lang: Lang;
}) {
  const p = BY_ROLE[role];
  const color = useMemo(() => new THREE.Color(p.color), [p.color]);
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Mesh>(null);
  const armR = useRef<THREE.Mesh>(null);
  const legL = useRef<THREE.Mesh>(null);
  const legR = useRef<THREE.Mesh>(null);
  const eyes = useRef<THREE.Group>(null);
  const led = useRef<THREE.MeshStandardMaterial>(null);
  const ring = useRef<THREE.Mesh>(null);
  const seed = useMemo(() => AGENTS.findIndex((a) => a.role === role) * 1.7, [role]);
  const start = homeOf(role);
  const pos = useRef(new THREE.Vector3(start[0], 0, start[1]));
  const [walking, setWalking] = useState(false);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const goal = agent.atTable ? seatAt(role) : { pos: homeOf(role), rot: 0 };
    const g = new THREE.Vector3(goal.pos[0], 0, goal.pos[1]);
    const d = g.clone().sub(pos.current);
    const dist = d.length();
    const moving = dist > 0.04;
    if (moving) pos.current.add(d.multiplyScalar(Math.min(1, (5.5 * dt) / dist)));
    if (moving !== walking) setWalking(moving);
    if (!root.current || !body.current) return;
    root.current.position.copy(pos.current);
    const face = moving ? Math.atan2(g.x - pos.current.x, g.z - pos.current.z) : goal.rot;
    root.current.rotation.y = dampAngle(root.current.rotation.y, face, 1 - Math.exp(-8 * dt));
    // gait / typing / breathing
    const swing = moving ? Math.sin(t * 11) * 0.6 : 0;
    if (legL.current && legR.current) { legL.current.rotation.x = swing; legR.current.rotation.x = -swing; }
    const typing = agent.active && !moving ? Math.sin(t * 18 + seed) * 0.25 : 0;
    if (armL.current && armR.current) {
      armL.current.rotation.x = moving ? -swing : -0.5 + typing;
      armR.current.rotation.x = moving ? swing : -0.5 - typing;
    }
    const bob = agent.active ? Math.abs(Math.sin(t * 6 + seed)) * 0.07 : Math.sin(t * 1.4 + seed) * 0.012;
    body.current.position.y = bob;
    // blink: eyes squash for ~120ms every few seconds
    if (eyes.current) eyes.current.scale.y = (t + seed) % 3.6 < 0.12 ? 0.15 : 1;
    if (led.current) led.current.emissiveIntensity = agent.active ? 1.6 + Math.sin(t * 10) * 0.8 : 0.25;
    if (ring.current) {
      const k = (t * 0.9 + seed) % 1;
      ring.current.visible = agent.active;
      ring.current.scale.setScalar(0.6 + k * 1.3);
      (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k);
    }
    positions[role] = (positions[role] ?? new THREE.Vector3()).set(pos.current.x, 1.55 + bob, pos.current.z);
  });

  const over = (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(role); };
  const out = () => onHover(null);
  const click = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect(role); };
  const dim = new THREE.Color(p.color).multiplyScalar(0.55);

  return (
    <group ref={root} onPointerOver={over} onPointerOut={out} onClick={click}>
      {/* soft contact shadow */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.012}><circleGeometry args={[0.42, 24]} /><meshBasicMaterial color="#000" transparent opacity={0.35} /></mesh>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={0.02}><ringGeometry args={[0.45, 0.52, 40]} /><meshBasicMaterial color={color} transparent opacity={0.5} toneMapped={false} /></mesh>
      {(selected || hovered) && (
        <mesh rotation-x={-Math.PI / 2} position-y={0.025}><ringGeometry args={[0.55, 0.62, 40]} /><meshBasicMaterial color={selected ? "#ffffff" : color} toneMapped={false} /></mesh>
      )}
      <mesh ref={legL} position={[-0.13, 0.42, 0]}><boxGeometry args={[0.16, 0.42, 0.18]} /><meshStandardMaterial color="#1f2937" /></mesh>
      <mesh ref={legR} position={[0.13, 0.42, 0]}><boxGeometry args={[0.16, 0.42, 0.18]} /><meshStandardMaterial color="#1f2937" /></mesh>
      <group ref={body}>
        {/* torso (agent colour) with a lighter chest panel and lanyard badge */}
        <mesh position={[0, 0.82, 0]}><boxGeometry args={[0.56, 0.48, 0.34]} /><meshStandardMaterial color={color} roughness={0.55} /></mesh>
        <mesh position={[0, 0.84, 0.172]}><boxGeometry args={[0.2, 0.22, 0.01]} /><meshStandardMaterial color="#f8fafc" /></mesh>
        <mesh position={[0, 0.86, 0.178]}><boxGeometry args={[0.12, 0.04, 0.01]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} /></mesh>
        <mesh ref={armL} position={[-0.36, 0.95, 0]} geometry={ARM}><meshStandardMaterial color={dim} /></mesh>
        <mesh ref={armR} position={[0.36, 0.95, 0]} geometry={ARM}><meshStandardMaterial color={dim} /></mesh>
        {/* head: rounded block, dark visor, blinking eyes */}
        <mesh position={[0, 1.3, 0]}><boxGeometry args={[0.66, 0.5, 0.52]} /><meshStandardMaterial color={color} roughness={0.4} /></mesh>
        <mesh position={[0, 1.3, 0.262]}><boxGeometry args={[0.52, 0.3, 0.01]} /><meshStandardMaterial color="#0b1220" roughness={0.2} metalness={0.3} /></mesh>
        <group ref={eyes} position={[0, 1.31, 0.27]}>
          <mesh position={[-0.12, 0, 0]}><boxGeometry args={[0.08, 0.1, 0.01]} /><meshBasicMaterial color={agent.state === "veto" || agent.state === "error" ? "#F87171" : "#e0f2fe"} toneMapped={false} /></mesh>
          <mesh position={[0.12, 0, 0]}><boxGeometry args={[0.08, 0.1, 0.01]} /><meshBasicMaterial color={agent.state === "veto" || agent.state === "error" ? "#F87171" : "#e0f2fe"} toneMapped={false} /></mesh>
        </group>
        <mesh position={[0, 1.62, 0]}><cylinderGeometry args={[0.015, 0.015, 0.16, 6]} /><meshStandardMaterial color="#94a3b8" /></mesh>
        <mesh position={[0, 1.72, 0]}><sphereGeometry args={[0.05, 12, 12]} /><meshStandardMaterial ref={led} color={color} emissive={color} emissiveIntensity={0.25} toneMapped={false} /></mesh>
      </group>
      <Html position={[0, 2.05, 0]} center distanceFactor={11} zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        <div className={`o3-name${agent.active ? " on" : ""}`} style={{ ["--agent" as string]: p.color }}>{p.name}</div>
      </Html>
      {agent.bubble && !walking && (
        <Html position={[0, 2.55, 0]} center distanceFactor={11} zIndexRange={[30, 10]} style={{ pointerEvents: "none" }}>
          <div className="o3-bubble" style={{ ["--agent" as string]: p.color }}>{agent.bubble}</div>
        </Html>
      )}
      {hovered && (
        <Html position={[0.7, 1.4, 0]} distanceFactor={11} zIndexRange={[40, 20]} style={{ pointerEvents: "none" }}>
          <div className="o3-tip" style={{ ["--agent" as string]: p.color }}>
            <b>{p.name}</b> · {lang === "id" ? p.titleId : p.title}<br /><span>{agent.state}</span>
          </div>
        </Html>
      )}
    </group>
  );
}
const ARM = new THREE.BoxGeometry(0.13, 0.42, 0.15).translate(0, -0.18, 0);

// ---------------------------------------------------------------- furniture

function Desk({ role, active, alert }: { role: string; active: boolean; alert: boolean }) {
  const [x, z] = DESKS[role];
  const color = BY_ROLE[role].color;
  const big = role === "fund_manager";
  const w = big ? 2.1 : 1.6;
  const scan = useRef<THREE.Group>(null);
  useFrame((s) => {
    if (scan.current) {
      scan.current.visible = active;
      scan.current.position.y = 1.02 + ((s.clock.elapsedTime * 0.8) % 1) * 0.32;
    }
  });
  const screen = alert ? "#F87171" : active ? color : "#14302a";
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.74, 0]}><boxGeometry args={[w, 0.06, 0.9]} /><meshStandardMaterial color="#334155" roughness={0.7} /></mesh>
      <mesh position={[0, 0.37, 0.38]}><boxGeometry args={[w - 0.1, 0.7, 0.04]} /><meshStandardMaterial color="#1e293b" /></mesh>
      {[-w / 2 + 0.06, w / 2 - 0.06].map((lx) => (
        <mesh key={lx} position={[lx, 0.37, 0]}><boxGeometry args={[0.05, 0.72, 0.8]} /><meshStandardMaterial color="#1e293b" /></mesh>
      ))}
      {/* three monitors facing the agent (who sits on the far side), backs glow toward the camera */}
      {[-0.5, 0, 0.5].map((mx, i) => (
        <group key={mx} position={[mx * (big ? 1.25 : 1), 0, 0.05]} rotation-y={(i - 1) * -0.35}>
          <mesh position={[0, 1.08, 0]}><boxGeometry args={[0.46, 0.32, 0.04]} /><meshStandardMaterial color="#0f172a" /></mesh>
          <mesh position={[0, 1.08, -0.022]}><planeGeometry args={[0.42, 0.28]} /><meshBasicMaterial color={screen} side={THREE.BackSide} toneMapped={false} /></mesh>
          <mesh position={[0, 1.08, 0.022]}><boxGeometry args={[0.3, 0.02, 0.002]} /><meshBasicMaterial color={active || alert ? screen : "#1f2937"} toneMapped={false} /></mesh>
          <mesh position={[0, 0.84, 0]}><boxGeometry args={[0.04, 0.16, 0.04]} /><meshStandardMaterial color="#475569" /></mesh>
        </group>
      ))}
      <group ref={scan}><mesh position={[0, 0, -0.01]}><boxGeometry args={[w * 0.95, 0.008, 0.01]} /><meshBasicMaterial color={color} toneMapped={false} /></mesh></group>
      {/* chair behind desk */}
      <mesh position={[0, 0.45, -0.95]}><boxGeometry args={[0.5, 0.08, 0.5]} /><meshStandardMaterial color="#111827" /></mesh>
      <mesh position={[0, 0.75, -1.18]}><boxGeometry args={[0.5, 0.55, 0.07]} /><meshStandardMaterial color={color} roughness={0.8} /></mesh>
      {/* nameplate strip */}
      <mesh position={[0, 0.66, 0.405]}><boxGeometry args={[0.5, 0.08, 0.01]} /><meshBasicMaterial color={color} toneMapped={false} /></mesh>
    </group>
  );
}

function RoomZones({ lang }: { lang: Lang }) {
  return (
    <group>
      {ROOMS.map((r) => {
        const [x0, x1, z0, z1] = r.rect;
        const pts: [number, number, number][] = [[x0, 0.03, z0], [x1, 0.03, z0], [x1, 0.03, z1], [x0, 0.03, z1], [x0, 0.03, z0]];
        return (
          <group key={r.key}>
            <mesh rotation-x={-Math.PI / 2} position={[(x0 + x1) / 2, 0.006, (z0 + z1) / 2]}>
              <planeGeometry args={[x1 - x0, z1 - z0]} /><meshBasicMaterial color={r.color} transparent opacity={0.05} />
            </mesh>
            <Line points={pts} color={r.color} lineWidth={1.4} transparent opacity={0.55} />
            {/* low glass partition along the back edge */}
            <mesh position={[(x0 + x1) / 2, 0.45, z0]}><boxGeometry args={[x1 - x0, 0.9, 0.04]} /><meshStandardMaterial color={r.color} transparent opacity={0.08} /></mesh>
            <Html position={[x0 + 0.25, 0.05, z1 - 0.25]} distanceFactor={12} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
              <div className="o3-room" style={{ ["--room" as string]: r.color }}>{lang === "id" ? r.id : r.en}</div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

function DataCenter({ hot }: { hot: boolean }) {
  const leds = useRef<THREE.InstancedMesh>(null);
  const N = RACKS.length * 12;
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  useEffect(() => {
    if (!leds.current) return;
    RACKS.forEach(([x, z], r) => {
      for (let i = 0; i < 12; i++) {
        tmp.position.set(x - 0.2 + (i % 3) * 0.2, 0.35 + Math.floor(i / 3) * 0.42, z + 0.42);
        tmp.updateMatrix();
        leds.current!.setMatrixAt(r * 12 + i, tmp.matrix);
      }
    });
    leds.current.instanceMatrix.needsUpdate = true;
  }, [tmp]);
  useFrame((s) => {
    if (!leds.current) return;
    const t = s.clock.elapsedTime * (hot ? 9 : 2.5);
    for (let i = 0; i < N; i++) {
      const on = Math.sin(t + i * 2.17) > (hot ? -0.2 : 0.4);
      leds.current.setColorAt(i, col.set(on ? (i % 5 === 0 ? "#FACC15" : "#38bdf8") : "#0b2533"));
    }
    if (leds.current.instanceColor) leds.current.instanceColor.needsUpdate = true;
  });
  return (
    <group>
      {RACKS.map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, 0.95, z]}><boxGeometry args={[0.9, 1.9, 0.8]} /><meshStandardMaterial color="#0f172a" metalness={0.4} roughness={0.5} /></mesh>
      ))}
      <instancedMesh ref={leds} args={[undefined, undefined, N]}>
        <boxGeometry args={[0.12, 0.04, 0.02]} /><meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

function RiskVault({ vetoAt }: { vetoAt?: number | null }) {
  const door = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);
  useFrame((_, dt) => {
    const age = vetoAt ? Date.now() - vetoAt : Infinity;
    if (door.current) door.current.rotation.z += dt * (age < 3000 ? 4 : 0.15);
    if (light.current) light.current.intensity = age < 3000 ? 18 * Math.abs(Math.sin(age / 120)) : 0;
  });
  return (
    <group position={[DESKS.risk[0], 0, -9.35]}>
      <mesh position={[0, 1.5, 0]}><boxGeometry args={[3.4, 3, 0.3]} /><meshStandardMaterial color="#111827" metalness={0.5} roughness={0.4} /></mesh>
      <group ref={door} position={[0, 1.55, 0.2]}>
        <mesh><torusGeometry args={[0.95, 0.12, 12, 40]} /><meshStandardMaterial color="#34D399" emissive="#34D399" emissiveIntensity={0.35} metalness={0.6} /></mesh>
        <mesh><cylinderGeometry args={[0.8, 0.8, 0.1, 32]} /><meshStandardMaterial color="#1f2937" metalness={0.7} roughness={0.3} /></mesh>
        {[0, 1, 2].map((i) => (
          <mesh key={i} rotation-z={(i * Math.PI) / 3} position-z={0.08}><boxGeometry args={[1.3, 0.07, 0.05]} /><meshStandardMaterial color="#94a3b8" metalness={0.8} /></mesh>
        ))}
      </group>
      <pointLight ref={light} position={[0, 2, 2]} color="#F87171" intensity={0} distance={14} />
    </group>
  );
}

function QuantBoard() {
  return (
    <group position={[-3, 0, -9.4]}>
      <mesh position={[0, 1.7, 0]}><boxGeometry args={[4.2, 2, 0.08]} /><meshStandardMaterial color="#e2e8f0" roughness={0.9} /></mesh>
      {Array.from({ length: 14 }, (_, i) => (
        <mesh key={i} position={[-1.8 + i * 0.27, 1.1 + 0.15 + Math.abs(Math.sin(i * 1.3)) * 1.1 * 0.5, 0.05]}>
          <boxGeometry args={[0.16, 0.3 + Math.abs(Math.sin(i * 1.3)) * 1.1, 0.01]} />
          <meshBasicMaterial color={i % 4 === 3 ? "#F87171" : "#F472B6"} />
        </mesh>
      ))}
    </group>
  );
}

function Plant({ at }: { at: [number, number] }) {
  return (
    <group position={[at[0], 0, at[1]]}>
      <mesh position-y={0.22}><cylinderGeometry args={[0.2, 0.16, 0.44, 12]} /><meshStandardMaterial color="#78350f" /></mesh>
      <mesh position-y={0.7}><icosahedronGeometry args={[0.38, 0]} /><meshStandardMaterial color="#166534" flatShading /></mesh>
      <mesh position={[0.12, 0.98, 0.05]}><icosahedronGeometry args={[0.24, 0]} /><meshStandardMaterial color="#15803d" flatShading /></mesh>
    </group>
  );
}

// ---------------------------------------------------------------- screens & hologram

function CandleBars({ candles, width, height }: { candles: WallCandle[]; width: number; height: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const MAX = 64;
  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const cs = candles.slice(-MAX);
    const lo = Math.min(...cs.map((c) => c.l));
    const hi = Math.max(...cs.map((c) => c.h));
    const span = hi - lo || 1;
    const tmp = new THREE.Object3D();
    const col = new THREE.Color();
    const step = width / Math.max(cs.length, 1);
    for (let i = 0; i < MAX; i++) {
      const c = cs[i];
      if (!c) { tmp.scale.setScalar(0); tmp.updateMatrix(); m.setMatrixAt(i, tmp.matrix); continue; }
      const y0 = ((Math.min(c.o, c.c) - lo) / span) * height;
      const y1 = ((Math.max(c.o, c.c) - lo) / span) * height;
      tmp.position.set(-width / 2 + step * (i + 0.5), -height / 2 + (y0 + y1) / 2, 0);
      tmp.scale.set(step * 0.6, Math.max(y1 - y0, height * 0.01), 1);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      m.setColorAt(i, col.set(c.c >= c.o ? "#34D399" : "#F87171"));
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [candles, width, height]);
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, MAX]}>
      <planeGeometry args={[1, 1]} /><meshBasicMaterial toneMapped={false} side={THREE.DoubleSide} />
    </instancedMesh>
  );
}

function WallScreen({ candles, label, badge }: { candles: WallCandle[]; label: string; badge?: string }) {
  return (
    <group position={[2.8, 2.35, -9.95]}>
      <mesh position-z={-0.05}><boxGeometry args={[4.2, 2.1, 0.08]} /><meshStandardMaterial color="#0b1220" /></mesh>
      <group position={[0, -0.12, 0]}><CandleBars candles={candles} width={3.8} height={1.45} /></group>
      <Html position={[-1.95, 0.95, 0]} distanceFactor={14} zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
        <div className="o3-wall">{label}{badge ? <span>{badge}</span> : null}</div>
      </Html>
    </group>
  );
}

function Hologram({ candles, round, agents }: { candles: WallCandle[]; round?: string | null; agents: Record<string, OfficeAgent> }) {
  const ring = useRef<THREE.Group>(null);
  const anyActive = Object.values(agents).some((a) => a.active);
  useFrame((_, dt) => { if (ring.current) ring.current.rotation.y += dt * (anyActive ? 1.2 : 0.25); });
  return (
    <group position={[TABLE[0], 0, TABLE[1]]}>
      <mesh position-y={0.72}><cylinderGeometry args={[1.65, 1.65, 0.08, 48]} /><meshStandardMaterial color="#1e1b4b" metalness={0.3} roughness={0.35} /></mesh>
      <mesh position-y={0.36}><cylinderGeometry args={[0.35, 0.5, 0.7, 16]} /><meshStandardMaterial color="#111827" /></mesh>
      <mesh position-y={0.77}><cylinderGeometry args={[0.5, 0.5, 0.02, 32]} /><meshBasicMaterial color="#C084FC" toneMapped={false} transparent opacity={0.8} /></mesh>
      {/* light cone */}
      <mesh position-y={1.6}><cylinderGeometry args={[1.25, 0.5, 1.6, 32, 1, true]} /><meshBasicMaterial color="#C084FC" transparent opacity={anyActive ? 0.1 : 0.04} side={THREE.DoubleSide} depthWrite={false} /></mesh>
      <group ref={ring} position-y={2.45}>
        <mesh rotation-x={Math.PI / 2}><torusGeometry args={[1.25, 0.015, 8, 64]} /><meshBasicMaterial color="#C084FC" toneMapped={false} /></mesh>
        {AGENTS.map((a, i) => {
          const ang = (i / AGENTS.length) * Math.PI * 2;
          return (
            <mesh key={a.role} position={[Math.sin(ang) * 1.25, 0, Math.cos(ang) * 1.25]}>
              <boxGeometry args={[0.12, 0.12, 0.12]} /><meshBasicMaterial color={agents[a.role]?.active ? a.color : "#334155"} toneMapped={false} />
            </mesh>
          );
        })}
      </group>
      <Billboard position-y={1.75}>
        <mesh><planeGeometry args={[2.1, 1.05]} /><meshBasicMaterial color="#0b1020" transparent opacity={0.55} side={THREE.DoubleSide} depthWrite={false} /></mesh>
        <group position-z={0.01}><CandleBars candles={candles} width={1.9} height={0.8} /></group>
      </Billboard>
      {round && (
        <Html position={[0, 3.05, 0]} center distanceFactor={12} zIndexRange={[25, 5]} style={{ pointerEvents: "none" }}>
          <div className="o3-round">{round}</div>
        </Html>
      )}
    </group>
  );
}

// ---------------------------------------------------------------- communication effects

function targetPoint(to: string, positions: PosMap): THREE.Vector3 | null {
  if (to === "table") return new THREE.Vector3(TABLE[0], 2.2, TABLE[1]);
  return positions[to] ?? null;
}

function CommArc({ link, positions }: { link: CommLink; positions: PosMap }) {
  const line = useRef<Line2>(null);
  const group = useRef<THREE.Group>(null);
  const dots = useRef<(THREE.Mesh | null)[]>([]);
  const ping = useRef<THREE.Mesh>(null);
  const color = KIND_COLOR[link.kind] ?? BY_ROLE[link.from]?.color ?? "#e2e8f0";
  const curve = useMemo(() => new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()), []);
  const flat = useMemo(() => new Float32Array(33 * 3), []);
  useFrame((_, dt) => {
    const a = positions[link.from];
    const b = targetPoint(link.to, positions);
    const age = (Date.now() - link.at) / LINK_LIFE_MS;
    if (!group.current) return;
    group.current.visible = !!a && !!b && age >= 0 && age < 1;
    if (!a || !b || !group.current.visible) return;
    const mid = a.clone().lerp(b, 0.5);
    mid.y += 0.8 + a.distanceTo(b) * 0.28;
    curve.v0.copy(a); curve.v1.copy(mid); curve.v2.copy(b);
    const pts = curve.getPoints(32);
    pts.forEach((p, i) => flat.set([p.x, p.y, p.z], i * 3));
    const fade = age < 0.8 ? 1 : 1 - (age - 0.8) / 0.2;
    if (line.current) {
      line.current.geometry.setPositions(flat);
      line.current.computeLineDistances();
      const m = line.current.material;
      m.dashOffset -= dt * 2.2;
      m.opacity = 0.75 * fade;
    }
    dots.current.forEach((d, i) => {
      if (!d) return;
      const tt = Math.min(1, Math.max(0, age * 1.6 - i * 0.12));
      d.visible = tt > 0 && tt < 1;
      d.position.copy(curve.getPoint(tt));
      d.scale.setScalar(1 - i * 0.22);
    });
    if (ping.current) {
      const k = Math.max(0, age * 1.6 - 0.95);
      ping.current.visible = k > 0 && k < 0.8;
      ping.current.position.copy(b);
      ping.current.scale.setScalar(0.2 + k * 1.6);
      (ping.current.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k / 0.8);
      ping.current.lookAt(ping.current.position.clone().add(new THREE.Vector3(0, 1, 0)));
    }
  });
  return (
    <group ref={group} visible={false}>
      <Line ref={line} points={[[0, 0, 0], [0, 0.01, 0]]} color={color} lineWidth={2.2} dashed dashSize={0.35} gapSize={0.18} transparent opacity={0.75} />
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} ref={(m) => { dots.current[i] = m; }}>
          <sphereGeometry args={[0.09, 10, 10]} /><meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      ))}
      <mesh ref={ping}><ringGeometry args={[0.35, 0.45, 32]} /><meshBasicMaterial color={color} transparent toneMapped={false} side={THREE.DoubleSide} /></mesh>
    </group>
  );
}

function VetoShockwave({ at }: { at: number }) {
  const rings = useRef<(THREE.Mesh | null)[]>([]);
  const [x, z] = homeOf("risk");
  useFrame(() => {
    const age = (Date.now() - at) / 1000;
    rings.current.forEach((r, i) => {
      if (!r) return;
      const k = age - i * 0.35;
      r.visible = k > 0 && k < 1.8;
      r.scale.setScalar(0.5 + k * 9);
      (r.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.7 * (1 - k / 1.8));
    });
  });
  return (
    <group position={[x, 0.05, z]}>
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={(m) => { rings.current[i] = m; }} rotation-x={-Math.PI / 2} visible={false}>
          <ringGeometry args={[0.92, 1, 64]} /><meshBasicMaterial color="#F87171" transparent toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      ))}
      <Html position={[0, 3.1, 0]} center distanceFactor={11} zIndexRange={[45, 30]} style={{ pointerEvents: "none" }}>
        <div className="o3-veto">VETO</div>
      </Html>
    </group>
  );
}

function DecisionSpotlight({ text }: { text: string }) {
  const cone = useRef<THREE.Mesh>(null);
  const [x, z] = homeOf("fund_manager");
  useFrame((s) => {
    if (cone.current) (cone.current.material as THREE.MeshBasicMaterial).opacity = 0.13 + Math.sin(s.clock.elapsedTime * 4) * 0.04;
  });
  return (
    <group position={[x, 0, z]}>
      <mesh ref={cone} position-y={3}><cylinderGeometry args={[0.15, 1.15, 6, 32, 1, true]} /><meshBasicMaterial color="#FDE68A" transparent opacity={0.13} side={THREE.DoubleSide} depthWrite={false} /></mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.02}><circleGeometry args={[1.15, 40]} /><meshBasicMaterial color="#FDE68A" transparent opacity={0.22} depthWrite={false} /></mesh>
      <Html position={[TABLE[0] - x, 4.15, TABLE[1] - z]} center distanceFactor={11} zIndexRange={[45, 30]} style={{ pointerEvents: "none" }}>
        <div className="o3-decision">{text}</div>
      </Html>
    </group>
  );
}

/** Particles flowing from the data center to research desks while data is arriving or an analyst is working. */
function DataStreams({ targets }: { targets: string[] }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const PER = 10;
  const N = 5 * PER;
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const src = new THREE.Vector3(-9.6, 0.25, -4.6);
  useFrame((s) => {
    const m = mesh.current;
    if (!m) return;
    const t = s.clock.elapsedTime;
    for (let k = 0; k < 5; k++) {
      const role = targets[k];
      for (let j = 0; j < PER; j++) {
        const idx = k * PER + j;
        if (!role) { tmp.scale.setScalar(0); tmp.updateMatrix(); m.setMatrixAt(idx, tmp.matrix); continue; }
        const [dx, dz] = DESKS[role];
        const u = (t * 0.55 + j / PER) % 1;
        tmp.position.set(src.x + (dx - src.x) * u, 0.12 + Math.sin(u * Math.PI) * 0.6, src.z + (dz + 0.5 - src.z) * u);
        tmp.scale.setScalar(0.8 + Math.sin(u * Math.PI) * 0.6);
        tmp.updateMatrix();
        m.setMatrixAt(idx, tmp.matrix);
      }
    }
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, N]}>
      <boxGeometry args={[0.07, 0.07, 0.07]} /><meshBasicMaterial color="#38bdf8" toneMapped={false} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------- camera

export type FocusGoal = () => { target: [number, number, number]; pos: [number, number, number] };

function CameraRig({ focusKey, goal }: { focusKey: string; goal: FocusGoal }) {
  const { camera, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: OrbitControlsImpl | null };
  const until = useRef(0);
  const toVec = () => { const r = goal(); return { target: new THREE.Vector3(...r.target), pos: new THREE.Vector3(...r.pos) }; };
  const g = useRef(toVec());
  useEffect(() => { g.current = toVec(); until.current = performance.now() + 1600; }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const look = useRef(new THREE.Vector3(...VIEWS.overview.target));
  useFrame((_, dt) => {
    if (performance.now() > until.current) return;
    const k = 1 - Math.exp(-4.5 * dt);
    camera.position.lerp(g.current.pos, k);
    if (controls) {
      controls.target.lerp(g.current.target, k);
      controls.update();
    } else {
      look.current.lerp(g.current.target, k);
      camera.lookAt(look.current);
    }
  });
  return null;
}

// ---------------------------------------------------------------- scene root

export interface OfficeCanvasProps extends OfficeSceneProps {
  selected: string | null;
  focusKey: string;
  focusGoal: FocusGoal;
  onSelect: (role: string) => void;
  controls: "full" | "lite" | "none";
  paused: boolean;
}

export default function OfficeCanvas(props: OfficeCanvasProps) {
  const { agents, links, candles, wallLabel, wallBadge, roundLabel, decision, vetoAt, dataAt, lang, selected, onSelect, controls, paused } = props;
  const positions = useRef<PosMap>({}).current;
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => { document.body.style.cursor = hovered ? "pointer" : ""; return () => { document.body.style.cursor = ""; }; }, [hovered]);
  const now = Date.now();
  const dataHot = !!dataAt && now - dataAt < 4000;
  const streamTargets = AGENTS.filter((a) => RESEARCH.has(a.role) && (dataHot || agents[a.role]?.active) && !agents[a.role]?.atTable).map((a) => a.role);
  const alert = !!vetoAt && now - vetoAt < 3000;
  return (
    <Canvas className="o3-canvas" frameloop={paused ? "never" : "always"} dpr={[1, 1.6]} gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ position: VIEWS.overview.pos, fov: 42, near: 0.1, far: 200 }}
      onPointerMissed={() => setHovered(null)}
      onCreated={({ gl, setDpr }) => {
        // Software rasterizers (no GPU) cannot keep up with high-DPI rendering.
        const ctx = gl.getContext();
        const ext = ctx.getExtension("WEBGL_debug_renderer_info");
        const name = String(ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "");
        if (/swiftshader|llvmpipe|software/i.test(name)) setDpr(1);
      }}>
      <color attach="background" args={["#070b14"]} />
      <fog attach="fog" args={["#070b14", 30, 60]} />
      <hemisphereLight args={["#c7d2fe", "#0b1020", 0.75]} />
      <ambientLight intensity={0.25} />
      <directionalLight position={[8, 16, 9]} intensity={1.15} />
      <directionalLight position={[-10, 8, -6]} intensity={0.35} color="#93c5fd" />

      <mesh rotation-x={-Math.PI / 2}><planeGeometry args={[27, 21]} /><meshStandardMaterial color="#0d1424" roughness={0.95} /></mesh>
      <gridHelper args={[27, 27, "#1e293b", "#131c2e"]} position-y={0.004} />
      {/* back + side walls */}
      <mesh position={[0, 2, -10.05]}><boxGeometry args={[27, 4, 0.1]} /><meshStandardMaterial color="#0f172a" /></mesh>
      <mesh position={[-13.55, 2, 0]}><boxGeometry args={[0.1, 4, 20.2]} /><meshStandardMaterial color="#0f172a" /></mesh>

      <RoomZones lang={lang} />
      <DataCenter hot={dataHot} />
      <RiskVault vetoAt={vetoAt} />
      <QuantBoard />
      <Plant at={[11.8, 9]} /><Plant at={[5.6, 9]} /><Plant at={[-3.9, -2]} /><Plant at={[3.9, 3.6]} />
      <WallScreen candles={candles} label={wallLabel} badge={wallBadge} />
      <Hologram candles={candles} round={roundLabel} agents={agents} />

      {AGENTS.map((a) => (
        <Desk key={a.role} role={a.role} active={!!agents[a.role]?.active} alert={alert && a.role === "risk"} />
      ))}
      {AGENTS.map((a) => (
        <Employee key={a.role} role={a.role} agent={agents[a.role] ?? { state: "idle", active: false }} positions={positions}
          selected={selected === a.role} hovered={hovered === a.role} onHover={setHovered} onSelect={onSelect} lang={lang} />
      ))}

      {links.map((l) => <CommArc key={l.id} link={l} positions={positions} />)}
      <DataStreams targets={streamTargets} />
      {alert && vetoAt && <VetoShockwave key={vetoAt} at={vetoAt} />}
      {decision && now - decision.at < 9000 && <DecisionSpotlight text={decision.text} />}

      {controls !== "none" && (
        <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.08} enableZoom={controls === "full"}
          minDistance={6} maxDistance={34} maxPolarAngle={1.3} minPolarAngle={0.25} target={VIEWS.overview.target} />
      )}
      <CameraRig focusKey={props.focusKey} goal={props.focusGoal} />
    </Canvas>
  );
}
