import { describe, expect, it } from 'vitest';
import { LAYOUT } from '../src/config/layout';
import { ROSTER, TRADERS } from '../src/config/roster';
import { NavGraph } from '../src/core/NavGraph';
import { SpotRegistry } from '../src/core/Spots';

const nav = new NavGraph(LAYOUT.nodes, LAYOUT.edges);
const spots = new SpotRegistry(LAYOUT.spots);

describe('office layout', () => {
  it('connects every nav node to the corridor', () => {
    for (const id of nav.nodes.keys()) expect(nav.path('C_2', id), id).not.toBeNull();
  });

  it('attaches every spot to an existing node', () => {
    for (const s of LAYOUT.spots) expect(nav.nodes.has(s.node), `${s.id} -> ${s.node}`).toBe(true);
  });

  it('gives every character a unique, existing home', () => {
    const homes = ROSTER.map((d) => d.home);
    expect(new Set(homes).size).toBe(homes.length);
    for (const h of homes) expect(spots.has(h), h).toBe(true);
  });

  it('has an instruction spot beside every trader desk', () => {
    for (const t of TRADERS) expect(spots.has(`${t.home}-instruct`)).toBe(true);
  });

  it('has room for the showcase scenes', () => {
    expect(spots.freeWithTag('meeting-chair').length).toBeGreaterThanOrEqual(8);
    expect(spots.has('meeting-head') && spots.has('yama-report') && spots.has('tf-brief')).toBe(true);
    for (const tag of ['billiard', 'pingpong', 'ps']) expect(spots.freeWithTag(tag)).toHaveLength(2);
    expect(spots.freeGroup('pantry-table', 3)).not.toBeNull();
    expect(spots.freeGroup('lounge-table', 3)).not.toBeNull();
  });

  it('routes Odin from his desk up the stairs to Yama', () => {
    const route = nav.path(spots.get('odin-seat').node, spots.get('yama-report').node)!;
    expect(route).toContain('ST_t');
    expect(nav.pos(route[route.length - 1]).y).toBeCloseTo(4.2);
  });
});

describe('spot reservations', () => {
  it('allows a single owner per spot', () => {
    const reg = new SpotRegistry(LAYOUT.spots);
    expect(reg.reserve('ps-1', 'atlas')).toBe(true);
    expect(reg.reserve('ps-1', 'sage')).toBe(false);
    reg.release('ps-1', 'sage');
    expect(reg.ownerOf('ps-1')).toBe('atlas');
    reg.release('ps-1', 'atlas');
    expect(reg.isFree('ps-1')).toBe(true);
  });
});
