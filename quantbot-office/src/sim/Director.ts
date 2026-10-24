import type { Agent } from '../agents/Agent';
import { deskLine, type Vars } from '../config/dialogue';
import { chance, rand, randInt, shuffle } from '../core/random';
import {
  floorBriefing, freeGame, gameBreak, meeting, odinReport, pantryChat, standingDiscussion, traderChat,
  tradingInstruction, vars, type Sim,
} from './scenarios';

export type ScenarioKind = 'meeting' | 'instruction' | 'briefing' | 'standing' | 'pantry' | 'game' | 'report';

export const SCENARIO_LABELS: Record<ScenarioKind, string> = {
  meeting: 'Meeting',
  instruction: 'Instruksi Trading',
  briefing: 'Briefing Floor',
  standing: 'Diskusi Berdiri',
  pantry: 'Pantry',
  game: 'Game Break',
  report: 'Report ke Yama',
};

const COOLDOWN: Record<ScenarioKind, number> = {
  meeting: 200, instruction: 8, briefing: 120, standing: 15, pantry: 45, game: 60, report: 0,
};

/** Scenes that may run several times at once (each claims its own spots). */
const PARALLEL = new Set<ScenarioKind>(['instruction', 'standing', 'game']);

/** Background scenes that run at most this many at once (desk chats and the report are extra). */
const MAX_CONCURRENT = 3;

/**
 * Decides what happens in the office: hourly reports, meetings, trading
 * instructions, discussions, coffee and game breaks, and desk idling.
 */
export class Director {
  autoplay = true;
  private readonly active = new Map<ScenarioKind, number>();
  private readonly readyAt: Partial<Record<ScenarioKind, number>> = { meeting: 25, game: 40 };
  private nextDecision = 2;
  private nextTraderChat = 10;
  private reportPending = false;

  constructor(private readonly sim: Sim) {}

  get pendingReport(): boolean {
    return this.reportPending;
  }

  onHour(hour: number): void {
    this.sim.log(`Jam ${String(hour).padStart(2, '0')}:00 — waktunya Odin report ke Yama`);
    this.reportPending = true;
  }

  update(): void {
    const { time, odin } = this.sim;
    if (this.reportPending && !odin.busy && !this.active.has('report')) {
      this.reportPending = false;
      this.start('report', [odin], () => odinReport(this.sim));
    }
    for (const a of this.sim.agents) this.idle(a);
    if (!this.autoplay) return;
    if (time.now >= this.nextDecision) {
      this.nextDecision = time.now + rand(4, 9);
      this.decide();
    }
    if (time.now >= this.nextTraderChat) {
      this.nextTraderChat = time.now + rand(12, 25);
      this.startTraderChat();
    }
  }

  /** Manual trigger (HUD buttons / bridge). Returns a message for the user. */
  trigger(kind: ScenarioKind, overrides: Partial<Vars> & { lead?: string } = {}): string {
    if (kind === 'report') {
      if (this.active.has('report')) return 'Odin sedang report ke Yama.';
      this.reportPending = true;
      return this.sim.odin.busy ? 'Odin akan naik setelah tugasnya selesai.' : 'Odin naik ke lantai 2.';
    }
    const ok = this.tryStart(kind, true, overrides);
    return ok ? `${SCENARIO_LABELS[kind]} dimulai.` : `${SCENARIO_LABELS[kind]} belum bisa dimulai (lead/ruangan sedang dipakai).`;
  }

  private freeLeads(manual: boolean): Agent[] {
    const now = this.sim.time.now;
    return shuffle(this.sim.leads.filter((a) => !a.busy && a.atHome && (manual || now >= a.restUntil)));
  }

  private freeTraders(): Agent[] {
    return shuffle(this.sim.traders.filter((t) => !t.busy && t.atHome));
  }

