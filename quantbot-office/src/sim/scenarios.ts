/**
 * Scripted office scenes. Each scenario receives agents the Director has
 * already marked busy, walks them through the scene and sends them back
 * to their desks (freeing each one as soon as it is home).
 */
import type { Activity } from '../agents/Avatar';
import type { Agent } from '../agents/Agent';
import {
  BRIEF_RESPONSES, briefingClose, briefingOpen, gameBanter, gameEnd, gameStart, instructionScript, makeVars,
  meetingScript, pantryScript, reportScript, standingScript, traderChatScript, type Game, type Line, type Vars,
} from '../config/dialogue';
import type { OfficeClock } from '../core/OfficeClock';
import { pick, rand, shuffle } from '../core/random';
import type { SimTime } from '../core/SimTime';
import type { SpotRegistry } from '../core/Spots';
import type { FundState } from './FundState';

export interface Sim {
  time: SimTime;
  spots: SpotRegistry;
  fund: FundState;
  clock: OfficeClock;
  agents: Agent[];
  leads: Agent[];
  traders: Agent[];
  odin: Agent;
  yama: Agent;
  log: (msg: string) => void;
}

export const vars = (sim: Sim, overrides: Partial<Vars> = {}) => makeVars(sim.fund, sim.clock.time, overrides);

/** Play a script; listeners look at the speaker. */
export async function converse(sim: Sim, parts: Agent[], lines: Line[]): Promise<void> {
  let prev: Agent | null = null;
  for (const [idx, text] of lines) {
    const speaker = parts[idx];
    for (const a of parts) if (a !== speaker) a.lookTarget = speaker;
    speaker.lookTarget = prev && prev !== speaker ? prev : parts.find((a) => a !== speaker) ?? null;
    await speaker.say(text);
    prev = speaker;
    await sim.time.wait(rand(0.25, 0.7));
  }
  for (const a of parts) a.lookTarget = null;
}

export function free(a: Agent, restSeconds: [number, number] = [15, 35], now = 0): void {
  a.busy = false;
  a.status = 'Di meja';
  a.restUntil = now + rand(...restSeconds);
}

export async function returnHome(sim: Sim, agents: Agent[]): Promise<void> {
  await Promise.all(agents.map(async (a) => {
    a.status = 'Kembali ke meja';
    await a.goHome();
    free(a, [15, 35], sim.time.now);
  }));
}

const status = (agents: Agent[], s: string) => agents.forEach((a) => { a.status = s; });

// ── Meeting room ──────────────────────────────────────────────────
export async function meeting(sim: Sim, leads: Agent[]): Promise<void> {
  const { odin, spots } = sim;
  const chairs = shuffle(spots.freeWithTag('meeting-chair')).slice(0, leads.length);
  const parts = [odin, ...leads.slice(0, chairs.length)];
  status(parts, 'Meeting di Meeting Room');
  sim.log(`Meeting: Odin + ${parts.slice(1).map((a) => a.def.name).join(', ')}`);
  await Promise.all([odin.goTo('meeting-head'), ...parts.slice(1).map((a, i) => a.goTo(chairs[i].id))]);
  await sim.time.wait(0.8);
  await converse(sim, parts, meetingScript(parts.map((a) => a.def), vars(sim)));
  await returnHome(sim, parts);
}

// ── Lead walks to the trading floor and instructs executors ───────
export async function tradingInstruction(sim: Sim, lead: Agent, traders: Agent[], overrides: Partial<Vars> = {}): Promise<void> {
  sim.log(`${lead.def.name} memberi instruksi ke ${traders.map((t) => t.def.name).join(', ')}`);
  for (const t of traders) {
    lead.status = `Instruksi ke ${t.def.name}`;
    t.status = `Menerima instruksi ${lead.def.name}`;
    await lead.goTo(`${t.def.home}-instruct`);
    t.activity = 'none';
    await t.turnToward(lead);
    await converse(sim, [lead, t], instructionScript([lead.def, t.def], vars(sim, overrides)));
    await t.turnTo(sim.spots.get(t.def.home).facing);
    t.activity = 'type';
    free(t, [5, 10], sim.time.now);
  }
  await returnHome(sim, [lead]);
}

// ── Briefing the whole trading floor ──────────────────────────────
export async function floorBriefing(sim: Sim, speaker: Agent, responders: Agent[]): Promise<void> {
  speaker.status = 'Briefing trading floor';
  sim.log(`${speaker.def.name} briefing seluruh desk trader`);
  await speaker.goTo('tf-brief');
  status(responders, 'Mendengar briefing');
  responders.forEach((t) => { t.activity = 'none'; t.lookTarget = speaker; });
  await speaker.say(briefingOpen(vars(sim)));
  await Promise.all(responders.map(async (t, i) => {
    await sim.time.wait(0.2 + i * 0.45);
    await t.say(pick(BRIEF_RESPONSES));
  }));
  await speaker.say(briefingClose());
  responders.forEach((t) => { t.lookTarget = null; t.activity = 'type'; free(t, [5, 10], sim.time.now); });
  await returnHome(sim, [speaker]);
}

