import type { Clock } from "./clock";
import type { InstanceState, Rediscovery, StopOptions, StopResult } from "./instance";
import { membersOf, type Member, type ProcessTable, type ProcRow } from "./process-group";
import type { Project } from "./project";
import { isStale, type RegistryEntry, type RegistryStore } from "./registry";

/** G10: how long after layout ready an adopted app with Kill on and no tab is left before it is stopped. */
export const ADOPT_GRACE_MS = 15_000;

/** What adoption asks of the instance manager. `InstanceManager` is the real one. */
export interface AdoptTarget {
  adopt(entry: RegistryEntry, project: Project, members: readonly Member[]): "adopted" | "refused";
  rediscover(slug: string): Promise<Rediscovery | null>;
  persist(slug: string): Promise<void>;
  /** The same Stop as the Stop command and the kill timer: there is no second stop path. */
  stop(slug: string, options?: StopOptions): Promise<StopResult>;
  stateOf(slug: string): InstanceState | "none";
  isHeld(slug: string): boolean;
  browserSessionExpected(slug: string): boolean;
}

export interface AdoptionDeps {
  registry: RegistryStore;
  /** Only `snapshotScoped` is used here: at launch `ps` is asked about recorded pids and groups only (F14). */
  table: ProcessTable;
  target: AdoptTarget;
  getProject(slug: string): Project | undefined;
  /** Obsidian tabs for the project, counted from saved view state. Zero until layout ready. */
  sessionCount(slug: string): number;
  killOnClose(slug: string): boolean | undefined;
  clock: Clock;
  notify(message: string): void;
  /**
   * G10/G13: resume the browser poll for apps whose registry entry says a browser session was expected. The stop
   * decision waits for it. This PR only provides the hook; the browser poll plugs in later. Absent means nothing to resume.
   */
  resumeBrowserPoll?(slugs: string[]): Promise<void>;
  /** The adoption decision for the app is made: the normal Kill-when-closed rule may take over. */
  onSettled?(slug: string): void;
  graceMs?: number;
}

export interface AdoptionReport {
  adopted: string[];
  /** Entries with no live recorded member (a reboot, a pid reused, an app that died): dropped, nothing signalled. */
  dropped: string[];
  /** Entries for a slug that already had an instance: not adopted a second time (F10). */
  refused: string[];
}

/** A project that is no longer in settings but whose app is still running: shown by its slug, never auto-stopped. */
export function orphanProject(slug: string): Project {
  return { name: slug, slug, folder: "", command: "", urlOverride: "", killOnClose: false, openInBrowser: false };
}

