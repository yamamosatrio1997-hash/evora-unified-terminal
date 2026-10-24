import { Vector3 } from 'three';
import type { NavNodeDef } from '../config/layout';

/** Waypoint graph with A* search. Edges are bidirectional and may climb stairs (3D). */
export class NavGraph {
  readonly nodes = new Map<string, Vector3>();
  private readonly adj = new Map<string, string[]>();

  constructor(defs: NavNodeDef[], edges: [string, string][]) {
    for (const d of defs) {
      if (this.nodes.has(d.id)) throw new Error(`Duplicate nav node "${d.id}"`);
      this.nodes.set(d.id, new Vector3(...d.pos));
      this.adj.set(d.id, []);
    }
    for (const [a, b] of edges) {
      if (!this.nodes.has(a) || !this.nodes.has(b)) throw new Error(`Nav edge ${a} -> ${b} references an unknown node`);
      this.adj.get(a)!.push(b);
      this.adj.get(b)!.push(a);
    }
  }

  pos(id: string): Vector3 {
    const p = this.nodes.get(id);
    if (!p) throw new Error(`Unknown nav node "${id}"`);
    return p;
  }

  nearest(p: Vector3): string {
    let best = '';
    let bestD = Infinity;
    for (const [id, n] of this.nodes) {
      const d = n.distanceToSquared(p) + Math.abs(n.y - p.y) * 100;
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  /** Node ids from `from` to `to` inclusive, or null when unreachable. */
  path(from: string, to: string): string[] | null {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;
    if (from === to) return [from];
    const goal = this.pos(to);
    const g = new Map<string, number>([[from, 0]]);
    const came = new Map<string, string>();
    const open = new Set([from]);
    const f = new Map<string, number>([[from, this.pos(from).distanceTo(goal)]]);
    while (open.size) {
      let cur = '';
      let curF = Infinity;
      for (const id of open) {
        const v = f.get(id) ?? Infinity;
        if (v < curF) { curF = v; cur = id; }
      }
      if (cur === to) {
        const out = [cur];
        while (came.has(out[0])) out.unshift(came.get(out[0])!);
        return out;
      }
      open.delete(cur);
      for (const nb of this.adj.get(cur)!) {
        const tentative = g.get(cur)! + this.pos(cur).distanceTo(this.pos(nb));
        if (tentative < (g.get(nb) ?? Infinity)) {
          came.set(nb, cur);
          g.set(nb, tentative);
          f.set(nb, tentative + this.pos(nb).distanceTo(goal));
          open.add(nb);
        }
      }
    }
    return null;
  }
}
