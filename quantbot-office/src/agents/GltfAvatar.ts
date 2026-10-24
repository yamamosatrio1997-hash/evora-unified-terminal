import { AnimationMixer, Box3, Group, LoopRepeat, type AnimationAction, type AnimationClip } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Avatar, AvatarState } from './Avatar';

/** Animation slots the simulation asks for. Map each to a clip name inside your .glb. */
export type ClipKey =
  | 'idle' | 'walk' | 'sit' | 'type' | 'talk' | 'sitTalk' | 'think'
  | 'drink' | 'billiard' | 'pingpong' | 'gamepad';

export interface ModelDef {
  /** URL relative to the site root, e.g. "models/odin.glb". */
  url: string;
  scale?: number;
  /** Vertical offset in metres (if the model's origin is not at its feet). */
  yOffset?: number;
  /** Extra yaw in radians if the model does not face +Z. */
  rotationY?: number;
  /** Override the measured height (used for bubble placement). */
  height?: number;
  clips?: Partial<Record<ClipKey, string>>;
}

/** Fallback chain per slot: the first clip that exists is played. */
const FALLBACK: Record<ClipKey, ClipKey[]> = {
  idle: ['idle'],
  walk: ['walk', 'idle'],
  sit: ['sit', 'idle'],
  type: ['type', 'sit', 'idle'],
  talk: ['talk', 'idle'],
  sitTalk: ['sitTalk', 'talk', 'sit', 'idle'],
  think: ['think', 'sit', 'idle'],
  drink: ['drink', 'idle'],
  billiard: ['billiard', 'idle'],
  pingpong: ['pingpong', 'idle'],
  gamepad: ['gamepad', 'sit', 'idle'],
};

const loader = new GLTFLoader();
const cache = new Map<string, Promise<GLTF>>();

export function loadGltf(url: string): Promise<GLTF> {
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(url);
    cache.set(url, p);
  }
  return p;
}

export async function loadGltfAvatar(def: ModelDef): Promise<GltfAvatar> {
  return new GltfAvatar(await loadGltf(def.url), def);
}

function slotFor(s: AvatarState): ClipKey {
  if (s.posture === 'walk') return 'walk';
  const seated = s.posture === 'sit';
  if (s.talking && s.activity !== 'billiard' && s.activity !== 'pingpong') return seated ? 'sitTalk' : 'talk';
  switch (s.activity) {
    case 'type': return 'type';
    case 'think': return seated ? 'think' : 'idle';
    case 'drink': return 'drink';
    case 'billiard': return 'billiard';
    case 'pingpong': return 'pingpong';
    case 'gamepad': return 'gamepad';
    default: return seated ? 'sit' : 'idle';
  }
}

/** Rigged glTF character driven by named animation clips. */
export class GltfAvatar implements Avatar {
  readonly object = new Group();
  readonly height: number;
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<ClipKey, AnimationAction>();
  private current: AnimationAction | null = null;

  constructor(gltf: GLTF, def: ModelDef) {
    const model = cloneSkinned(gltf.scene);
    model.scale.setScalar(def.scale ?? 1);
    model.rotation.y = def.rotationY ?? 0;
    model.position.y = def.yOffset ?? 0;
    model.traverse((o) => { o.castShadow = true; });
    this.object.add(model);
    this.height = def.height ?? Math.max(0.5, new Box3().setFromObject(model).max.y);

    this.mixer = new AnimationMixer(model);
    const find = (name: string): AnimationClip | undefined =>
      gltf.animations.find((c) => c.name === name)
      ?? gltf.animations.find((c) => c.name.toLowerCase().includes(name.toLowerCase()));
    for (const [key, name] of Object.entries(def.clips ?? {}) as [ClipKey, string][]) {
      const clip = find(name);
      if (clip) this.actions.set(key, this.mixer.clipAction(clip).setLoop(LoopRepeat, Infinity));
      else console.warn(`[GltfAvatar] clip "${name}" (${key}) not found in ${def.url}`);
    }
    if (!this.actions.has('idle') && gltf.animations[0]) {
      this.actions.set('idle', this.mixer.clipAction(gltf.animations[0]));
    }
  }

  update(dt: number, s: AvatarState): void {
    const key = FALLBACK[slotFor(s)].find((k) => this.actions.has(k));
    const next = key ? this.actions.get(key)! : null;
    if (next && next !== this.current) {
      next.reset().fadeIn(0.3).play();
      this.current?.fadeOut(0.3);
      this.current = next;
    }
    if (this.current && key === 'walk') this.current.timeScale = Math.max(0.5, s.speed / 1.35);
    this.mixer.update(dt);
  }
}
