import { execFile } from "node:child_process";
import type { Clock } from "./clock";
import { SYSTEM_CALL_TIMEOUT_MS } from "./port-discovery";

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

/** The highest pid macOS hands out. `ps -p` fails outright (and prints nothing) for a larger one, so none is ever asked about. */
export const MAX_PID = 99999;

/** What a scoped look at the process table may name: recorded pids and recorded process groups, nothing else (F14). */
export interface PsScope {
  pids: readonly number[];
  pgids: readonly number[];
}

/**
 * Where process snapshots come from: `ps` in the real plugin, canned text in tests. There is deliberately no way to list
 * every process (F14): each look names the recorded pids and groups it is about, and `ps` is run with `-p` and `-g`.
 */
export interface ProcessTable {
  /** Only the named pids and the members of the named groups. */
  snapshotScoped(scope: PsScope): Promise<ProcRow[]>;
}

/** The `ps` arguments for a scoped look: `-p <pids> -g <groups>`. Null when there is nothing to ask about. */
export function scopedPsArgs(scope: PsScope): string[] | null {
  const pids = [...new Set(scope.pids)].filter((p) => Number.isInteger(p) && p > 1 && p <= MAX_PID);
  const pgids = [...new Set(scope.pgids)].filter((p) => Number.isInteger(p) && p > 1 && p <= MAX_PID);
  if (pids.length === 0 && pgids.length === 0) return null;
  const args = ["-o", "pid=,pgid=,lstart="];
  if (pids.length > 0) args.push("-p", pids.join(","));
  if (pgids.length > 0) args.push("-g", pgids.join(","));
  return args;
}

// LC_ALL=C keeps the lstart text the same across calls whatever the user's locale.
const PS_ENV = () => ({ ...process.env, LC_ALL: "C" });

export const realProcessTable: ProcessTable = {
  snapshotScoped: (scope) =>
    new Promise((resolve, reject) => {
      const args = scopedPsArgs(scope);
      if (!args) return resolve([]);
      execFile("ps", args, { env: PS_ENV(), maxBuffer: 8 * 1024 * 1024, timeout: SYSTEM_CALL_TIMEOUT_MS }, (err, stdout) => {
        // ps exits 1 when none of the named processes exist: that is an empty answer, not a failure.
        const code = (err as { code?: unknown } | null)?.code;
        if (err && !(code === 1 && (stdout ?? "").trim() === "")) reject(err);
        else resolve(parsePs(stdout ?? ""));
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
  const look = () => o.table.snapshotScoped({ pids: recorded.map((m) => m.pid), pgids: [o.pgid] });
  const rows = await look();
  if (!trusted && !isOwned(rows, o.pgid, recorded)) return "not-ours";
  adopt(rows);
  if (signalGroup(o.kill, o.pgid, "SIGTERM") === "gone") return "gone";

  const deadline = o.clock.now() + graceMs;
  while (o.clock.now() < deadline) {
    await o.clock.sleep(Math.min(pollMs, Math.max(1, deadline - o.clock.now())));
    if (!isOwned(await look(), o.pgid, recorded)) return "terminated";
  }
  signalGroup(o.kill, o.pgid, "SIGKILL");
  return "killed";
}