// ── Standing discussion between leads of different departments ────
export async function standingDiscussion(sim: Sim, parts: Agent[]): Promise<void> {
  const { spots } = sim;
  // Variant: visit a colleague's desk (host stays seated).
  if (parts.length === 2 && Math.random() < 0.3) {
    const [visitor, host] = parts;
    status(parts, `Diskusi di meja ${host.def.name}`);
    sim.log(`${visitor.def.name} mampir ke meja ${host.def.name}`);
    await visitor.goTo(`${host.def.home}-visit`);
    host.activity = 'none';
    await host.turnToward(visitor);
    await converse(sim, parts, standingScript(parts.map((a) => a.def), vars(sim)));
    await host.turnTo(spots.get(host.def.home).facing);
    host.activity = 'type';
    free(host, [10, 20], sim.time.now);
    await returnHome(sim, [visitor]);
    return;
  }
  const tag = pick(parts.length > 2 ? ['lounge-table', 'whiteboard'] : ['lounge-table', 'whiteboard', 'corridor', 'corridor']);
  const where = spots.freeGroup(tag, parts.length) ?? spots.freeGroup('lounge-table', parts.length);
  if (!where) { await returnHome(sim, parts); return; }
  const place = tag === 'corridor' ? 'koridor' : tag === 'whiteboard' ? 'whiteboard lounge' : 'lounge';
  status(parts, `Diskusi berdiri di ${place}`);
  sim.log(`Diskusi berdiri (${place}): ${parts.map((a) => a.def.name).join(' · ')}`);
  await Promise.all(parts.map((a, i) => a.goTo(where[i].id)));
  await converse(sim, parts, standingScript(parts.map((a) => a.def), vars(sim)));
  await returnHome(sim, parts);
}

// ── Pantry: grab coffee, chat about work ──────────────────────────
export async function pantryChat(sim: Sim, parts: Agent[]): Promise<void> {
  const { spots } = sim;
  status(parts, 'Ngopi di pantry');
  sim.log(`Pantry: ${parts.map((a) => a.def.name).join(', ')}`);
  const counters = spots.freeWithTag('pantry-counter');
  await Promise.all(parts.map(async (a, i) => {
    const c = counters[i % Math.max(1, counters.length)];
    if (c && spots.isFree(c.id)) {
      await a.goTo(c.id);
      await sim.time.wait(rand(2, 3.5));
    }
    a.activity = 'drink';
  }));
  const table = spots.freeGroup('pantry-table', parts.length);
  if (table) await Promise.all(parts.map((a, i) => a.goTo(table[i].id, 'drink')));
  await converse(sim, parts, pantryScript(parts.map((a) => a.def), vars(sim)));
  await returnHome(sim, parts);
}

// ── Game room break ───────────────────────────────────────────────
const GAME_ACTIVITY: Record<Game, Activity> = { billiard: 'billiard', pingpong: 'pingpong', ps: 'gamepad' };
const GAME_NAME: Record<Game, string> = { billiard: 'biliar', pingpong: 'ping-pong', ps: 'PlayStation' };

export function freeGame(sim: Sim): Game | null {
  const games = shuffle(['billiard', 'pingpong', 'ps'] as Game[]);
  return games.find((g) => sim.spots.freeWithTag(g).length >= 2) ?? null;
}

export async function gameBreak(sim: Sim, parts: Agent[], game: Game): Promise<void> {
  const spots = sim.spots.freeWithTag(game).slice(0, 2);
  status(parts, `Main ${GAME_NAME[game]} di game room`);
  sim.log(`Game room: ${parts.map((a) => a.def.name).join(' vs ')} main ${GAME_NAME[game]}`);
  await Promise.all(parts.map((a, i) => a.goTo(spots[i].id)));
  parts.forEach((a, i) => { a.lookTarget = parts[1 - i]; });
  await parts[0].say(gameStart());
  const end = sim.time.now + rand(40, 80);
  let turn = 0;
  while (sim.time.now < end) {
    const active = parts[turn % 2];
    parts.forEach((a) => { a.activity = game === 'billiard' ? (a === active ? 'billiard' : 'none') : GAME_ACTIVITY[game]; });
    await sim.time.wait(rand(5, 9));
    if (Math.random() < 0.7) await active.say(gameBanter(game, parts[(turn + 1) % 2].def));
    turn++;
  }
  parts.forEach((a) => { a.activity = 'none'; });
  await parts[1].say(gameEnd());
  parts.forEach((a) => { a.lookTarget = null; });
  await returnHome(sim, parts);
}

// ── Odin → Yama hourly report (upper floor) ───────────────────────
export async function odinReport(sim: Sim): Promise<void> {
  const { odin, yama } = sim;
  odin.status = 'Naik ke lantai 2 — report ke Yama';
  sim.log('Odin naik ke lantai 2 untuk report ke Yama');
  await odin.goTo('yama-report');
  yama.busy = true;
  yama.status = 'Menerima report Odin';
  odin.status = 'Report ke Yama';
  yama.activity = 'none';
  await converse(sim, [odin, yama], reportScript(vars(sim)));
  yama.activity = 'type';
  free(yama, [20, 40], sim.time.now);
  await returnHome(sim, [odin]);
}

// ── Neighbouring traders chatting from their seats ────────────────
export async function traderChat(sim: Sim, a: Agent, b: Agent): Promise<void> {
  status([a, b], 'Ngobrol dengan rekan desk');
  a.activity = b.activity = 'none';
  await converse(sim, [a, b], traderChatScript([a.def, b.def], vars(sim)));
  for (const t of [a, b]) { t.activity = 'type'; free(t, [10, 25], sim.time.now); }
}
