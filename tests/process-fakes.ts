import { EventEmitter } from "node:events";
import type { SpawnOptions } from "node:child_process";
import { FakeClock } from "./fake-clock";
import { InstanceManager, type InstanceDeps } from "../src/instance";
import type { HttpGet } from "../src/loopback-http";
import type { Signal, ProcRow, ProcessTable, PsScope } from "../src/process-group";
import type { Project } from "../src/project";
import type { RegistryEntry, RegistryReadResult, RegistryStore } from "../src/registry";
import type { RuntimeFs } from "../src/runtime-fs";
import type { SpawnedChild } from "../src/spawn";

export const RUNTIME = "/runtime/key";

export const project = (over: Partial<Project> = {}): Project => ({
  name: "Live Captions",
  slug: "live-captions",
  folder: "/work/live-captions",
  command: "npm run start",
  urlOverride: "",
  killOnClose: true,
  openInBrowser: false,
  ...over,
});

export class FakeChild extends EventEmitter implements SpawnedChild {
  exitCode: number | null = null;
  signalCode: string | null = null;
  constructor(public pid: number | undefined) {
    super();
  }
  unref(): void {}
  exit(code: number | null = 0, signal: string | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

interface FakeProc {
  pid: number;
  pgid: number;
  startTime: string;
  ignoresTerm: boolean;
}

/** A tiny process table plus the spawn, ps, lsof, kill and HTTP that look at it. */
export class FakeWorld {
  clock = new FakeClock();
  procs: FakeProc[] = [];
  children = new Map<number, FakeChild>();
  nextPid = 5000;
  spawns: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  /** Every signal sent: [pid (negative for a group), signal]. */
  signals: Array<[number, Signal]> = [];
  /** What the next spawned leader does: exit at once with a code, or ignore SIGTERM. */
  nextLeader: { exitsWith?: number; ignoresTerm?: boolean } = {};
  /** Ports each process listens on: pid -> [address, port] */
  listening = new Map<number, Array<[string, number]>>();
  /** HTTP answers by port. A port with no entry refuses; `hang` never answers. */
  answers = new Map<number, { status?: number; html?: boolean; hang?: boolean }>();
  probes: string[] = [];
  registry = new FakeRegistry();
  dirs = new Set<string>(["/work/live-captions", "/work/build-dashboard"]);
  logs = new Map<string, string>();
  truncations: string[] = [];
  notices: string[] = [];
  external: string[] = [];
  remembered: Array<[string, string]> = [];
  pickerCalls: number[][] = [];
  pickerAnswer: number | null = null;
  projects = new Map<string, Project>();
  killError: Error | null = null;

  constructor(...projects: Project[]) {
    for (const p of projects.length ? projects : [project()]) this.projects.set(p.slug, p);
  }

  startTimeFor(pid: number): string {
    return `Fri Nov  6 23:00:${String(pid % 60).padStart(2, "0")} 2026`;
  }

  addProc(pid: number, pgid: number, ignoresTerm = false): void {
    this.procs.push({ pid, pgid, startTime: this.startTimeFor(pid), ignoresTerm });
  }

  fs: RuntimeFs = {
    mkdirSync: () => undefined,
    openSync: (file) => {
      this.truncations.push(file);
      this.logs.set(file, "");
      return 99;
    },
    closeSync: () => undefined,
    isDirectory: (p) => this.dirs.has(p),
    exists: (p) => this.logs.has(p),
    readTail: async (file) => this.logs.get(file) ?? "",
    removeFile: async (file) => void this.logs.delete(file),
  };

  /** Every `ps` look, with the scope it was asked for (F14: there is no unscoped look). */
  psCalls: PsScope[] = [];
  /** Every lsof call: the pids it was scoped to. */
  lsofCalls: Array<readonly number[]> = [];

  private rows(): ProcRow[] {
    return this.procs.map<ProcRow>((p) => ({ pid: p.pid, pgid: p.pgid, startTime: p.startTime }));
  }

  table: ProcessTable = {
    snapshotScoped: async (scope) => {
      this.psCalls.push({ pids: [...scope.pids], pgids: [...scope.pgids] });
      const pids = new Set(scope.pids);
      const pgids = new Set(scope.pgids);
      return this.rows().filter((r) => pids.has(r.pid) || pgids.has(r.pgid));
    },
  };

  /** Remove processes, and tell the child object when its leader is among them. */
  private remove(pred: (p: FakeProc) => boolean): void {
    const gone = this.procs.filter(pred);
    this.procs = this.procs.filter((p) => !pred(p));
    for (const p of gone) {
      const child = this.children.get(p.pid);
      if (child && child.exitCode === null && child.signalCode === null) child.exit(null, "SIGTERM");
    }
  }

  kill = (pid: number, signal: Signal): void => {
    this.signals.push([pid, signal]);
    if (this.killError) throw this.killError;
    const pgid = -pid;
    if (!this.procs.some((p) => p.pgid === pgid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    if (signal === "SIGKILL") this.remove((p) => p.pgid === pgid);
    else this.remove((p) => p.pgid === pgid && !p.ignoresTerm);
  };

  http: HttpGet = (url, { signal }) => {
    this.probes.push(url);
    const port = Number(new URL(url).port);
    const a = this.answers.get(port);
    if (!a) return Promise.reject(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
    if (a.hang) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return Promise.resolve({
      status: a.status ?? 200,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? (a.html ? "text/html; charset=utf-8" : "application/json") : null) },
    });
  };

  lsof = async (pids: readonly number[]): Promise<string> => {
    this.lsofCalls.push([...pids]);
    const lines = ["COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME"];
    for (const pid of pids) {
      for (const [address, port] of this.listening.get(pid) ?? []) {
        lines.push(`node    ${pid} dan   12u  IPv4 0xabc      0t0  TCP ${address}:${port} (LISTEN)`);
      }
    }
    return lines.length > 1 ? lines.join("\n") : "";
  };

  spawn = (command: string, args: string[], options: SpawnOptions): SpawnedChild => {
    this.spawns.push({ command, args, options });
    const pid = this.nextPid++;
    const child = new FakeChild(pid);
    this.children.set(pid, child);
    const leader = this.nextLeader;
    this.nextLeader = {};
    if (leader.exitsWith !== undefined) {
      // Gone before the first ps.
      const code = leader.exitsWith;
      queueMicrotask(() => child.exit(code));
    } else {
      this.addProc(pid, pid, leader.ignoresTerm ?? false);
    }
    return child;
  };

  /** The app starts serving: a process listens on `port` and answers HTTP. */
  serve(port: number, opts: { html?: boolean; address?: string; pid?: number } = {}): void {
    const pid = opts.pid ?? this.leaderPid();
    this.listening.set(pid, [...(this.listening.get(pid) ?? []), [opts.address ?? "127.0.0.1", port]]);
    this.answers.set(port, { html: opts.html ?? true });
  }

  /** The pid of the most recently spawned leader. */
  leaderPid(): number {
    return this.nextPid - 1;
  }

  deps(over: Partial<InstanceDeps> = {}): InstanceDeps {
    return {
      getProject: (slug) => this.projects.get(slug),
      runtimeDir: RUNTIME,
      notify: (m) => void this.notices.push(m),
      openExternal: async (u) => void this.external.push(u),
      pickPort: async (_p, ports) => {
        this.pickerCalls.push(ports);
        return this.pickerAnswer;
      },
      rememberUrl: async (slug, url) => void this.remembered.push([slug, url]),
      fs: this.fs,
      spawn: this.spawn,
      table: this.table,
      lsof: this.lsof,
      kill: this.kill,
      http: this.http,
      clock: this.clock,
      registry: this.registry,
      ...over,
    };
  }

  manager(over: Partial<InstanceDeps> = {}): InstanceManager {
    return new InstanceManager(this.deps(over));
  }
}

export class FakeRegistry implements RegistryStore {
  entries = new Map<string, RegistryEntry>();
  /** What `read` reports as the file's problem, if a test wants to show one. */
  problem: RegistryReadResult["problem"];
  failReads = false;
  async read(): Promise<RegistryReadResult> {
    if (this.failReads) throw new Error("EACCES");
    return { version: 1, entries: Object.fromEntries([...this.entries].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])), problem: this.problem };
  }
  sets = 0;
  removes = 0;
  failSets = false;
  async set(entry: RegistryEntry): Promise<void> {
    if (this.failSets) throw new Error("disk full");
    this.sets++;
    this.entries.set(entry.slug, JSON.parse(JSON.stringify(entry)));
  }
  async remove(slug: string): Promise<void> {
    this.removes++;
    this.entries.delete(slug);
  }
}
