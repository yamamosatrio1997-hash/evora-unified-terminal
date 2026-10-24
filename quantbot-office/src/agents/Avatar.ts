import type { Object3D } from 'three';

export type Activity = 'none' | 'type' | 'think' | 'drink' | 'billiard' | 'pingpong' | 'gamepad';
export type BodyPosture = 'stand' | 'sit' | 'walk';

export interface AvatarState {
  posture: BodyPosture;
  activity: Activity;
  talking: boolean;
  /** Horizontal walking speed, m/s. */
  speed: number;
  /** Head yaw relative to the body, radians (positive = toward the character's left). */
  lookYaw: number;
}

/**
 * Visual body of a character. The Agent moves/rotates `object`; the avatar only
 * animates in place. Implementations: ProceduralAvatar (built-in) and GltfAvatar
 * (your own rigged .glb models).
 */
export interface Avatar {
  readonly object: Object3D;
  /** Approximate top-of-head height, used to anchor name tags and chat bubbles. */
  readonly height: number;
  update(dt: number, state: AvatarState): void;
}