  private decide(): void {
    const background = [...this.active.keys()].filter((k) => k !== 'report').length;
    if (background >= MAX_CONCURRENT) return;
    const leads = this.freeLeads(false).length;
    const quiet = this.sim.fund.quiet;
    const weights: [ScenarioKind, number][] = [
      ['meeting', leads >= 4 ? 1.2 : 0],
      ['instruction', leads >= 1 ? 3 : 0],
      ['briefing', leads >= 1 ? 0.5 : 0],
      ['standing', leads >= 2 ? 2 : 0],
      ['pantry', leads >= 2 ? 1.4 : 0],
      ['game', leads >= 2 ? (quiet ? 2.4 : 0.8) : 0],
    ];
    const pool = weights.filter(([k, w]) => w > 0 && this.canStart(k, false));
    const total = pool.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [kind, w] of pool) {
      r -= w;
      if (r <= 0) { this.tryStart(kind, false); return; }
    }
  }

  private canStart(kind: ScenarioKind, manual: boolean): boolean {
    if (!PARALLEL.has(kind) && this.active.has(kind)) return false;
    if (!manual && this.sim.time.now < (this.readyAt[kind] ?? 0)) return false;
    if (kind === 'meeting' && (this.sim.odin.busy || this.reportPending)) return false;
    return true;
  }

  private tryStart(kind: ScenarioKind, manual: boolean, overrides: Partial<Vars> & { lead?: string } = {}): boolean {
    if (!this.canStart(kind, manual)) return false;
    const sim = this.sim;
    const leads = this.freeLeads(manual);
    switch (kind) {
      case 'meeting': {
        if (leads.length < (manual ? 2 : 4)) return false;
        const n = Math.min(leads.length, manual ? 8 : randInt(4, 8));
        const chosen = leads.slice(0, n);
        return this.start(kind, [sim.odin, ...chosen], () => meeting(sim, chosen));
      }
      case 'instruction': {
        const requested = overrides.lead ? leads.find((l) => l.id === overrides.lead) : undefined;
        const lead = requested ?? leads[0];
        const traders = this.freeTraders().slice(0, chance(0.35) ? 2 : 1);
        if (!lead || !traders.length) return false;
        return this.start(kind, [lead, ...traders], () => tradingInstruction(sim, lead, traders, overrides));
      }
      case 'briefing': {
        const speaker = !sim.odin.busy && !this.reportPending && chance(0.4) ? sim.odin : leads[0];
        const responders = this.freeTraders().slice(0, randInt(3, 5));
        if (!speaker || responders.length < 2 || !sim.spots.isFree('tf-brief')) return false;
        return this.start(kind, [speaker, ...responders], () => floorBriefing(sim, speaker, responders));
      }
      case 'standing': {
        const n = leads.length >= 3 && chance(0.35) ? 3 : 2;
        if (leads.length < n) return false;
        const parts = leads.slice(0, n);
        return this.start(kind, parts, () => standingDiscussion(sim, parts));
      }
      case 'pantry': {
        const n = leads.length >= 3 && chance(0.4) ? 3 : 2;
        if (leads.length < n || !sim.spots.freeGroup('pantry-table', n)) return false;
        const parts = leads.slice(0, n);
        return this.start(kind, parts, () => pantryChat(sim, parts));
      }
      case 'game': {
        const game = freeGame(sim);
        if (!game || leads.length < 2) return false;
        const parts = leads.slice(0, 2);
        return this.start(kind, parts, () => gameBreak(sim, parts, game));
      }
      case 'report':
        return false;
    }
  }

  private start(kind: ScenarioKind, agents: Agent[], run: () => Promise<void>): boolean {
    const sim = this.sim;
    agents.forEach((a) => { a.busy = true; });
    this.active.set(kind, (this.active.get(kind) ?? 0) + 1);
    run()
      .catch((err) => {
        console.error(`[Director] ${kind} failed`, err);
        // Recover: put everyone involved back at their desks.
        for (const a of agents) {
          a.talking = false;
          a.lookTarget = null;
          a.place(a.def.home);
          a.activity = 'type';
          a.busy = false;
          a.status = 'Di meja';
        }
      })
      .finally(() => {
        const n = (this.active.get(kind) ?? 1) - 1;
        if (n > 0) this.active.set(kind, n); else this.active.delete(kind);
        this.readyAt[kind] = sim.time.now + COOLDOWN[kind];
        // Scenarios free agents as they get home; make sure nobody stays locked.
        for (const a of agents) if (a.busy && a.atHome) a.busy = false;
      });
    return true;
  }

  private startTraderChat(): void {
    const free = this.freeTraders();
    for (const a of free) {
      const idx = Number(a.def.home.split('-')[1]);
      const neighbour = free.find((b) => b !== a && Number(b.def.home.split('-')[1]) === idx + 1 && idx % 4 !== 3);
      if (neighbour) {
        a.busy = neighbour.busy = true;
        traderChat(this.sim, a, neighbour).catch((e) => console.error(e)).finally(() => { a.busy = neighbour.busy = false; });
        return;
      }
    }
  }

  /** Desk life for agents nobody is directing: type, think, sip, mutter. */
  private idle(a: Agent): void {
    const { time } = this.sim;
    if (a.busy || a.walking || time.now < a.nextIdle) return;
    a.nextIdle = time.now + rand(6, 16);
    if (!a.atHome) {
      a.busy = true;
      a.goHome().catch(() => a.place(a.def.home)).finally(() => { a.busy = false; });
      return;
    }
    const r = Math.random();
    a.activity = r < 0.65 ? 'type' : r < 0.85 ? 'think' : 'none';
    const talkChance = a.def.role === 'trader' ? 0.06 : 0.12;
    if (chance(talkChance)) void a.say(deskLine(a.def, vars(this.sim)));
  }

  /** Every character and what it is doing (for the bridge). */
  snapshot(): { id: string; name: string; status: string; floor: number }[] {
    return this.sim.agents.map((a) => ({ id: a.id, name: a.def.name, status: a.status, floor: a.floor }));
  }
}
