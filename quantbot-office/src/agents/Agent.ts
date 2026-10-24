import { Group, Vector3, type Object3D } from 'three';
import type { FloorId, SpotDef } from '../config/layout';
import type { CharacterDef } from '../config/roster';
import type { NavGraph } from '../core/NavGraph';
import type { SimTime } from '../core/SimTime';
import type { SpotRegistry } from '../core/Spots';
import { speechDuration, type BubbleLayer } from '../ui/Bubbles';
import type { Activity, Avatar, AvatarState } from './Avatar';

export interface AgentDeps {
  nav: NavGraph;
  spots: SpotRegistry;
  time: SimTime;
  bubbles: BubbleLayer;
}

const WALK_SPEED = 1.35;
const TURN_RATE = 7;
const TWO_PI = Math.PI * 2;
const wrap = (a: number) => ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
const v3 = (p: [number, number, number]) => new Vector3(p[0], p[1], p[2]);

/**
 * A character in the office: owns position/heading, walks the nav graph,
 * occupies spots, talks via bubbles. All actions are promise-based so
 * scenarios read like a script: `await atlas.goTo('meeting-L0')`.
 */
export class Agent {
  readonly root = new Group();
  readonly id: string;
  heading = 0;
  posture: 'stand' | 'sit' = 'stand';
  activity: Activity = 'none';
  talking = false;
  /** Owned by a scenario; idle behaviour leaves busy agents alone. */
  busy = false;
  status = 'Di meja';
  /** Animation time until which the director lets this agent rest at its desk. */
  restUntil = 0;
  nextIdle = 0;
  spotId: string | null = null;
  lookTarget: Agent | null = null;

  private node: string | null = null;
  private path: Vector3[] = [];
  private arrive: (() => void) | null = null;
  private targetHeading: number | null = null;
  private turnDone: (() => void) | null = null;
  private avatarObj: Object3D;
  private readonly lane: number;
  private readonly tag: Object3D;

  constructor(readonly def: CharacterDef, public avatar: Avatar, private readonly deps: AgentDeps, index: number) {
    this.id = def.id;
    this.lane = 0.22 + (index % 4) * 0.06;
    this.avatarObj = avatar.object;
    this.root.add(avatar.object);
    this.tag = deps.bubbles.attach(def, avatar.height);
    this.root.add(this.tag);
  }

  get walking(): boolean {
    return this.path.length > 0;
  }

  get floor(): FloorId {
    return this.root.position.y > 2 ? 1 : 0;
  }

  get atHome(): boolean {
    return this.spotId === this.def.home && !this.walking;
  }

  /** Swap the visual body (e.g. once a .glb finished loading). */
  setAvatar(avatar: Avatar): void {
    this.root.remove(this.avatarObj);
    this.avatar = avatar;
    this.avatarObj = avatar.object;
    this.root.add(avatar.object);
    this.deps.bubbles.setHeight(this.id, avatar.height);
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
    this.deps.bubbles.setVisible(this.id, visible);
  }

  /** Teleport onto a spot (used at start-up and for recovery). */
  place(spotId: string): void {
    const s = this.deps.spots.get(spotId);
    if (this.spotId) this.deps.spots.release(this.spotId, this.id);
    this.deps.spots.reserve(spotId, this.id);
    this.path = [];
    this.arrive?.();
    this.arrive = null;
    this.root.position.copy(v3(s.pos));
    this.heading = s.facing;
    this.posture = s.posture;
    this.spotId = spotId;
    this.node = s.node;
  }

  /** Walk to a spot (reserving it), turn to its facing and sit if it is a seat. */
  async goTo(spotId: string, activity: Activity = 'none'): Promise<void> {
    const { spots, nav, time } = this.deps;
    const target = spots.get(spotId);
    if (!spots.reserve(spotId, this.id)) throw new Error(`${this.id}: spot ${spotId} is taken by ${spots.ownerOf(spotId)}`);
    if (this.spotId === spotId) {
      this.activity = activity;
      return;
    }
    const from = this.spotId ? spots.get(this.spotId) : null;

    this.activity = 'none';
    this.lookTarget = null;
    if (this.posture === 'sit') {
      this.posture = 'stand';
      await time.wait(0.45);
    }

    const startNode = this.node ?? nav.nearest(this.root.position);
    const route = nav.path(startNode, target.node);
    if (!route) throw new Error(`${this.id}: no route ${startNode} -> ${target.node}`);

    if (from) spots.release(from.id, this.id);
    this.spotId = spotId;
    this.node = target.node;

    await this.follow(this.buildPath(from, route, target));
    await this.turnTo(target.facing);
    if (target.posture === 'sit') {
      this.posture = 'sit';
      await time.wait(0.5);
    }
    this.activity = activity;
  }

