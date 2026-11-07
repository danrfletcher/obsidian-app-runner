import type { Clock } from "./clock";
import { BrowserPoller, readBrowserTabs, type BrowserReadResult, type BrowserReaderDeps } from "./browser-poller";
import { HELD_AUTOMATION_DENIED, HELD_BROWSER_UNSUPPORTED } from "./held";
import { HoldSequencer } from "./hold-sequencing";
import type { InstanceEvent, InstanceState } from "./instance";

/** What the monitor asks of the instance manager. `InstanceManager` is the real one. */
export interface MonitorTarget {
  subscribe(listener: (event: InstanceEvent) => void): () => void;
  /** Called each time the app is given to the default browser. */
  subscribeHandOff(listener: (slug: string) => void): () => void;
  stateOf(slug: string): InstanceState | "none";
  /** G13: the persisted browser-session-expected flag. */
  browserSessionExpected(slug: string): boolean;
  portOf(slug: string): number | null;
  isHeld(slug: string): boolean;
  heldReasonOf(slug: string): string;
  setHeld(slug: string, held: boolean, reason?: string): void;
}

export interface BrowserMonitorDeps {
  clock: Clock;
  target: MonitorTarget;
  reader: BrowserReaderDeps;
  notify(message: string): void;
  /** The project's display name, for notices. */
  nameOf(slug: string): string;
  pollMs?: number;
  holdMs?: number;
}

interface Watched {
  seq: HoldSequencer;
  /** The last problem reason a notice was shown for, so one outage is announced once. */
  announced: string | null;
  lastTabs: number;
}

/**
 * G13: browser tab monitoring. For every running app with a browser session expected it polls the default browser
 * every 5 s (never launching it), counts the tabs on the app's port, and runs the hold sequencing (`HoldSequencer`).
 * It owns three outputs and nothing else:
 *
 * - `tabCount(slug)`, which the kill timer, the adoption decision and the running list add to the Obsidian tab count;
 * - the Held flag of the instance, set from the sequencer's reason (the pop-out hold, or why the browser cannot be read);
 * - a notice when the browser turns out to be unsupported or the permission is denied.
 *
 * It never stops an app. A stopped, crashed or replaced instance, plugin unload and a denied permission all end its
 * polling for that app; unload leaves the instance and its registry entry exactly as they are.
 */
export class BrowserMonitor {
  private readonly watched = new Map<string, Watched>();
  private readonly poller: BrowserPoller;
  private readonly listeners = new Set<(slug: string) => void>();
  private readonly unsubscribe: Array<() => void>;
  private disposed = false;

  constructor(private readonly deps: BrowserMonitorDeps) {
    this.poller = new BrowserPoller({
      clock: deps.clock,
      intervalMs: deps.pollMs,
      read: async (slug) => {
        const port = deps.target.portOf(slug);
        return port === null ? null : readBrowserTabs(deps.reader, port);
      },
      onResult: (slug, result) => this.onResult(slug, result),
    });
    this.unsubscribe = [
      deps.target.subscribe((event) => this.evaluate(event.slug)),
      deps.target.subscribeHandOff((slug) => this.onHandOff(slug)),
    ];
  }

  /** Browser tabs of the project's app, from the last poll that could read the browser. */
  tabCount(slug: string): number {
    return this.watched.get(slug)?.seq.tabs ?? 0;
  }

  /** Hear about a project's browser tab count changing. Returns the unsubscribe. */
  subscribe(listener: (slug: string) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  isPolling(slug: string): boolean {
    return this.poller.isWatching(slug);
  }

  get pollingCount(): number {
    return this.poller.watchedCount;
  }

  /** Whether a pop-out hold clock is running for the project. */
  hasHoldTimer(slug: string): boolean {
    return this.watched.get(slug)?.seq.hasPendingTimer ?? false;
  }

  /**
   * G10: at relaunch, look at the browser once now for each app whose registry entry expected a browser session, and wait
   * for the answer. The caller (adoption) decides what to stop only afterwards. Never throws.
   */
  async resume(slugs: readonly string[]): Promise<void> {
    for (const slug of slugs) this.evaluate(slug);
    await Promise.all(slugs.map((slug) => this.poller.pollNow(slug).catch(() => undefined)));
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.unsubscribe.splice(0)) off();
    this.poller.dispose();
    for (const w of this.watched.values()) w.seq.dispose();
    this.watched.clear();
    this.listeners.clear();
  }

  /** The app was given to the browser: watch it if it was not watched yet, and start a fresh hold. */
  private onHandOff(slug: string): void {
    if (this.disposed) return;
    this.evaluate(slug);
    this.watched.get(slug)?.seq.begin();
  }

  /** Start, keep or end watching a project to match its instance. Idempotent. */
  evaluate(slug: string): void {
    if (this.disposed) return;
    const t = this.deps.target;
    const active = t.stateOf(slug) === "running" && t.browserSessionExpected(slug);
    const watched = this.watched.get(slug);
    if (!active) {
      if (watched) this.forget(slug, watched);
      return;
    }
    if (!watched) {
      const reason = t.heldReasonOf(slug);
      const seq = new HoldSequencer(
        { clock: this.deps.clock, holdMs: this.deps.holdMs, onChange: () => this.sync(slug) },
        { holding: t.isHeld(slug), problem: t.isHeld(slug) ? reason : null },
      );
      this.watched.set(slug, { seq, announced: seq.problemReason, lastTabs: 0 });
    }
    if (!this.watched.get(slug)!.seq.denied) this.poller.start(slug);
  }

  private forget(slug: string, watched: Watched): void {
    this.poller.stop(slug);
    watched.seq.dispose();
    this.watched.delete(slug);
    if (watched.lastTabs !== 0) this.emit(slug);
  }

  private onResult(slug: string, result: BrowserReadResult): void {
    const watched = this.watched.get(slug);
    if (!watched) return;
    watched.seq.apply(result);
    if (watched.seq.denied) this.poller.stop(slug); // permanent: later polls do not retry
  }

  /** The sequencer changed: pass on the tab count first, then the Held flag, so the kill timer sees both settled. */
  private sync(slug: string): void {
    const watched = this.watched.get(slug);
    if (!watched || this.disposed) return;
    const { seq } = watched;
    if (watched.lastTabs !== seq.tabs) {
      watched.lastTabs = seq.tabs;
      this.emit(slug);
    }
    const reason = seq.heldReason;
    if (reason !== null) this.deps.target.setHeld(slug, true, reason);
    else if (this.deps.target.isHeld(slug)) this.deps.target.setHeld(slug, false);
    this.announce(slug, watched);
  }

  private announce(slug: string, watched: Watched): void {
    const problem = watched.seq.problemReason;
    if (problem === watched.announced) return;
    watched.announced = problem;
    const name = this.deps.nameOf(slug);
    if (problem === HELD_AUTOMATION_DENIED) {
      this.deps.notify(`${name} stays running until you stop it: macOS did not allow App Runner to read your browser's tabs. Allow it in System Settings, Privacy & Security, Automation.`);
    } else if (problem === HELD_BROWSER_UNSUPPORTED) {
      this.deps.notify(`${name} stays running until you stop it: App Runner can read tabs only in Brave, Chrome, Arc and Edge, and your default browser is another one.`);
    }
  }

  private emit(slug: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(slug);
      } catch {
        // One listener's failure must not stop the others hearing the change.
      }
    }
  }
}
