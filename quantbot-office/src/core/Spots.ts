import type { SpotDef } from '../config/layout';
import { shuffle } from './random';

/** Seats and standing points, with single-occupant reservations. */
export class SpotRegistry {
  private readonly byId = new Map<string, SpotDef>();
  private readonly owner = new Map<string, string>();

  constructor(spots: SpotDef[]) {
    for (const s of spots) {
      if (this.byId.has(s.id)) throw new Error(`Duplicate spot "${s.id}"`);
      this.byId.set(s.id, s);
    }
  }

  get(id: string): SpotDef {
    const s = this.byId.get(id);
    if (!s) throw new Error(`Unknown spot "${id}"`);
    return s;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  all(): SpotDef[] {
    return [...this.byId.values()];
  }

  isFree(id: string): boolean {
    return !this.owner.has(id);
  }

  ownerOf(id: string): string | undefined {
    return this.owner.get(id);
  }

  /** Reserve for `who`; returns false when someone else holds it. */
  reserve(id: string, who: string): boolean {
    this.get(id);
    const cur = this.owner.get(id);
    if (cur && cur !== who) return false;
    this.owner.set(id, who);
    return true;
  }

  release(id: string, who: string): void {
    if (this.owner.get(id) === who) this.owner.delete(id);
  }

  freeWithTag(tag: string): SpotDef[] {
    return this.all().filter((s) => s.tags.includes(tag) && this.isFree(s.id));
  }

  /** `n` free spots from one random group carrying `tag`, or null if no group has room. */
  freeGroup(tag: string, n: number): SpotDef[] | null {
    const groups = new Map<string, SpotDef[]>();
    for (const s of this.freeWithTag(tag)) {
      const key = s.group ?? s.id;
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    const fitting = shuffle([...groups.values()].filter((g) => g.length >= n));
    return fitting.length ? shuffle(fitting[0]).slice(0, n) : null;
  }
}
