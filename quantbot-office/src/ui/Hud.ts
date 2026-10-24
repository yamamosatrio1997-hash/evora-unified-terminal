import type { Agent } from '../agents/Agent';
import type { CharacterDef } from '../config/roster';
import type { ClockMode } from '../core/OfficeClock';
import { CAMERA_PRESETS, type CameraPreset } from '../core/World';
import { SCENARIO_LABELS, type ScenarioKind } from '../sim/Director';
import { fmtMoney, fmtSigned, type FundSnapshot } from '../sim/FundState';

export interface HudHandlers {
  onCamera: (p: CameraPreset) => void;
  onFollow: (agent: Agent | null) => void;
  onScenario: (kind: ScenarioKind) => string;
  onSpeed: (speed: number) => void;
  onClockMode: (mode: ClockMode) => void;
  onUpperFloor: (visible: boolean) => void;
  onTags: (visible: boolean) => void;
  onAutoplay: (on: boolean) => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const two = (n: number) => String(n).padStart(2, '0');

/** Control panels: clock & fund, camera, scenario triggers, live feed and roster. */
export class Hud {
  private readonly clock = el('div', 'clock');
  private readonly date = el('div', 'muted');
  private readonly nextReport = el('div', 'next-report');
  private readonly fund = el('div', 'fund');
  private readonly feed = el('ol', 'feed');
  private readonly roster = el('ul', 'roster');
  private readonly toastEl = el('div', 'toast');
  private readonly rosterRows = new Map<string, HTMLLIElement>();
  private toastTimer = 0;
  private upperVisible = true;
  private readonly upperBtn: HTMLButtonElement;

  constructor(root: HTMLElement, private readonly agents: Agent[], private readonly h: HudHandlers, mode: ClockMode, speed = 1) {
    // Top-left: brand, clock, fund
    const status = el('section', 'panel status');
    status.append(el('div', 'brand', 'QUANTBOT HQ'), el('div', 'muted small', 'Evora Unified Terminal · Live Office'), this.clock, this.date, this.nextReport, this.fund);
    const modeRow = el('div', 'row');
    const realBtn = this.button('Real-time', () => setMode('realtime'));
    const demoBtn = this.button('Demo (1 jam = 2 mnt)', () => setMode('demo'));
    const setMode = (m: ClockMode) => {
      realBtn.classList.toggle('on', m === 'realtime');
      demoBtn.classList.toggle('on', m === 'demo');
      h.onClockMode(m);
    };
    realBtn.classList.toggle('on', mode === 'realtime');
    demoBtn.classList.toggle('on', mode === 'demo');
    modeRow.append(realBtn, demoBtn);
    status.append(modeRow);

    // Top-right: camera + view toggles
    const cam = el('section', 'panel camera');
    cam.append(el('h3', '', 'Kamera'));
    const camRow = el('div', 'row wrap');
    for (const p of CAMERA_PRESETS) {
      camRow.append(this.button(p.label, () => {
        h.onFollow(null);
        this.setUpper(!p.hideUpper);
        h.onCamera(p);
      }));
    }
    cam.append(camRow);
    const viewRow = el('div', 'row wrap');
    this.upperBtn = this.button('Lantai 2: tampil', () => this.setUpper(!this.upperVisible));
    let tags = true;
    const tagBtn = this.button('Nama: tampil', () => {
      tags = !tags;
      tagBtn.textContent = `Nama: ${tags ? 'tampil' : 'sembunyi'}`;
      h.onTags(tags);
    });
    viewRow.append(this.upperBtn, tagBtn);
    cam.append(viewRow);

    // Bottom-left: scenarios + playback
    const ctl = el('section', 'panel controls');
    ctl.append(el('h3', '', 'Skenario'));
    const scRow = el('div', 'row wrap');
    for (const kind of Object.keys(SCENARIO_LABELS) as ScenarioKind[]) {
      scRow.append(this.button(SCENARIO_LABELS[kind], () => this.toast(h.onScenario(kind)), kind === 'report' ? 'accent' : ''));
    }
    ctl.append(scRow);
    const pbRow = el('div', 'row');
    const speeds: [string, number][] = [['❚❚', 0], ['1x', 1], ['2x', 2], ['4x', 4]];
    const speedBtns = speeds.map(([label, v]) => {
      const b = this.button(label, () => {
        speedBtns.forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        h.onSpeed(v);
      });
      if (v === speed) b.classList.add('on');
      return b;
    });
    let auto = true;
    const autoBtn = this.button('Auto: ON', () => {
      auto = !auto;
      autoBtn.textContent = `Auto: ${auto ? 'ON' : 'OFF'}`;
      autoBtn.classList.toggle('on', auto);
      h.onAutoplay(auto);
    });
    autoBtn.classList.add('on');
    pbRow.append(...speedBtns, autoBtn);
    ctl.append(pbRow);

    // Right: feed + roster
    const side = el('section', 'panel side');
    side.append(el('h3', '', 'Office Feed'), this.feed, el('h3', '', 'Tim (klik untuk ikuti)'), this.roster);
    for (const a of agents) {
      const li = el('li');
      li.style.setProperty('--accent', a.def.role === 'lead' ? a.def.look.shirt : a.def.look.accent);
      li.append(el('b', '', a.def.name), el('span', 'st', ''));
      li.title = a.def.title;
      li.onclick = () => {
        this.setUpper(true);
        h.onFollow(a);
        this.toast(`Mengikuti ${a.def.name}`);
      };
      if (a.def.role === 'trader') li.classList.add('trader');
      this.roster.append(li);
      this.rosterRows.set(a.id, li);
    }

    root.append(status, cam, ctl, side, this.toastEl);
  }

