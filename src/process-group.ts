import { execFile } from "node:child_process";
import type { Clock } from "./clock";

/** One line of `ps -axo pid=,pgid=,lstart=`. `startTime` is the `lstart` text, kept as-is: it is only ever compared for equality. */
export interface ProcRow {
  pid: number;
  pgid: number;
  startTime: string;
}

/** A process we recorded as belonging to an app's group: its pid and when it started (a reused pid has another start time). */
export interface Member {
  pid: number;
  startTime: string;
}

/**
 * Parse `ps -axo pid=,pgid=` (optionally with `lstart=` as a third column). Blank lines, padding and lines that are
 * not two numbers are skipped.
 */
export function parsePs(output: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(\S.*?))?\s*$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), pgid: Number(m[2]), startTime: m[3] ?? "" });
  }
  return rows;
}

/** The members of process group `pgid` in a snapshot, with their start times. */
export function membersOf(rows: readonly ProcRow[], pgid: number): Member[] {
  return rows.filter((r) => r.pgid === pgid).map((r) => ({ pid: r.pid, startTime: r.startTime }));
}

/** `prev` plus any member of `seen` it did not have yet (same pid and start time counts as the same member). */
export function mergeMembers(prev: readonly Member[], seen: readonly Member[]): Member[] {
  const out = [...prev];
  for (const m of seen) if (!out.some((p) => p.pid === m.pid && p.startTime === m.startTime)) out.push(m);
  return out;
}

/**
 * The ownership rule: a group is ours only while a member we recorded (pid and start time) is alive in it. A pid that
 * was reused after a reboot has another start time, so it does not count.
 */
export function isOwned(rows: readonly ProcRow[], pgid: number, recorded: readonly Member[]): boolean {
  return rows.some((r) => r.pgid === pgid && recorded.some((m) => m.pid === r.pid && m.startTime === r.startTime));
}

/** Where process snapshots come from: `ps` in the real plugin, canned text in tests. */
export interface ProcessTable {
  snapshot(): Promise<ProcRow[]>;
}

export const PS_ARGS = ["-axo", "pid=,pgid=,lstart="];

export const realProcessTable: ProcessTable = {
  snapshot: () =>
    new Promise((resolve, reject) => {
      // LC_ALL=C keeps the lstart text the same across calls whatever the user's locale.
      execFile("ps", PS_ARGS, { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(parsePs(stdout));
      });
    }),
};

export type Signal = "SIGTERM" | "SIGKILL";
/** `process.kill` in the real plugin. A negative pid addresses a whole process group. */
export type KillFn = (pid: number, signal: Signal) => void;

export const realKill: KillFn = (pid, signal) => {
  process.kill(pid, signal);
};

/** Send `signal` to the whole group. A group that is already gone (ESRCH) is success, not an error. */
export function signalGroup(kill: KillFn, pgid: number, signal: Signal): "sent" | "gone" {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`Refusing to signal process group ${pgid}.`);
  try {
    kill(-pgid, signal);
    return "sent";
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ESRCH") return "gone";
    throw e;
  }
}

export const TERM_GRACE_MS = 5000;
const POLL_MS = 100;

export interface StopGroupOptions {
  pgid: number;
  /** The members recorded for this group. Without a match in a live process the group is not signalled. */
  members: readonly Member[];
  table: ProcessTable;
  kill: KillFn;
  clock: Clock;
  /**
   * True while the group leader, a child we spawned in this session, has not exited. A live leader is its own proof of
   * ownership (its pid cannot be reused while it lives), so the group is signalled even when no recorded member matches.
   */
  leaderAlive?: () => boolean;
  /** Send SIGTERM before the first `ps` (only with a live leader). For plugin unload. */
  immediate?: boolean;
  graceMs?: number;
  pollMs?: number;
}

export type StopOutcome = "not-ours" | "gone" | "terminated" | "killed";

/**
 * E8: SIGTERM to the group, then SIGKILL to the group after `graceMs` (5 s) if a recorded member is still alive. A group
 * that exits on SIGTERM is not SIGKILLed. Never signals a group without a recorded live member, and treats ESRCH as done.
 */
export async function stopGroup(o: StopGroupOptions): Promise<StopOutcome> {
  const graceMs = o.graceMs ?? TERM_GRACE_MS;
  const pollMs = o.pollMs ?? POLL_MS;
  const trusted = o.leaderAlive?.() === true;
  let recorded: readonly Member[] = o.members;
  // The group is ours once a recorded member is alive in it; then every member it has right now is ours too, including
  // children started after the last time the registry was written. They are recorded before SIGTERM so a child that
  // ignores it is still found (and SIGKILLed) after the leader has gone.
  const adopt = (rows: readonly ProcRow[]) => (recorded = mergeMembers(recorded, membersOf(rows, o.pgid)));
  if (o.immediate && trusted) {
    // Obsidian is unloading and may not live long enough for a `ps`: signal first, look afterwards.
    if (signalGroup(o.kill, o.pgid, "SIGTERM") === "gone") return "gone";
    adopt(await o.table.snapshot());
  } else {
    const rows = await o.table.snapshot();
    if (!trusted && !isOwned(rows, o.pgid, recorded)) return "not-ours";
    adopt(rows);
    if (signalGroup(o.kill, o.pgid, "SIGTERM") === "gone") return "gone";
  }

  const deadline = o.clock.now() + graceMs;
  while (o.clock.now() < deadline) {
    await o.clock.sleep(Math.min(pollMs, Math.max(1, deadline - o.clock.now())));
    if (!isOwned(await o.table.snapshot(), o.pgid, recorded)) return "terminated";
  }
  signalGroup(o.kill, o.pgid, "SIGKILL");
  return "killed";
}
