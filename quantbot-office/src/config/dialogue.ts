/**
 * Conversation content (Bahasa Indonesia). Lines are templates: `{key}` is
 * replaced by values from `makeVars()` plus per-script names.
 *
 * Every script builder returns `[speakerIndex, text][]`, where the index
 * refers to the participant list passed in. Scenarios map it to characters.
 */
import { chance, pick, randInt, rand, shuffle } from '../core/random';
import { fmtMoney, fmtSigned, SYMBOLS, type FundSnapshot, type FundState } from '../sim/FundState';
import type { CharacterDef } from './roster';

export type Line = [number, string];
export type Vars = Record<string, string>;

export function fill(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function daypart(hour: number): string {
  if (hour < 11) return 'pagi';
  if (hour < 15) return 'siang';
  if (hour < 18) return 'sore';
  return 'malam';
}

/** Market/fund variables available to every template. */
export function makeVars(fund: FundState, officeTime: number, overrides: Partial<Vars> = {}): Vars {
  const snap: FundSnapshot = fund.snapshot();
  const held = snap.positions.map((p) => p.symbol);
  const sym = overrides.sym ?? (held.length && chance(0.6) ? pick(held) : pick(SYMBOLS));
  const sym2 = pick(SYMBOLS.filter((s) => s !== sym));
  const side = overrides.side ?? (chance(0.6) ? 'LONG' : 'SHORT');
  const px = fund.prices[sym] ?? 100;
  const dec = fund.priceDecimals(sym);
  const dir = side === 'LONG' ? 1 : -1;
  const hour = new Date(officeTime).getHours();
  const top = [...snap.positions].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))[0];
  return {
    sym,
    sym2,
    side,
    sideWord: side === 'LONG' ? 'buka long' : 'buka short',
    size: overrides.size ?? rand(0.5, 5).toFixed(1),
    price: px.toFixed(dec),
    sl: (px * (1 - dir * rand(0.004, 0.012))).toFixed(dec),
    tp: (px * (1 + dir * rand(0.01, 0.03))).toFixed(dec),
    conf: String(snap.confidence),
    bps: snap.slippageBps.toFixed(1),
    dd: snap.drawdownPct.toFixed(2),
    ddLimit: '2.0',
    pnl: fmtSigned(snap.pnlToday),
    pnlPct: `${snap.pnlPct >= 0 ? '+' : ''}${snap.pnlPct.toFixed(2)}`,
    equity: fmtMoney(snap.equity),
    winrate: String(Math.round(snap.winRate)),
    open: String(snap.positions.length),
    topPos: top ? `${top.side} ${top.symbol} (${fmtSigned(top.pnl)})` : 'belum ada',
    hour: pad(hour),
    next: pad((hour + 1) % 24),
    daypart: daypart(hour),
    alloc: String(randInt(8, 25)),
    pct: String(randInt(6, 38)),
    latency: String(randInt(3, 14)),
    sharpe: rand(1.3, 2.7).toFixed(2),
    ver: `${randInt(3, 5)}.${randInt(0, 9)}`,
    ...overrides,
  };
}

const with_ = (v: Vars, extra: Vars): Vars => ({ ...v, ...extra });

// ── Department voice ───────────────────────────────────────────────
export const DEPT_UPDATE: Record<string, string[]> = {
  atlas: [
    'Dari sisi makro, DXY melemah dan yield turun. Bias {side} di {sym} masih valid.',
    'Data inflasi rilis jam {next}:30. Saya sarankan kurangi leverage sebelum rilis.',
    'Korelasi {sym} dengan NAS100 naik ke 0.{conf}. Hati-hati double exposure.',
  ],
  sage: [
    'Sentimen sosial untuk {sym} naik {pct}% dalam 4 jam terakhir.',
    'Ada inflow besar ke exchange. Potensi tekanan jual di {sym}.',
    'Funding rate {sym} mulai panas, crowd terlalu {side}.',
  ],
  cipher: [
    'Model v{ver} kasih confidence {conf}% untuk {side} {sym}.',
    'Feature importance bergeser ke orderflow. Saya retrain malam ini.',
    'Sharpe out-of-sample minggu ini {sharpe}. Masih di atas target.',
  ],
  vortex: [
    'Slippage rata-rata {bps} bps hari ini, fill rate 98%.',
    'Likuiditas {sym} tipis di sesi Asia. Order saya pecah jadi TWAP 12 slice.',
    'Latency ke exchange stabil di {latency} ms.',
  ],
  chronos: [
    'Backtest 3 tahun untuk setup ini: win rate {winrate}%.',
    'Window entry terbaik di open sesi London, sekitar 40 menit lagi.',
    'Volatilitas {sym} biasanya memuncak jam {next}:00.',
  ],
  alpha: [
    'Saya usulkan alokasi {sym} naik ke {alloc}% dari portfolio.',
    'Rotasi dari {sym2} ke {sym} kasih expected alpha tambahan {pct} bps.',
    'Beta portfolio sekarang 0.{conf}. Masih ada ruang tambah posisi.',
  ],
  sentinel: [
    'Drawdown harian {dd}%, masih di bawah limit {ddLimit}%.',
    'VaR 95% naik ke {pct} bps. Saya pantau terus.',
    'Exposure terbesar ada di {sym}. Hard stop saya pasang di {sl}.',
  ],
  killjoy: [
    'Kalau DD tembus {ddLimit}%, saya matikan semua bot. Tanpa diskusi.',
    'Ada 2 order melewati limit size. Saya blok dulu sampai ada approval.',
    'Audit log hari ini bersih. Tapi jangan senang dulu.',
  ],
};

