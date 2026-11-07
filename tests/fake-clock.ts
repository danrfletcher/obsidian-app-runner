import type { Clock } from "../src/clock";

/**
 * A clock that only moves when the test drives it. `sleep` registers a timer; `run` and `advance` fire timers in
 * time order, letting every promise chain settle in between, so 60 s of waiting takes no real time.
 */
export class FakeClock implements Clock {
  t: number;
  private timers: Array<{ at: number; resolve: () => void }> = [];

  constructor(start = 1_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.timers.push({ at: this.t + Math.max(0, ms), resolve }));
  }

  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.t + Math.max(0, ms), resolve: fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Let queued promise callbacks and immediate callbacks run, without moving time. */
  async settle(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
  }

  private fireNext(limit = Infinity): boolean {
    if (this.timers.length === 0) return false;
    this.timers.sort((a, b) => a.at - b.at);
    if (this.timers[0].at > limit) return false;
    const next = this.timers.shift()!;
    this.t = Math.max(this.t, next.at);
    next.resolve();
    return true;
  }

  /** Move time forward by `ms`, firing timers as they come due. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await this.settle();
    while (this.fireNext(target)) await this.settle();
    this.t = target;
    await this.settle();
  }

  /** Drive time until `promise` settles, then return its value (or throw its error). */
  async run<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    let value: T | undefined;
    let error: unknown;
    let failed = false;
    promise.then(
      (v) => ((done = true), (value = v)),
      (e) => ((done = true), (failed = true), (error = e)),
    );
    for (let spins = 0; !done; ) {
      await this.settle();
      if (done) break;
      if (this.fireNext()) continue;
      // Nothing to fire: real timers (a setTimeout(0)) or real I/O may still be due.
      await new Promise((r) => setTimeout(r, 2));
      if (++spins > 500) throw new Error("FakeClock.run: the promise never settled and no timer is pending");
    }
    if (failed) throw error;
    return value as T;
  }
}
