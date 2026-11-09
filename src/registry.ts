import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { MAX_HELD_REASON_LENGTH } from "./held";
import { isOwned, MAX_PID, type Member, type ProcRow } from "./process-group";

/** What is recorded about a running app so Stop only ever signals a group the plugin itself started (F11). */
export interface RegistryEntry {
  slug: string;
  /** The group leader's pid, which is also the process group id. */
  pid: number;
  pgid: number;
  /** Every group member seen so far, each with its start time. */
  members: Member[];
  /** The port the app answered on, or null while it is still starting. */
  port: number | null;
  startedAt: number;
  /**
   * G13: a browser session is expected (the app was opened in the browser, popped out, or a browser tab was seen). It is
   * saved so that at relaunch the browser poll resumes before any stop decision (`BrowserMonitor.resume`). It stays set
   * for the life of the instance: polling continues so a browser tab opened later is still counted.
   */
  browserSessionExpected: boolean;
  /**
   * G12: the instance is Held (never auto-stopped) and `heldReason` says why, as a short code (see `held.ts`). Both are
   * written only while the instance is Held, so an entry of a free app has neither and an older file reads unchanged.
   * A relaunch adopts the app still Held, with the same reason.
   */
  held?: boolean;
  heldReason?: string;
  /** G13: the 30 s hold for the browser had already ended when this was written (only with `held`). */
  holdOver?: boolean;
}

export const REGISTRY_VERSION = 1;

export interface RegistryFile {
  version: typeof REGISTRY_VERSION;
  entries: Record<string, RegistryEntry>;
}

/** Why a `running.json` was set aside: invalid JSON, empty, another schema version, or not the right shape. */
export type RegistryProblem = "unreadable" | "empty" | "wrong-version" | "invalid";

export interface RegistryReadResult extends RegistryFile {
  /** Set when the file on disk could not be used. The registry is then empty and no process is signalled on its strength. */
  problem?: RegistryProblem;
  /** Where the bad file was moved, when it could be moved. */
  movedTo?: string;
  /** How many entries were dropped because another entry claimed the same slug and started later (F10). */
  duplicatesDropped?: number;
}

/** The two operations the instance code needs. */
export interface RegistryLike {
  set(entry: RegistryEntry): Promise<void>;
  remove(slug: string): Promise<void>;
}

