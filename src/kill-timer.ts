import type { Clock } from "./clock";
import type { InstanceState } from "./instance";

/** G14: how long a project must sit at zero sessions before it is stopped. */
export const GRACE_MS = 15_000;

export interface KillTimerDeps {
  clock: Clock;
  /** Obsidian tabs plus browser tabs for the project (G13: browser tabs come from the browser monitor). */
  sessionCount(slug: string): number;
  stateOf(slug: string): InstanceState | "none";
  isHeld(slug: string): boolean;
  /**
   * True while something else is deciding whether this project's app should stop. An app adopted at launch waits for
   * layout ready + 15 s (so restored tabs have been counted); the timer must not start before that decision is made.
   */
  suspended?(slug: string): boolean;
  /** The project's Kill-when-all-tabs-closed toggle as stored now; undefined when the project is gone. */
  killOnClose(slug: string): boolean | undefined;
  /** Stop the instance (the same call as the Stop command). */
  stop(slug: string): Promise<unknown> | void;
  /** Hear about an instance changing state, appearing or ending. Returns the unsubscribe. */
  onInstanceChange(listener: (slug: string) => void): () => void;
  /** Hear about a session count changing. Returns the unsubscribe. */
  onSessionChange(listener: (slug: string) => void): () => void;
  graceMs?: number;
}

/**
 * G14: one pending timer per project at most. A project is "due" when its instance is running, Kill is on, it is not
 * Held, has not been suspended by the adoption decision, and has no sessions. Becoming due arms the timer; ceasing to be
 * due (a tab opens, Kill goes off, the instance is Held, stops, crashes or never reached running) cancels it. When the
 * timer fires the conditions are checked again before the one `stop` call.
 *
 * `evaluate(slug)` is the only way anything changes: it is idempotent, so any number of events leave one timer.
 * An instance that failed to start never reaches `running`, so it never arms one; a crash ends the instance, which
 * cancels it. Nothing here ever starts an app (F4).
 */
export class KillTimer {
  private readonly pending = new Map<string, () => void>();
  private readonly unsubscribe: Array<() => void>;
  private disposed = false;

  constructor(private readonly deps: KillTimerDeps) {
    this.unsubscribe = [deps.onInstanceChange((slug) => this.evaluate(slug)), deps.onSessionChange((slug) => this.evaluate(slug))];
  }

  get graceMs(): number {
    return this.deps.graceMs ?? GRACE_MS;
  }

  /** Whether a timer is waiting for this project. */
  isPending(slug: string): boolean {
    return this.pending.has(slug);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private isDue(slug: string): boolean {
    const d = this.deps;
    return d.stateOf(slug) === "running" && d.killOnClose(slug) === true && !d.isHeld(slug) && d.suspended?.(slug) !== true && d.sessionCount(slug) === 0;
  }

  /** Arm, keep or cancel the project's timer to match the rule. A timer already running is kept, not restarted. */
  evaluate(slug: string): void {
    if (this.disposed) return;
    const due = this.isDue(slug);
    const waiting = this.pending.has(slug);
    if (due && !waiting) {
      this.pending.set(slug, this.deps.clock.after(this.graceMs, () => this.fire(slug)));
    } else if (!due && waiting) {
      this.cancel(slug);
    }
  }

  private cancel(slug: string): void {
    this.pending.get(slug)?.();
    this.pending.delete(slug);
  }

  private fire(slug: string): void {
    this.pending.delete(slug);
    if (this.disposed || !this.isDue(slug)) return;
    try {
      void Promise.resolve(this.deps.stop(slug)).catch(() => undefined);
    } catch {
      // Stop reports its own failures; a throw here must not escape a timer callback.
    }
  }

  /** Plugin unload: cancel every timer and drop every listener. Nothing fires afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const slug of [...this.pending.keys()]) this.cancel(slug);
    for (const off of this.unsubscribe.splice(0)) off();
  }
}