function names(list: readonly string[]): string {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * The one notice adoption shows (G10): which apps it stopped, which are still running from the last session. null when
 * there is nothing to say.
 */
export function adoptionNotice(stopped: readonly string[], stillRunning: readonly string[]): string | null {
  const parts: string[] = [];
  if (stopped.length > 0) {
    const one = stopped.length === 1;
    parts.push(`${names(stopped)} ${one ? "was" : "were"} left running with no tab open, so ${one ? "it was" : "they were"} stopped.`);
  }
  if (stillRunning.length > 0) {
    parts.push(`${names(stillRunning)} ${stillRunning.length === 1 ? "is" : "are"} still running from the last session.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * G10: at launch, adopt what the registry says is still running, drop the rest, then (after layout ready) decide what to
 * stop.
 *
 * Phase 1, `adoptAll`: read the registry; one `ps` scoped to the recorded pids and groups; an entry with no live recorded
 * member (same pid and start time) is stale and dropped, with nothing signalled; the others become running instances and
 * their ports are found again. A file that cannot be read adopts nothing and signals nothing.
 *
 * Phase 2, `layoutReady`: resume the browser poll where one was expected, then, 15 s after layout ready, stop the apps
 * with Kill on that still have no tab. Until then the kill timer is suspended for adopted apps, so a restored tab that
 * has not been counted yet can never cost an app its life. One notice says what was stopped and what is still running.
 */
export class Adoption {
  private readonly pending = new Set<string>();
  private cancelWait: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly deps: AdoptionDeps) {}

  /** True while the app's stop decision is still to be made. */
  suspended(slug: string): boolean {
    return this.pending.has(slug);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async adoptAll(): Promise<AdoptionReport> {
    const report: AdoptionReport = { adopted: [], dropped: [], refused: [] };
    const { registry, table, target } = this.deps;
    let entries: RegistryEntry[];
    try {
      const read = await registry.read();
      entries = Object.values(read.entries).sort((a, b) => a.startedAt - b.startedAt || a.slug.localeCompare(b.slug));
    } catch {
      this.deps.notify("App Runner could not read its list of running apps, so it left any running apps alone.");
      return report;
    }
    if (entries.length === 0) return report;

    let rows: ProcRow[];
    try {
      rows = await table.snapshotScoped({
        pids: entries.flatMap((e) => [e.pid, ...e.members.map((m) => m.pid)]),
        pgids: entries.map((e) => e.pgid),
      });
    } catch {
      // A failed look proves nothing about the apps: keep every entry and signal nothing.
      this.deps.notify("App Runner could not check which apps are still running, so it left them alone.");
      return report;
    }

    for (const entry of entries) {
      if (isStale(entry, rows)) {
        await registry.remove(entry.slug).catch(() => undefined);
        report.dropped.push(entry.slug);
        continue;
      }
      const project = this.deps.getProject(entry.slug) ?? orphanProject(entry.slug);
      if (target.adopt(entry, project, membersOf(rows, entry.pgid)) === "refused") {
        report.refused.push(entry.slug);
        continue;
      }
      this.pending.add(entry.slug);
      report.adopted.push(entry.slug);
    }

    // The ports are found again (no answering port was needed to adopt) and each entry is written back with what is now known.
    await Promise.all(
      report.adopted.map(async (slug) => {
        await target.rediscover(slug).catch(() => null);
        await target.persist(slug);
      }),
    );
    return report;
  }

  /** Called when Obsidian's layout is ready and the restored tabs have been counted. */
  async layoutReady(): Promise<void> {
    if (this.disposed || this.pending.size === 0) return;
    const { target } = this.deps;

    const expecting = [...this.pending].filter((slug) => target.browserSessionExpected(slug));
    if (expecting.length > 0 && this.deps.resumeBrowserPoll) {
      try {
        await this.deps.resumeBrowserPoll(expecting);
      } catch {
        // A poll that cannot resume holds the app (that is the poll's job); it is no reason to stop or to skip the decision.
      }
      if (this.disposed) return;
    }

    const due = (slug: string) => this.deps.killOnClose(slug) === true && this.deps.sessionCount(slug) === 0 && !target.isHeld(slug);
    const candidates = [...this.pending].filter(due);
    if (candidates.length > 0) {
      await this.wait(this.deps.graceMs ?? ADOPT_GRACE_MS);
      if (this.disposed) return;
    }

    const stopped: string[] = [];
    const stillRunning: string[] = [];
    for (const slug of [...this.pending]) {
      const name = this.deps.getProject(slug)?.name ?? slug;
      if (target.stateOf(slug) !== "running") {
        this.settle(slug); // died meanwhile, or somebody else is stopping it
        continue;
      }
      const noTab = this.deps.sessionCount(slug) === 0;
      if (candidates.includes(slug) && due(slug)) {
        await target.stop(slug, { silent: true }).catch(() => undefined);
        if (this.disposed) return;
        (target.stateOf(slug) === "none" ? stopped : stillRunning).push(name);
      } else if (noTab && (this.deps.killOnClose(slug) !== true || target.isHeld(slug))) {
        // Kill off, or Held (G12: opened in the browser, stops only on Stop): named as still running, never stopped here.
        stillRunning.push(name);
      }
      this.settle(slug);
    }
    const notice = adoptionNotice(stopped, stillRunning);
    if (notice) this.deps.notify(notice);
  }

  private settle(slug: string): void {
    if (!this.pending.delete(slug)) return;
    this.deps.onSettled?.(slug);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = this.deps.clock.after(ms, () => {
        this.cancelWait = null;
        resolve();
      });
      this.cancelWait = () => {
        cancel();
        this.cancelWait = null;
        resolve();
      };
    });
  }

  /** Plugin unload: a decision still waiting for its 15 s is dropped, so nothing is stopped and no notice is shown (G15). */
  dispose(): void {
    this.disposed = true;
    this.cancelWait?.();
    this.pending.clear();
  }
}