/** What adoption needs on top: reading the file as it is now. */
export interface RegistryStore extends RegistryLike {
  read(): Promise<RegistryReadResult>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const isPid = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 1 && (v as number) <= MAX_PID;

/** A slug that is safe to use as a file name and a map key. */
const SAFE_SLUG = /^[A-Za-z0-9._-]+$/;

/**
 * One stored entry as a RegistryEntry, or null when it cannot be trusted. Everything that later feeds a `ps` argument or
 * a signal is checked here: pids and the group id are plain pids, and every member has a start time (an empty one would
 * match a row that printed none).
 */
export function parseEntry(v: unknown): RegistryEntry | null {
  if (!isRecord(v)) return null;
  const { slug, pid, pgid, members, port, startedAt } = v;
  if (typeof slug !== "string" || !SAFE_SLUG.test(slug) || slug === "." || slug === "..") return null;
  if (!isPid(pid) || !isPid(pgid) || !Array.isArray(members)) return null;
  const parsed: Member[] = [];
  for (const m of members) {
    if (!isRecord(m) || !isPid(m.pid) || typeof m.startTime !== "string" || m.startTime.trim() === "") return null;
    parsed.push({ pid: m.pid, startTime: m.startTime });
  }
  const portOk = port === null || port === undefined || (Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535);
  if (!portOk) return null;
  const entry: RegistryEntry = {
    slug,
    pid,
    pgid,
    members: parsed,
    port: (port as number | null | undefined) ?? null,
    startedAt: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : 0,
    browserSessionExpected: v.browserSessionExpected === true,
  };
  if (v.held === true) {
    entry.held = true;
    entry.heldReason = typeof v.heldReason === "string" ? v.heldReason.trim().slice(0, MAX_HELD_REASON_LENGTH) : "";
    if (v.holdOver === true) entry.holdOver = true;
  }
  return entry;
}

/**
 * The stale-entry rule (E6, E7). An entry is stale, and dropped without signalling anything, when no recorded member is
 * alive in the recorded process group with the start time that was recorded. A dead leader with a live recorded member is
 * NOT stale (the group is still ours); a live process with a matching pid but another start time is stale (the pid was
 * reused, as after a reboot).
 */
export function isStale(entry: Pick<RegistryEntry, "pgid" | "members">, rows: readonly ProcRow[]): boolean {
  return !isOwned(rows, entry.pgid, entry.members);
}

/**
 * `running.json` in the runtime directory (outside the vault). One entry per project. Changes are applied one after
 * another and written whole to a temporary file that is then renamed, so a crash never leaves half a file. A file that
 * cannot be used (invalid JSON, empty, another schema version, wrong shape) is moved aside, never overwritten, and the
 * registry starts empty; `onProblem` hears about it once.
 *
 * If a hand-edited file holds two entries for one slug, only the one that started later is kept (F10).
 */
export class Registry implements RegistryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly hooks: { onProblem?: (problem: RegistryProblem, movedTo: string | null) => void } = {},
  ) {}

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Read the file as it is now. Reads are queued with the writes, so they never see a half-applied change. */
  read(): Promise<RegistryReadResult> {
    return this.enqueue(() => this.readNow());
  }

  private async readNow(): Promise<RegistryReadResult> {
    let text: string;
    try {
      text = await fsp.readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: REGISTRY_VERSION, entries: {} };
      throw e;
    }
    if (text.trim() === "") return this.setAside("empty");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.setAside("unreadable");
    }
    if (!isRecord(parsed)) return this.setAside("invalid");
    if (parsed.version !== REGISTRY_VERSION) return this.setAside("wrong-version");
    if (!isRecord(parsed.entries)) return this.setAside("invalid");

    const entries: Record<string, RegistryEntry> = {};
    let duplicatesDropped = 0;
    for (const v of Object.values(parsed.entries)) {
      const entry = parseEntry(v);
      if (!entry) continue;
      const earlier = entries[entry.slug];
      if (earlier) {
        duplicatesDropped++;
        if (entry.startedAt < earlier.startedAt) continue;
      }
      entries[entry.slug] = entry;
    }
    return duplicatesDropped > 0 ? { version: REGISTRY_VERSION, entries, duplicatesDropped } : { version: REGISTRY_VERSION, entries };
  }

  /** Move the unusable file next to itself and start empty. A file that cannot be moved is left where it is. */
  private async setAside(problem: RegistryProblem): Promise<RegistryReadResult> {
    const target = `${this.file}.corrupt-${Date.now()}`;
    let movedTo: string | null = null;
    try {
      await fsp.rename(this.file, target);
      movedTo = target;
    } catch {
      movedTo = null;
    }
    try {
      this.hooks.onProblem?.(problem, movedTo);
    } catch {
      // A failing listener must not turn a bad file into a crash.
    }
    return movedTo ? { version: REGISTRY_VERSION, entries: {}, problem, movedTo } : { version: REGISTRY_VERSION, entries: {}, problem };
  }

  private async write(entries: Record<string, RegistryEntry>): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ version: REGISTRY_VERSION, entries }, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, this.file);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  set(entry: RegistryEntry): Promise<void> {
    return this.enqueue(async () => {
      const data = await this.readNow();
      data.entries[entry.slug] = entry;
      await this.write(data.entries);
    });
  }

  remove(slug: string): Promise<void> {
    return this.enqueue(async () => {
      const data = await this.readNow();
      if (!(slug in data.entries)) return;
      delete data.entries[slug];
      await this.write(data.entries);
    });
  }
}