  goHome(activity: Activity = 'type'): Promise<void> {
    return this.goTo(this.def.home, activity);
  }

  /** Show a chat bubble and gesture until the line has been "spoken". */
  async say(text: string): Promise<void> {
    const duration = speechDuration(text);
    this.deps.bubbles.show(this.id, text, duration);
    this.talking = true;
    await this.deps.time.wait(duration);
    this.talking = false;
  }

  turnTo(heading: number): Promise<void> {
    this.turnDone?.();
    this.targetHeading = heading;
    return new Promise((resolve) => { this.turnDone = resolve; });
  }

  turnToward(other: Agent): Promise<void> {
    const d = other.root.position.clone().sub(this.root.position);
    return this.turnTo(Math.atan2(d.x, d.z));
  }

  update(dt: number): void {
    let speed = 0;
    if (this.path.length) {
      const pos = this.root.position;
      const target = this.path[0];
      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const step = WALK_SPEED * dt;
      if (dist <= step || dist < 1e-4) {
        pos.copy(target);
        this.path.shift();
        if (!this.path.length) {
          const done = this.arrive;
          this.arrive = null;
          done?.();
        }
      } else {
        const f = step / dist;
        pos.x += dx * f;
        pos.z += dz * f;
        pos.y += (target.y - pos.y) * f;
        this.rotateToward(Math.atan2(dx, dz), dt);
        speed = WALK_SPEED;
      }
    } else if (this.targetHeading !== null) {
      const remaining = this.rotateToward(this.targetHeading, dt);
      if (Math.abs(remaining) < 0.02) {
        this.heading = this.targetHeading;
        this.targetHeading = null;
        const done = this.turnDone;
        this.turnDone = null;
        done?.();
      }
    }
    this.root.rotation.y = this.heading;

    let lookYaw = 0;
    if (this.lookTarget) {
      const d = this.lookTarget.root.position.clone().sub(this.root.position);
      lookYaw = wrap(Math.atan2(d.x, d.z) - this.heading);
    }
    const state: AvatarState = {
      posture: speed > 0 ? 'walk' : this.posture,
      activity: speed > 0 ? 'none' : this.activity,
      talking: this.talking,
      speed,
      lookYaw,
    };
    this.avatar.update(dt, state);
  }

  private rotateToward(goal: number, dt: number): number {
    const diff = wrap(goal - this.heading);
    const stepMax = TURN_RATE * dt;
    this.heading = wrap(this.heading + Math.max(-stepMax, Math.min(stepMax, diff)));
    return wrap(goal - this.heading);
  }

  private follow(points: Vector3[]): Promise<void> {
    this.arrive?.();
    this.path = points;
    return new Promise((resolve) => { this.arrive = resolve; });
  }

  /** Spot → approach → nav nodes (offset into a walking lane) → approach → spot. */
  private buildPath(from: SpotDef | null, route: string[], target: SpotDef): Vector3[] {
    const { nav } = this.deps;
    const pts: Vector3[] = [];
    if (from?.approach) pts.push(v3(from.approach));
    const nodePts = route.map((id) => nav.pos(id).clone());
    const before = pts.length ? pts[pts.length - 1] : this.root.position.clone();
    const after = target.approach ? v3(target.approach) : v3(target.pos);
    nodePts.forEach((p, i) => {
      const prev = i === 0 ? before : nav.pos(route[i - 1]);
      const next = i === nodePts.length - 1 ? after : nav.pos(route[i + 1]);
      const din = new Vector3(p.x - prev.x, 0, p.z - prev.z).normalize();
      const dout = new Vector3(next.x - p.x, 0, next.z - p.z).normalize();
      const dir = din.add(dout);
      if (dir.lengthSq() > 1e-6) {
        dir.normalize();
        // Keep to the right-hand side of the walking direction.
        p.x += -dir.z * this.lane;
        p.z += dir.x * this.lane;
      }
    });
    pts.push(...nodePts);
    if (target.approach) pts.push(v3(target.approach));
    pts.push(v3(target.pos));
    return pts;
  }
}
