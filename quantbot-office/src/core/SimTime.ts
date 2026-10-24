/**
 * Animation time. Advances with (real dt x playback speed), so pausing or
 * fast-forwarding the office also pauses/speeds every scripted wait.
 */
export class SimTime {
  now = 0;
  private timers: { at: number; resolve: () => void }[] = [];

  advance(dt: number): void {
    this.now += dt;
    if (!this.timers.length) return;
    const due = this.timers.filter((t) => t.at <= this.now);
    if (!due.length) return;
    this.timers = this.timers.filter((t) => t.at > this.now);
    due.forEach((t) => t.resolve());
  }

  wait(seconds: number): Promise<void> {
    return new Promise((resolve) => this.timers.push({ at: this.now + Math.max(0, seconds), resolve }));
  }
}