const GENERIC_UPDATE = ['Semua on track dari tim saya.', 'Tidak ada anomali sejauh ini.'];

const deptLine = (who: CharacterDef, v: Vars) => fill(pick(DEPT_UPDATE[who.id] ?? GENERIC_UPDATE), v);

const REACTIONS = [
  'Setuju dengan {name}, data saya juga menunjukkan hal yang sama.',
  'Hmm, {name}, saya kurang yakin. Volume-nya belum konfirmasi.',
  'Kalau begitu saya sesuaikan parameter saya.',
  'Catatan bagus. Saya cross-check dengan tim saya.',
  'Risiko slippage-nya gimana, {name}?',
  'Oke {name}, itu masuk akal.',
];

// ── Meeting ────────────────────────────────────────────────────────
const MEETING_OPEN = [
  'Oke tim, kita mulai daily sync. Fokus hari ini: {sym} dan {sym2}.',
  'Selamat {daypart} semua. PnL hari ini {pnl}. Mari kita review.',
  'Saya mau update cepat dari tiap departemen. Singkat saja.',
];
const MEETING_ACK = ['Noted.', 'Bagus, lanjut.', 'Oke, masuk akal.', 'Saya catat itu.'];
const MEETING_DECISION = [
  'Keputusan: kita {sideWord} {sym} size {size} lot. Vortex, eksekusi bertahap.',
  'Kita tahan posisi baru sampai rilis data. Sentinel, ketatkan stop.',
  'Alokasi {sym} naik ke {alloc}%. Killjoy, pastikan tetap dalam limit.',
];
const MEETING_CLOSE = [
  'Meeting selesai. Kembali ke posisi masing-masing.',
  'Oke, terima kasih semua. Eksekusi yang rapi.',
  'Itu saja. Saya report ke Pak Yama jam {next}:00.',
];

/** participants: [odin, ...leads] */
export function meetingScript(parts: CharacterDef[], v: Vars): Line[] {
  const lines: Line[] = [[0, fill(pick(MEETING_OPEN), v)]];
  const speakers = shuffle(parts.slice(1).map((_, i) => i + 1)).slice(0, Math.min(parts.length - 1, randInt(3, 5)));
  for (const idx of speakers) {
    lines.push([idx, deptLine(parts[idx], v)]);
    if (chance(0.4) && parts.length > 2) {
      const others = parts.map((_, i) => i).filter((i) => i !== 0 && i !== idx);
      const r = pick(others);
      lines.push([r, fill(pick(REACTIONS), with_(v, { name: parts[idx].name }))]);
    } else if (chance(0.5)) {
      lines.push([0, pick(MEETING_ACK)]);
    }
  }
  lines.push([0, fill(pick(MEETING_DECISION), v)]);
  lines.push([0, fill(pick(MEETING_CLOSE), v)]);
  return lines;
}

// ── Trading floor instruction ──────────────────────────────────────
const INSTRUCT = [
  '{trader}, buka {side} {sym} {size} lot. SL {sl}, TP {tp}.',
  '{trader}, scale-in {sym} 3 tahap, total {size} lot.',
  '{trader}, tutup setengah posisi {sym}, kunci profit.',
  '{trader}, pasang limit order {sym} di {price}.',
];
const INSTRUCT_ACK = ['Siap, {lead}! Order masuk.', 'Oke, eksekusi sekarang.', 'Copy that. Sedang diproses.', 'Siap. Spread lagi normal.'];
const INSTRUCT_FOLLOW = ['Laporkan kalau slippage di atas 3 bps.', 'Monitor ketat, jangan sampai kena stop hunt.', 'Bagus. Kabari saya kalau terisi.'];
const INSTRUCT_FILLED = ['Terisi di {price}. Slippage {bps} bps.', 'Done, {lead}. Posisi sudah aktif.', 'Order terisi penuh.'];

