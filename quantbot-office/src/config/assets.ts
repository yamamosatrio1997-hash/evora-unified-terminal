/**
 * Optional 3D assets, read at start-up from `public/models/manifest.json`.
 * Without a manifest (or when a file fails to load) the built-in procedural
 * characters and office are used, so the simulation always runs.
 */
import type { ModelDef } from '../agents/GltfAvatar';
import type { CharacterDef, Role } from './roster';

export interface EnvironmentDef {
  url: string;
  scale?: number;
  position?: [number, number, number];
  rotationY?: number;
  /** Hide the procedural walls/furniture once your environment is loaded. */
  hideProcedural?: boolean;
}

export interface AssetManifest {
  models?: Record<string, ModelDef>;
  /** Character id -> model key (e.g. "odin": "odin"). Wins over `roles`. */
  characters?: Record<string, string>;
  /** Role -> model key (trader | lead | manager | owner). */
  roles?: Partial<Record<Role, string>>;
  environment?: EnvironmentDef | null;
}

export async function loadManifest(url = 'models/manifest.json'): Promise<AssetManifest> {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return {};
    return (await res.json()) as AssetManifest;
  } catch {
    return {};
  }
}

export function modelFor(manifest: AssetManifest, def: CharacterDef): ModelDef | null {
  const key = manifest.characters?.[def.id] ?? manifest.roles?.[def.role];
  return (key && manifest.models?.[key]) || null;
}
