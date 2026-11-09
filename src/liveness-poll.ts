import type { Clock } from "./clock";

/** E21: how often an adopted app is checked. It is not our child, so no exit event ever tells us it died. */
export const LIVENESS_MS = 5000;

/** `alive`: look again in 5 s. `gone`: the app is finished with (dead, stopped or replaced); stop polling it. */
export type LivenessVerdict = "alive" | "gone";

export interface LivenessPollDeps {
  clock: Clock;
  /** Look at one adopted app. Called once per tick, never twice at once for the same app. */
  check(slug: string): Promise<LivenessVerdict>;
  intervalMs?: number;
}

/**
 * A 5 s poll per watched app. Each app has at most one timer. A check that is still running when `unwatch` or
 * `dispose` is called does not schedule another, so nothing is polled after Stop or unload.
 */
export class LivenessPoll {
  private readonly watched = new Set<string>();
  private readonly timers = new Map<string, () => void>();
  private disposed = false;

  constructor(private readonly deps: LivenessPollDeps) {}

  get intervalMs(): number {
    return this.deps.intervalMs ?? LIVENESS_MS;
  }

  isWatching(slug: string): boolean {
    return this.watched.has(slug);
  }

  get watchedCount(): number {
    return this.watched.size;
  }

  watch(slug: string): void {
    if (this.disposed || this.watched.has(slug)) return;
    this.watched.add(slug);
    this.schedule(slug);
  }

  unwatch(slug: string): void {
    this.watched.delete(slug);
    this.timers.get(slug)?.();
    this.timers.delete(slug);
  }

  /** Plugin unload: every timer is cancelled and nothing is scheduled again. */
  dispose(): void {
    this.disposed = true;
    for (const slug of [...this.watched]) this.unwatch(slug);
  }

  private schedule(slug: string): void {
    this.timers.set(
      slug,
      this.deps.clock.after(this.intervalMs, () => void this.tick(slug)),
    );
  }

  private async tick(slug: string): Promise<void> {
    this.timers.delete(slug);
    if (this.disposed || !this.watched.has(slug)) return;
    let verdict: LivenessVerdict;
    try {
      verdict = await this.deps.check(slug);
    } catch {
      verdict = "alive"; // a failed look proves nothing; try again at the next tick
    }
    if (this.disposed || !this.watched.has(slug)) return;
    if (verdict === "gone") this.watched.delete(slug);
    else this.schedule(slug);
  }
}