/** participants: [lead, trader] */
export function instructionScript(parts: CharacterDef[], v: Vars): Line[] {
  const vv = with_(v, { lead: parts[0].name, trader: parts[1].name });
  const lines: Line[] = [[0, fill(pick(INSTRUCT), vv)], [1, fill(pick(INSTRUCT_ACK), vv)]];
  if (chance(0.7)) lines.push([0, fill(pick(INSTRUCT_FOLLOW), vv)]);
  if (chance(0.6)) lines.push([1, fill(pick(INSTRUCT_FILLED), vv)]);
  return lines;
}

// ── Floor briefing (speaker in front of all desks) ────────────────
const BRIEF = [
  'Perhatian semua desk! Rilis data jam {next}:30, kurangi exposure 30% sebelumnya.',
  'Semua desk: fokus {sym} hari ini, bias {side}. Ikuti sinyal dari Cipher.',
  'Tim eksekusi, volatilitas naik. Lebarkan stop dan kecilkan size.',
];
export const BRIEF_RESPONSES = ['Siap!', 'Copy!', 'Oke, dimengerti.', 'Siap laksanakan!', 'Noted!'];
const BRIEF_CLOSE = ['Terima kasih. Lanjutkan.', 'Bagus. Tetap disiplin.'];

export function briefingOpen(v: Vars): string { return fill(pick(BRIEF), v); }
export function briefingClose(): string { return pick(BRIEF_CLOSE); }

// ── Standing discussion between leads of different departments ────
const ASK = [
  '{name}, menurutmu {sym} masih layak di-hold?',
  'Eh {name}, kamu lihat lonjakan volume {sym} tadi?',
  '{name}, model kamu konsisten dengan data saya nggak?',
  '{name}, ada waktu sebentar? Soal {sym}.',
];
const CLOSERS = ['Oke, nanti saya kirim datanya.', 'Kita bahas lagi di meeting berikutnya.', 'Sip, saya lanjut kerja.', 'Deal. Saya update ke Odin.'];

export function standingScript(parts: CharacterDef[], v: Vars): Line[] {
  const lines: Line[] = [
    [0, fill(pick(ASK), with_(v, { name: parts[1].name }))],
    [1, deptLine(parts[1], v)],
    [0, fill(pick(REACTIONS), with_(v, { name: parts[1].name }))],
  ];
  if (parts.length > 2) {
    lines.push([2, deptLine(parts[2], v)]);
    lines.push([1, fill(pick(REACTIONS), with_(v, { name: parts[2].name }))]);
  }
  lines.push([0, deptLine(parts[0], v)]);
  lines.push([1, pick(CLOSERS)]);
  return lines;
}

// ── Pantry: coffee + work issues ───────────────────────────────────
const PANTRY_OPEN = ['Kopinya enak hari ini.', 'Butuh kafein, semalam backtest sampai jam 3.', 'Akhirnya bisa napas sebentar.'];
const PANTRY_ISSUES = [
  'Latency server Singapore naik lagi semalam.',
  'Backtest {name} kemarin agak overfit nggak sih?',
  'Funding rate {sym} gila-gilaan minggu ini.',
  'Bot grid di {sym2} perlu di-tune ulang.',
  'Saya curiga ada spoofing di orderbook {sym}.',
  'Model sentimen kita kebanjiran berita palsu.',
];
const PANTRY_REPLY = ['Haha, iya. Nanti kita fix bareng.', 'Itu yang saya khawatirkan juga.', 'Coba bawa ke meeting berikutnya.', ...REACTIONS];

export function pantryScript(parts: CharacterDef[], v: Vars): Line[] {
  const n = parts.length;
  const lines: Line[] = [[0, pick(PANTRY_OPEN)]];
  const turns = randInt(3, 5);
  for (let i = 0; i < turns; i++) {
    const s = (i + 1) % n;
    const other = parts[(s + 1) % n].name;
    const pool = i % 2 === 0 ? PANTRY_ISSUES : PANTRY_REPLY;
    lines.push([s, fill(pick(pool), with_(v, { name: other }))]);
  }
  lines.push([0, pick(CLOSERS)]);
  return lines;
}

// ── Game room ──────────────────────────────────────────────────────
export type Game = 'billiard' | 'pingpong' | 'ps';
const GAME_START = ['Pasar lagi sepi, satu game dulu.', 'Ayo, 10 menit saja.', 'Yang kalah traktir kopi.'];
const GAME_BANTER: Record<Game, string[]> = {
  billiard: ['Giliran kamu, {name}.', 'Masuk! Bola 8 di pojok kanan.', 'Aduh, scratch.', 'Ini lebih susah dari trading.'],
  pingpong: ['Smash!', 'Out! Poin saya.', '7-5, jangan nyerah.', 'Servis kamu, {name}.'],
  ps: ['Gol! Lihat itu!', 'Pause, pause... oke lanjut.', 'Main FIFA lebih stres daripada FOMC.', 'Rematch habis ini, {name}.'],
};
const GAME_END = ['Oke, balik kerja.', 'GG. Lanjut nanti.', 'Sinyal masuk, saya harus balik.'];