  setUpper(visible: boolean): void {
    this.upperVisible = visible;
    this.upperBtn.textContent = `Lantai 2: ${visible ? 'tampil' : 'sembunyi'}`;
    this.h.onUpperFloor(visible);
  }

  addLine(def: CharacterDef, text: string, time: number): void {
    const li = el('li');
    const d = new Date(time);
    li.style.setProperty('--accent', def.role === 'lead' ? def.look.shirt : def.look.accent);
    li.append(el('time', '', `${two(d.getHours())}:${two(d.getMinutes())}`), el('b', '', def.name), el('span', '', text));
    this.feed.prepend(li);
    while (this.feed.children.length > 60) this.feed.lastChild!.remove();
  }

  addEvent(text: string, time: number): void {
    const li = el('li', 'event');
    const d = new Date(time);
    li.append(el('time', '', `${two(d.getHours())}:${two(d.getMinutes())}`), el('span', '', text));
    this.feed.prepend(li);
  }

  update(officeTime: number, secondsToReport: number, reportPending: boolean, fund: FundSnapshot, quiet: boolean): void {
    const d = new Date(officeTime);
    this.clock.textContent = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
    this.date.textContent = d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const s = Math.max(0, Math.floor(secondsToReport));
    this.nextReport.textContent = reportPending
      ? 'Odin sedang menuju / report ke Yama'
      : `Report Odin berikutnya: ${two(Math.floor(s / 60))}:${two(s % 60)}`;
    this.fund.innerHTML = '';
    const pnl = el('span', fund.pnlToday >= 0 ? 'up' : 'down', fmtSigned(fund.pnlToday));
    this.fund.append(
      el('span', '', `Equity ${fmtMoney(fund.equity)}`), pnl,
      el('span', 'muted', `DD ${fund.drawdownPct.toFixed(2)}% · Pasar ${quiet ? 'tenang' : 'ramai'}`),
    );
    for (const a of this.agents) {
      const st = this.rosterRows.get(a.id)!.querySelector('.st')!;
      if (st.textContent !== a.status) st.textContent = a.status;
    }
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2600);
  }

  private button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = el('button', cls, label);
    b.type = 'button';
    b.onclick = onClick;
    return b;
  }
}
