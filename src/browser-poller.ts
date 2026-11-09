import type { Clock } from "./clock";
import { classifyOsascriptFailure, osascriptArgs, parseTabUrls, tabUrlsScript } from "./browser-script";
import type { DefaultBrowserReader, OsascriptRunner, RunningCheck } from "./browser-system";
import { classifyBrowser } from "./default-browser";
import { countMatchingTabs } from "./url-match";

/** G13: how often the default browser's tabs are read while a browser session is expected. */
export const BROWSER_POLL_MS = 5000;

/**
 * What one poll found. `tabs`: the browser was read; `count` of its tabs are on the instance's port. `not-running`: the
 * default browser is a supported one but is not running, so nothing was sent to it and no tab is counted (E23).
 * `unsupported`, `denied` and `error` mean the tabs could not be read.
 */
export type BrowserReadResult =
  | { kind: "tabs"; count: number }
  | { kind: "not-running" }
  | { kind: "unsupported"; bundleId: string }
  | { kind: "denied"; appName: string }
  | { kind: "error"; message: string };

export interface BrowserReaderDeps {
  defaultBrowser: DefaultBrowserReader;
  isRunning: RunningCheck;
  osascript: OsascriptRunner;
}

/**
 * G13, E9, E23: one look at the default browser. In this order: the default browser's bundle id is read (an
 * unsupported one ends the look); it is checked for running without launching it (a browser that is not running ends
 * the look, with no AppleScript sent); only then is its tab list read, and the tabs on `port` counted. A denied
 * permission, an unexpected osascript result or any thrown failure is a result, never an exception.
 */
export async function readBrowserTabs(deps: BrowserReaderDeps, port: number): Promise<BrowserReadResult> {
  try {
    const kind = classifyBrowser(await deps.defaultBrowser());
    if (!kind.supported) return { kind: "unsupported", bundleId: kind.bundleId };
    const { browser } = kind;
    if (!(await deps.isRunning(browser.bundleId))) return { kind: "not-running" };
    const run = await deps.osascript(osascriptArgs(tabUrlsScript(browser.id)));
    if (run.code !== 0) {
      const failure = classifyOsascriptFailure(run.stderr);
      if (failure.kind === "denied") return { kind: "denied", appName: browser.appName };
      if (failure.kind === "not-running") return { kind: "not-running" };
      return failure;
    }
    return { kind: "tabs", count: countMatchingTabs(parseTabUrls(run.stdout), port) };
  } catch (e) {
    return { kind: "error", message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

export interface BrowserPollerDeps {
  clock: Clock;
  /** One look for this project; null when there is nothing to look for yet (no port), which skips the tick. */
  read(slug: string): Promise<BrowserReadResult | null>;
  /** The result of a tick. Not called for a project that was stopped or replaced while the look was running. */
  onResult(slug: string, result: BrowserReadResult): void;
  intervalMs?: number;
}

interface Watch {
  gen: number;
  timer: (() => void) | null;
  inFlight: Promise<void> | null;
}

/**
 * G13: a poll per watched project, one look at a time. The next look is scheduled when the last one has finished, 5 s
 * later, so a slow osascript delays the next poll instead of stacking another on top of it. `pollNow` is a look right
 * now (used at relaunch, before any stop decision); a look already running is joined, not repeated. `stop` and `dispose`
 * cancel the timer, and a look still running when they are called has its result dropped.
 */
export class BrowserPoller {
  private readonly watches = new Map<string, Watch>();
  private gen = 0;
  private disposed = false;

  constructor(private readonly deps: BrowserPollerDeps) {}

  get intervalMs(): number {
    return this.deps.intervalMs ?? BROWSER_POLL_MS;
  }

  isWatching(slug: string): boolean {
    return this.watches.has(slug);
  }

  get watchedCount(): number {
    return this.watches.size;
  }

  /** Begin polling. The first look is one interval from now. Does nothing if the project is already watched. */
  start(slug: string): void {
    if (this.disposed || this.watches.has(slug)) return;
    const watch: Watch = { gen: ++this.gen, timer: null, inFlight: null };
    this.watches.set(slug, watch);
    this.schedule(slug, watch);
  }

  /** Look now. Resolves when that look's result has been delivered (or dropped). Does nothing if the project is not watched. */
  pollNow(slug: string): Promise<void> {
    const watch = this.watches.get(slug);
    if (this.disposed || !watch) return Promise.resolve();
    if (watch.inFlight) return watch.inFlight;
    watch.timer?.();
    watch.timer = null;
    return this.tick(slug, watch);
  }

  stop(slug: string): void {
    const watch = this.watches.get(slug);
    if (!watch) return;
    watch.timer?.();
    this.watches.delete(slug);
  }

  dispose(): void {
    this.disposed = true;
    for (const slug of [...this.watches.keys()]) this.stop(slug);
  }

  private schedule(slug: string, watch: Watch): void {
    watch.timer = this.deps.clock.after(this.intervalMs, () => {
      watch.timer = null;
      void this.tick(slug, watch);
    });
  }

  private tick(slug: string, watch: Watch): Promise<void> {
    if (watch.inFlight) return watch.inFlight;
    const live = () => !this.disposed && this.watches.get(slug) === watch;
    const run = (async () => {
      let result: BrowserReadResult | null = null;
      try {
        result = await this.deps.read(slug);
      } catch (e) {
        result = { kind: "error", message: e instanceof Error ? e.message : String(e) };
      }
      if (!live()) return;
      if (result) {
        try {
          this.deps.onResult(slug, result);
        } catch {
          // A listener's failure must not end the poll.
        }
      }
    })().finally(() => {
      watch.inFlight = null;
      if (live() && watch.timer === null) this.schedule(slug, watch);
    });
    watch.inFlight = run;
    return run;
  }
}
