export type ClockMode = 'realtime' | 'demo';

const HOUR = 3_600_000;

/**
 * Wall clock of the office. In `realtime` it follows the computer clock, so
 * Odin's report happens every real hour. In `demo` one office hour passes
 * every `HOUR / demoScale` ms of animation time (default: 2 minutes).
 */
export class OfficeClock {
  time = Date.now();
  demoScale = 30;
  onHour: (hour: number) => void = () => {};
  private lastHourIndex: number;

  constructor(public mode: ClockMode = 'realtime') {
    this.lastHourIndex = Math.floor(this.time / HOUR);
  }

  setMode(mode: ClockMode): void {
    this.mode = mode;
    if (mode === 'realtime') this.time = Date.now();
    this.lastHourIndex = Math.floor(this.time / HOUR);
  }

  update(dt: number): void {
    this.time = this.mode === 'realtime' ? Date.now() : this.time + dt * 1000 * this.demoScale;
    const idx = Math.floor(this.time / HOUR);
    if (idx !== this.lastHourIndex) {
      this.lastHourIndex = idx;
      this.onHour(new Date(this.time).getHours());
    }
  }

  /** Office-clock milliseconds until the next full hour. */
  get msToNextHour(): number {
    return HOUR - (this.time % HOUR);
  }

  /** Real-time seconds until the next full hour at playback speed 1. */
  get realSecondsToNextHour(): number {
    return this.msToNextHour / 1000 / (this.mode === 'realtime' ? 1 : this.demoScale);
  }
}
