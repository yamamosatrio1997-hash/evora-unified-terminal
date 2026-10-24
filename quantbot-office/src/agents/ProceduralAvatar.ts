import {
  BoxGeometry, CapsuleGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, TorusGeometry,
  type Object3D,
} from 'three';
import type { Look, Role } from '../config/roster';
import type { Avatar, AvatarState } from './Avatar';

const materials = new Map<string, MeshStandardMaterial>();
function mat(color: string, roughness = 0.7, metalness = 0): MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}`;
  let m = materials.get(key);
  if (!m) {
    m = new MeshStandardMaterial({ color, roughness, metalness });
    materials.set(key, m);
  }
  return m;
}

function mesh(geo: ConstructorParameters<typeof Mesh>[0], material: MeshStandardMaterial, x = 0, y = 0, z = 0): Mesh {
  const m = new Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

const JOINTS = [
  'hipsY', 'hipsZ', 'hipsX', 'torsoX', 'headX', 'headY',
  'sLx', 'sLz', 'sRx', 'sRz', 'eL', 'eR', 'hLx', 'hRx', 'kL', 'kR',
] as const;
type Joint = (typeof JOINTS)[number];
type Pose = Record<Joint, number>;

const STAND_HIPS = 0.87;
const SIT_HIPS = 0.5;

/**
 * Low-poly character built from primitives, animated procedurally.
 * Rotation conventions (character faces +Z, its left is +X):
 *  - limb joints: negative X swings the limb forward;
 *  - torso/head: positive X leans forward;
 *  - shoulders: positive Z moves the arm toward +X (outward for the left arm).
 */
export class ProceduralAvatar implements Avatar {
  readonly object = new Group();
  readonly height: number;

  private readonly hips = new Group();
  private readonly torso = new Group();
  private readonly head = new Group();
  private readonly shoulderL = new Group();
  private readonly shoulderR = new Group();
  private readonly elbowL = new Group();
  private readonly elbowR = new Group();
  private readonly hipL = new Group();
  private readonly hipR = new Group();
  private readonly kneeL = new Group();
  private readonly kneeR = new Group();
  private readonly eyes: Mesh[] = [];
  private readonly mug: Object3D;
  private readonly cue: Object3D;
  private readonly paddle: Object3D;
  private readonly pad: Object3D;

  private cur: Pose = Object.fromEntries(JOINTS.map((j) => [j, 0])) as Pose;
  private t = Math.random() * 100;
  private phase = 0;
  private readonly seed = Math.random();
  private blinkIn = 2 + Math.random() * 3;

  constructor(look: Look, role: Role) {
    const scale = look.build ?? 1;
    this.height = 1.78 * scale;
    this.cur.hipsY = STAND_HIPS;

    const shirt = mat(look.shirt, look.suit ? 0.5 : 0.8);
    const pants = mat(look.pants, 0.8);
    const skin = mat(look.skin, 0.6);
    const hair = mat(look.hair, 0.9);
    const accent = mat(look.accent, 0.4, look.suit ? 0.6 : 0);
    const dark = mat('#111317', 0.5);
    const shoe = mat('#16181d', 0.6);

    const root = new Group();
    root.scale.setScalar(scale);
    this.object.add(root);
    root.add(this.hips);
    this.hips.position.y = STAND_HIPS;

    // Legs
    for (const [hip, knee, x] of [[this.hipL, this.kneeL, 0.1], [this.hipR, this.kneeR, -0.1]] as const) {
      hip.position.set(x, 0, 0);
      this.hips.add(hip);
      hip.add(mesh(new CapsuleGeometry(0.075, 0.3, 4, 8), pants, 0, -0.215, 0));
      knee.position.y = -0.43;
      hip.add(knee);
      knee.add(mesh(new CapsuleGeometry(0.065, 0.3, 4, 8), pants, 0, -0.2, 0));
      knee.add(mesh(new BoxGeometry(0.11, 0.07, 0.25), shoe, 0, -0.4, 0.05));
    }

    // Torso
    this.hips.add(this.torso);
    this.torso.add(mesh(new BoxGeometry(0.32, 0.16, 0.2), pants, 0, 0.03, 0));
    const chest = mesh(new CapsuleGeometry(0.165, 0.3, 4, 12), shirt, 0, 0.33, 0);
    chest.scale.z = 0.72;
    this.torso.add(chest);
    if (look.suit) {
      this.torso.add(mesh(new BoxGeometry(0.1, 0.32, 0.02), mat('#e5e7eb', 0.6), 0, 0.4, 0.11));
      this.torso.add(mesh(new BoxGeometry(0.04, 0.28, 0.02), accent, 0, 0.38, 0.125));
    } else if (look.hoodie) {
      const hood = mesh(new TorusGeometry(0.13, 0.035, 6, 14), shirt, 0, 0.6, -0.03);
      hood.rotation.x = Math.PI / 2.3;
      this.torso.add(hood);
      this.torso.add(mesh(new BoxGeometry(0.2, 0.08, 0.02), mat(look.accent, 0.5), 0, 0.42, 0.125));
    } else {
      this.torso.add(mesh(new BoxGeometry(0.07, 0.09, 0.02), role === 'trader' ? accent : mat('#f8fafc', 0.4), 0.08, 0.45, 0.12));
    }
    this.torso.add(mesh(new CylinderGeometry(0.05, 0.055, 0.08, 8), skin, 0, 0.62, 0));

    // Head
    this.head.position.y = 0.66;
    this.torso.add(this.head);
    this.head.add(mesh(new SphereGeometry(0.12, 16, 12), skin, 0, 0.12, 0));
    const hairCap = mesh(new SphereGeometry(0.128, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hair, 0, 0.13, -0.008);
    hairCap.rotation.x = -0.25;
    this.head.add(hairCap);
    for (const x of [0.045, -0.045]) {
      const eye = mesh(new SphereGeometry(0.017, 8, 6), dark, x, 0.13, 0.108);
      eye.castShadow = false;
      this.eyes.push(eye);
      this.head.add(eye);
    }
    if (look.headset) {
      const band = mesh(new TorusGeometry(0.135, 0.012, 6, 20, Math.PI), dark, 0, 0.13, 0);
      band.rotation.y = Math.PI / 2;
      this.head.add(band);
      for (const x of [0.13, -0.13]) {
        const cup = mesh(new CylinderGeometry(0.035, 0.035, 0.03, 10), dark, x, 0.12, 0);
        cup.rotation.z = Math.PI / 2;
        this.head.add(cup);
      }
      const mic = mesh(new BoxGeometry(0.012, 0.012, 0.11), dark, -0.12, 0.07, 0.06);
      mic.rotation.y = 0.5;
      this.head.add(mic);
    }

    // Arms
    for (const [shoulder, elbow, x] of [[this.shoulderL, this.elbowL, 0.215], [this.shoulderR, this.elbowR, -0.215]] as const) {
      shoulder.position.set(x, 0.5, 0);
      this.torso.add(shoulder);
      shoulder.add(mesh(new CapsuleGeometry(0.056, 0.2, 4, 8), shirt, 0, -0.14, 0));
      elbow.position.y = -0.28;
      shoulder.add(elbow);
      elbow.add(mesh(new CapsuleGeometry(0.05, 0.18, 4, 8), look.suit || look.hoodie ? shirt : skin, 0, -0.12, 0));
      elbow.add(mesh(new SphereGeometry(0.052, 10, 8), skin, 0, -0.27, 0));
    }

    // Props, attached to the right hand / forearm and toggled per activity.
    this.mug = mesh(new CylinderGeometry(0.04, 0.035, 0.1, 12), mat('#f1f5f9', 0.3), 0, -0.3, 0.05);
    this.cue = mesh(new CylinderGeometry(0.008, 0.014, 1.3, 6), mat('#c49a6c', 0.5), 0, -0.6, 0);
    const paddle = new Group();
    paddle.add(mesh(new CylinderGeometry(0.075, 0.075, 0.015, 16), mat('#dc2626', 0.6), 0, -0.36, 0.02));
    paddle.children[0].rotation.x = Math.PI / 2;
    this.paddle = paddle;
    this.pad = mesh(new BoxGeometry(0.16, 0.035, 0.09), dark, 0.09, -0.3, 0.04);
    for (const prop of [this.mug, this.cue, this.paddle, this.pad]) {
      prop.visible = false;
      this.elbowR.add(prop);
    }
  }

  update(dt: number, s: AvatarState): void {
    this.t += dt;
    const t = this.t;
    if (s.posture === 'walk') this.phase = (this.phase + dt * s.speed * 4.6) % (Math.PI * 2);
    const p = this.target(s, t);

    const k = 1 - Math.exp(-dt * 12);
    for (const j of JOINTS) this.cur[j] += (p[j] - this.cur[j]) * k;
    const c = this.cur;

    this.hips.position.set(c.hipsX, c.hipsY, c.hipsZ);
    this.torso.rotation.x = c.torsoX;
    this.head.rotation.set(c.headX, c.headY, 0);
    this.shoulderL.rotation.set(c.sLx, 0, c.sLz);
    this.shoulderR.rotation.set(c.sRx, 0, c.sRz);
    this.elbowL.rotation.x = c.eL;
    this.elbowR.rotation.x = c.eR;
    this.hipL.rotation.x = c.hLx;
    this.hipR.rotation.x = c.hRx;
    this.kneeL.rotation.x = c.kL;
    this.kneeR.rotation.x = c.kR;

    this.mug.visible = s.activity === 'drink';
    this.cue.visible = s.activity === 'billiard';
    this.paddle.visible = s.activity === 'pingpong';
    this.pad.visible = s.activity === 'gamepad';

    this.blinkIn -= dt;
    const blinking = this.blinkIn < 0;
    if (this.blinkIn < -0.12) this.blinkIn = 2 + Math.random() * 4;
    for (const e of this.eyes) e.scale.y = blinking ? 0.15 : 1;
  }

  /** Target joint values for this frame; the update loop eases toward them. */
  private target(s: AvatarState, t: number): Pose {
    const p: Pose = {
      hipsY: STAND_HIPS, hipsZ: 0, hipsX: 0, torsoX: 0.02 + Math.sin(t * 1.6) * 0.012, headX: 0,
      headY: Math.max(-1.1, Math.min(1.1, s.lookYaw)),
      sLx: 0.03, sLz: 0.07, sRx: 0.03, sRz: -0.07, eL: -0.12, eR: -0.12, hLx: 0, hRx: 0, kL: 0, kR: 0,
    };
    const seated = s.posture === 'sit';

    if (s.posture === 'walk') {
      const ph = this.phase;
      const sw = Math.sin(ph);
      p.hLx = -sw * 0.55;
      p.hRx = sw * 0.55;
      p.kL = 0.1 + Math.max(0, Math.cos(ph)) * 0.75;
      p.kR = 0.1 + Math.max(0, -Math.cos(ph)) * 0.75;
      p.sLx = sw * 0.45;
      p.sRx = -sw * 0.45;
      p.eL = p.eR = -0.3;
      p.hipsY = STAND_HIPS - 0.03 + Math.abs(Math.cos(ph)) * 0.03;
      p.torsoX = 0.06;
      return p;
    }

    if (seated) {
      p.hipsY = SIT_HIPS;
      p.hipsZ = -0.12;
      p.hLx = p.hRx = -1.5;
      p.kL = p.kR = 1.45;
      p.sLx = p.sRx = -0.25;
      p.eL = p.eR = -0.7;
      p.sLz = -0.05;
      p.sRz = 0.05;
    }

    switch (s.activity) {
      case 'type':
        p.sLx = p.sRx = -0.55;
        p.sLz = -0.12;
        p.sRz = 0.12;
        p.eL = -1.15 + Math.sin(t * 17) * 0.07;
        p.eR = -1.15 + Math.cos(t * 15 + 1) * 0.07;
        p.torsoX = 0.12;
        p.headX = 0.16 + Math.sin(t * 0.7) * 0.03;
        break;
      case 'think':
        p.torsoX = -0.08;
        p.sRx = -1.25;
        p.sRz = 0.3;
        p.eR = -2.0;
        p.headX = -0.05;
        break;
      case 'drink': {
        const sip = (t * 0.35 + this.seed) % 1 < 0.25;
        p.sRx = sip ? -0.95 : -0.35;
        p.sRz = sip ? 0.25 : 0.05;
        p.eR = sip ? -2.05 : -1.45;
        if (sip) p.headX = -0.18;
        break;
      }
      case 'billiard': {
        const aiming = (t * 0.12 + this.seed) % 1 < 0.65;
        if (aiming) {
          p.torsoX = 0.85;
          p.hipsY = STAND_HIPS - 0.04;
          p.hLx = -0.25;
          p.kL = 0.2;
          p.headX = -0.65;
          p.sLx = -1.35;
          p.eL = -0.25;
          p.sRx = -0.85;
          p.sRz = 0.1;
          p.eR = -1.05 + Math.max(0, Math.sin(t * 2.4)) * 0.5;
        } else {
          p.sRx = -0.2;
          p.eR = -0.4;
          p.sLz = 0.25;
        }
        break;
      }
      case 'pingpong':
        p.hipsY = STAND_HIPS - 0.08;
        p.hLx = p.hRx = -0.35;
        p.kL = p.kR = 0.6;
        p.hipsX = Math.sin(t * 2.6 + this.seed * 6) * 0.18;
        p.torsoX = 0.22;
        p.sRx = -0.6 + Math.sin(t * 5.2) * 0.5;
        p.sRz = -0.35 + Math.cos(t * 5.2) * 0.3;
        p.eR = -0.9;
        p.sLx = -0.4;
        p.eL = -0.9;
        break;
      case 'gamepad': {
        const hype = Math.max(0, Math.sin(t * 0.9 + this.seed * 5)) ** 8;
        p.sLx = p.sRx = -0.75 - hype * 0.6;
        p.sLz = -0.22;
        p.sRz = 0.22;
        p.eL = -1.25 + Math.sin(t * 19) * 0.04;
        p.eR = -1.25 + Math.cos(t * 21) * 0.04;
        p.torsoX = 0.15 - hype * 0.25;
        break;
      }
      case 'none':
        break;
    }

    if (s.talking && s.activity !== 'billiard' && s.activity !== 'pingpong') {
      const left = this.seed > 0.5;
      const gx = seated ? -0.65 : -0.5;
      const ex = seated ? -1.2 : -0.95;
      if (s.activity !== 'drink') {
        p.sRx = gx + Math.sin(t * 2.7) * 0.25;
        p.sRz = -0.2 + Math.sin(t * 1.3) * 0.1;
        p.eR = ex + Math.sin(t * 3.9) * 0.3;
      }
      if (left || s.activity === 'drink') {
        p.sLx = gx + Math.sin(t * 2.2 + 1) * 0.2;
        p.sLz = 0.2;
        p.eL = ex + Math.sin(t * 3.1 + 2) * 0.25;
      }
      p.headX += Math.sin(t * 4.5) * 0.06;
    }
    return p;
  }
}