export const gameStart = () => pick(GAME_START);
export const gameBanter = (game: Game, other: CharacterDef) => fill(pick(GAME_BANTER[game]), { name: other.name });
export const gameEnd = () => pick(GAME_END);

// ── Odin → Yama hourly report ──────────────────────────────────────
const REPORT_OPEN = ['Pak Yama, laporan jam {hour}:00.', 'Selamat {daypart}, Pak Yama. Update rutin jam {hour}:00.'];
const YAMA_GREET = ['Silakan, Odin. Gimana kondisinya?', 'Oke, langsung saja.', 'Masuk, Odin. Ada kabar apa?'];
const REPORT_KPI = ['Equity {equity}, PnL hari ini {pnl} ({pnlPct}%). Win rate {winrate}%.'];
const REPORT_POS = ['Posisi terbuka {open}. Terbesar: {topPos}.', 'Ada {open} posisi aktif, exposure terbesar di {sym}.'];
const REPORT_RISK = ['Drawdown {dd}%. Sentinel konfirmasi masih aman.', 'Risk terkendali, drawdown {dd}% dari limit {ddLimit}%.'];
const YAMA_QA: [string, string][] = [
  ['Sinyal Cipher masih akurat?', 'Confidence model rata-rata {conf}%, Pak. Masih di atas threshold.'],
  ['Eksekusi Vortex lancar?', 'Lancar, slippage {bps} bps. Fill rate di atas 98%.'],
  ['Ada risiko yang perlu saya tahu?', 'Ada rilis data jam {next}:30. Exposure sudah kita kurangi.'],
  ['Tim gimana? Ada yang kebanyakan di game room?', 'Haha, aman Pak. Mereka main kalau pasar sepi saja.'],
  ['Strategi {sym} kita lanjut?', 'Lanjut, Pak. Alpha usulkan alokasi naik ke {alloc}%.'],
];
const YAMA_CLOSE = ['Oke, lanjutkan. Jangan over-leverage.', 'Bagus. Report lagi jam {next}:00.', 'Mantap. Sampaikan ke tim, kerja bagus.'];
const ODIN_END = ['Siap, Pak.', 'Siap, saya sampaikan ke tim.'];

/** participants: [odin, yama] */
export function reportScript(v: Vars): Line[] {
  const lines: Line[] = [
    [0, fill(pick(REPORT_OPEN), v)],
    [1, pick(YAMA_GREET)],
    [0, fill(pick(REPORT_KPI), v)],
    [0, fill(pick(REPORT_POS), v)],
    [0, fill(pick(REPORT_RISK), v)],
  ];
  for (const [q, a] of shuffle(YAMA_QA).slice(0, randInt(1, 2))) {
    lines.push([1, fill(q, v)], [0, fill(a, v)]);
  }
  lines.push([1, fill(pick(YAMA_CLOSE), v)], [0, pick(ODIN_END)]);
  return lines;
}

// ── Solo desk mutters & trader small talk ─────────────────────────
const DESK_LINES: Record<string, string[]> = {
  lead: ['Backtest selesai, hasilnya lumayan.', 'Hmm, korelasinya aneh.', 'Kopi... butuh kopi.', 'Parameter baru siap deploy.'],
  trader: ['Order {sym} terisi.', 'Spread melebar...', 'Stop di {sl} aman.', 'Fill bagus barusan.'],
  manager: ['Exposure total masih oke.', 'Saya review laporan risk dulu.', 'PnL {pnl}, lumayan.'],
  owner: ['Hmm, Sharpe ratio-nya naik.', 'Nanti saya tanya Odin soal ini.', 'Dashboard hijau, bagus.', 'Cek modul baru Evora...'],
};
const TRADER_ASK = ['{name}, spread {sym} kamu juga melebar?', '{name}, ada request dari Vortex barusan?', '{name}, chart {sym} kamu lag nggak?'];
const TRADER_REPLY = ['Iya, sama. Tunggu sebentar.', 'Belum, aman di sini.', 'Barusan masuk, sedang saya proses.'];

export function deskLine(who: CharacterDef, v: Vars): string {
  return fill(pick(DESK_LINES[who.role] ?? DESK_LINES.lead), v);
}

export function traderChatScript(parts: CharacterDef[], v: Vars): Line[] {
  return [[0, fill(pick(TRADER_ASK), with_(v, { name: parts[1].name }))], [1, pick(TRADER_REPLY)]];
}
