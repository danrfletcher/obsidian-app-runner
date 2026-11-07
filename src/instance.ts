import type { Clock } from "./clock";
import type { HttpGet } from "./loopback-http";
import { parseLsof, type LsofRunner } from "./port-discovery";
import { isOwned, membersOf, mergeMembers, stopGroup, type KillFn, type Member, type ProcessTable } from "./process-group";
import type { Project } from "./project";
import { waitForReady } from "./ready-wait";
import type { RegistryEntry, RegistryLike } from "./registry";
import type { RuntimeFs } from "./runtime-fs";
import { logPath } from "./runtime-paths";
import type { RuntimeSeams } from "./seams";
import { spawnApp, type SpawnedChild, type SpawnFn } from "./spawn";
import { startFailureNotice, type StartFailure } from "./start-notices";
import { isLoopbackUrl } from "./validation";

/** How much of the end of the log is read for a failure notice. */
const LOG_TAIL_BYTES = 64 * 1024;

export type InstanceState = "starting" | "running" | "stopping";

export type OpenOutcome =
  // The app is ready: open a tab on `url`.
  | { kind: "tab"; url: string }
  // The app is ready and Open-in-browser is on: the URL went to `openExternal`; no tab.
  | { kind: "browser"; url: string }
  // Another Open started the app and opens the one tab (E17, E20).
  | { kind: "joined" }
  | { kind: "failed" }
  | { kind: "cancelled" }
  // Refused before anything was spawned (E1).
  | { kind: "refused" }
  | { kind: "missing" };

export type StopResult = "nothing" | "stopped" | "cancelled" | "waited";

type StartResult = { kind: "ready"; url: string } | { kind: "failed" } | { kind: "cancelled" };

interface Instance {
  slug: string;
  project: Project;
  state: InstanceState;
  logFile: string;
  startedAt: number;
  child?: SpawnedChild;
  /** The group leader's pid, which is the process group id. 0 until the spawn. */
  pgid: number;
  members: Member[];
  port: number | null;
  url: string | null;
  abort: AbortController;
  cancelled: boolean;
  errored: boolean;
  spawnError?: string;
  ready: Promise<StartResult>;
  resolveReady: (r: StartResult) => void;
  /** Set once a stop has begun; resolves when the group is gone and the entry removed. */
  stopped: Promise<void> | null;
}

export interface InstanceDeps {
  getProject(slug: string): Project | undefined;
  /** `~/Library/Application Support/Obsidian App Runner/<vault key>/`. */
  runtimeDir: string;
  notify(message: string): void;
  /** Hand a loopback URL to the default browser. */
  openExternal(url: string): void;
  /** E3: ask which of several HTML ports to use. null when dismissed or cancelled. */
  pickPort(project: Project, ports: number[], signal: AbortSignal): Promise<number | null>;
  /** E3: remember a picked port as the project's URL override, through the settings registry. */
  rememberUrl(slug: string, url: string): Promise<void>;
  fs: RuntimeFs;
  spawn?: SpawnFn;
  shell?: string;
  shellFlags?: string;
  table: ProcessTable;
  lsof: LsofRunner;
  kill: KillFn;
  http: HttpGet;
  clock: Clock;
  registry: RegistryLike;
  /** Timings, overridable by tests. Defaults: 5 s grace, 60 s ready timeout. */
  graceMs?: number;
  readyTimeoutMs?: number;
}

/**
 * One Instance per Project, in the state machine starting, running, stopping (no entry means no instance).
 *
 * - Open with no instance starts one. Open while starting joins it; Open while running only asks for another tab;
 *   Open while stopping waits for the stop and then starts fresh (E17).
 * - Stop with no instance only says so. Stop while starting cancels the start; Stop while running stops; Stop while
 *   stopping waits for the stop in progress (E17).
 * - The instance is created synchronously in the first Open, before anything is awaited, so two Opens in one tick, or
 *   either side of an await, make one spawn (E20).
 * - A failed start stops the group, removes the registry entry and clears the instance, so the next Open is clean (G6).
 *
 * It is the `RuntimeSeams` the project manager uses to know whether a project is running and to clean up on delete.
 */
export class InstanceManager implements RuntimeSeams {
  private readonly instances = new Map<string, Instance>();

  constructor(private readonly deps: InstanceDeps) {}

  /** The state of the project's instance, or "none". */
  stateOf(slug: string): InstanceState | "none" {
    return this.instances.get(slug)?.state ?? "none";
  }

  isRunning(slug: string): boolean {
    return this.instances.has(slug);
  }

  /** The URL a tab should load: set once the app is running. */
  urlOf(slug: string): string | undefined {
    const inst = this.instances.get(slug);
    return inst?.state === "running" && inst.url ? inst.url : undefined;
  }

  // ---- Open -------------------------------------------------------------------------------------------------------

  async open(slug: string): Promise<OpenOutcome> {
    for (;;) {
      const project = this.deps.getProject(slug);
      if (!project) {
        this.deps.notify("This project no longer exists.");
        return { kind: "missing" };
      }
      const inst = this.instances.get(slug);
      if (!inst) return this.beginStart(project);
      switch (inst.state) {
        case "running":
          return this.arrive(slug, inst.url!);
        case "starting": {
          const result = await inst.ready;
          return result.kind === "ready" ? { kind: "joined" } : { kind: result.kind };
        }
        case "stopping":
          await inst.stopped;
          continue; // start fresh
      }
    }
  }

  /** A ready app: a tab, or the browser when Open-in-browser is on (read now, so the toggle applies at once). */
  private arrive(slug: string, url: string): OpenOutcome {
    if (this.deps.getProject(slug)?.openInBrowser) {
      if (isLoopbackUrl(url)) this.deps.openExternal(url);
      return { kind: "browser", url };
    }
    return { kind: "tab", url };
  }

  private beginStart(project: Project): Promise<OpenOutcome> {
    // E1: before anything is spawned or truncated.
    if (!this.deps.fs.isDirectory(project.folder)) {
      this.deps.notify(startFailureNotice(project.name, { kind: "folder-missing", folder: project.folder }, ""));
      return Promise.resolve({ kind: "refused" });
    }
    let resolveReady!: (r: StartResult) => void;
    const ready = new Promise<StartResult>((resolve) => (resolveReady = resolve));
    const inst: Instance = {
      slug: project.slug,
      project: { ...project },
      state: "starting",
      logFile: logPath(this.deps.runtimeDir, project.slug),
      startedAt: this.deps.clock.now(),
      pgid: 0,
      members: [],
      port: null,
      url: null,
      abort: new AbortController(),
      cancelled: false,
      errored: false,
      ready,
      resolveReady,
      stopped: null,
    };
    this.instances.set(project.slug, inst);
    this.deps.notify(`Starting ${project.name}`);
    void this.runStart(inst);
    return ready.then((r): OpenOutcome => (r.kind === "ready" ? this.arrive(project.slug, r.url) : { kind: r.kind }));
  }

  private async runStart(inst: Instance): Promise<void> {
    try {
      const { project } = inst;
      const child = spawnApp(
        { command: project.command, cwd: project.folder, logFile: inst.logFile, shell: this.deps.shell, shellFlags: this.deps.shellFlags },
        { spawn: this.deps.spawn, fs: this.deps.fs },
      );
      inst.child = child;
      child.on("error", (e) => {
        inst.errored = true;
        inst.spawnError = e.message;
      });
      child.on("exit", () => this.onChildExit(inst));
      if (child.pid === undefined) {
        // The error event follows on the next turn of the event loop.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await this.fail(inst, { kind: "spawn-failed", message: inst.spawnError ?? "the shell could not be started." });
        return;
      }
      inst.pgid = child.pid;

      const rows = await this.deps.table.snapshot();
      if (inst.cancelled) return;
      if (!rows.some((r) => r.pid === inst.pgid && r.pgid === inst.pgid)) {
        // Gone before the first look: the shell failed at once (E2).
        await this.fail(inst, { kind: "exited" });
        return;
      }
      inst.members = membersOf(rows, inst.pgid);

      // The entry exists from spawn. If it cannot be written the app is stopped: nothing untracked is left running.
      try {
        await this.deps.registry.set(this.entryOf(inst));
      } catch {
        if (!inst.cancelled) await this.fail(inst, { kind: "registry-failed" });
        return;
      }
      if (inst.cancelled) return;

      const override = project.urlOverride.trim();
      const result = await waitForReady({
        clock: this.deps.clock,
        httpGet: this.deps.http,
        members: () => this.refreshMembers(inst),
        listeners: async (pids) => parseLsof(await this.deps.lsof(pids)),
        urlOverride: override !== "" && isLoopbackUrl(override) ? override : undefined,
        pick: (ports) => this.deps.pickPort(project, ports, inst.abort.signal),
        signal: inst.abort.signal,
        timeoutMs: this.deps.readyTimeoutMs,
      });
      if (inst.state === "stopping") return; // Stop took over; it resolves the start

      if (result.kind === "ready") {
        inst.port = result.port;
        inst.url = result.url;
        inst.state = "running";
        // The port is recorded before the tab opens; a failed write leaves the earlier entry (pid and members) in place.
        await this.deps.registry.set(this.entryOf(inst)).catch(() => undefined);
        if (result.picked) void this.deps.rememberUrl(project.slug, result.url).catch(() => undefined);
        inst.resolveReady({ kind: "ready", url: result.url });
        return;
      }
      if (result.kind === "cancelled") return;
      await this.fail(inst, { kind: result.kind });
    } catch (e) {
      await this.fail(inst, { kind: "internal", message: e instanceof Error ? e.message : String(e) });
    }
  }

  private entryOf(inst: Instance): RegistryEntry {
    return { slug: inst.slug, pid: inst.pgid, pgid: inst.pgid, members: inst.members, port: inst.port, startedAt: inst.startedAt };
  }

  /**
   * The pids now in the app's group. The group counts as ours only while a member we recorded is alive in it; then
   * members we had not seen yet are recorded too (and written to the registry). Empty when the group is gone.
   */
  private async refreshMembers(inst: Instance): Promise<number[]> {
    const rows = await this.deps.table.snapshot();
    if (!isOwned(rows, inst.pgid, inst.members)) return [];
    const current = membersOf(rows, inst.pgid);
    const merged = mergeMembers(inst.members, current);
    if (merged.length !== inst.members.length) {
      inst.members = merged;
      if (inst.state !== "stopping" && this.instances.get(inst.slug) === inst) {
        void this.deps.registry.set(this.entryOf(inst)).catch(() => undefined);
      }
    }
    return current.map((m) => m.pid);
  }

  /** The leader exited. Record whoever is left in the group; a running app with nobody left is gone. */
  private onChildExit(inst: Instance): void {
    if (inst.pgid === 0) return;
    void this.refreshMembers(inst)
      .then(async (alive) => {
        if (inst.state !== "running" || alive.length > 0 || this.instances.get(inst.slug) !== inst) return;
        this.instances.delete(inst.slug);
        await this.deps.registry.remove(inst.slug).catch(() => undefined);
        this.deps.notify(`${inst.project.name} stopped on its own.`);
      })
      .catch(() => undefined);
  }

  /** A start that failed: the notice (with the log lines) first, then the group is stopped and the instance cleared. */
  private async fail(inst: Instance, failure: StartFailure): Promise<void> {
    if (inst.state === "stopping") return;
    inst.state = "stopping";
    inst.abort.abort();
    inst.stopped = (async () => {
      this.deps.notify(startFailureNotice(inst.project.name, failure, await this.deps.fs.readTail(inst.logFile, LOG_TAIL_BYTES)));
      await this.killAndClean(inst, false);
    })();
    await inst.stopped;
    inst.resolveReady({ kind: "failed" });
  }

  // ---- Stop -------------------------------------------------------------------------------------------------------

  async stop(slug: string): Promise<StopResult> {
    const inst = this.instances.get(slug);
    if (!inst) {
      this.deps.notify(`Nothing running for ${this.deps.getProject(slug)?.name ?? slug}.`);
      return "nothing";
    }
    if (inst.state === "stopping") {
      await inst.stopped;
      return "waited";
    }
    const cancelling = inst.state === "starting";
    this.beginStop(inst, cancelling, false);
    await inst.stopped;
    this.deps.notify(cancelling ? `Cancelled starting ${inst.project.name}.` : `Stopped ${inst.project.name}.`);
    return cancelling ? "cancelled" : "stopped";
  }

  private beginStop(inst: Instance, cancelling: boolean, immediate: boolean): void {
    inst.state = "stopping";
    inst.cancelled = inst.cancelled || cancelling;
    inst.abort.abort();
    inst.stopped = this.killAndClean(inst, immediate).then(() => {
      if (cancelling) inst.resolveReady({ kind: "cancelled" });
    });
  }

  /** Stop the group, then take the registry entry and the instance away. A group that could not be stopped keeps its entry. */
  private async killAndClean(inst: Instance, immediate: boolean): Promise<void> {
    let stopFailed = false;
    if (inst.pgid > 0) {
      try {
        await stopGroup({
          pgid: inst.pgid,
          members: inst.members,
          table: this.deps.table,
          kill: this.deps.kill,
          clock: this.deps.clock,
          leaderAlive: () => this.leaderAlive(inst),
          immediate,
          graceMs: this.deps.graceMs,
        });
      } catch (e) {
        stopFailed = true;
        this.deps.notify(`Could not stop ${inst.project.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!stopFailed) await this.deps.registry.remove(inst.slug).catch(() => undefined);
    if (this.instances.get(inst.slug) === inst) this.instances.delete(inst.slug);
  }

  private leaderAlive(inst: Instance): boolean {
    const c = inst.child;
    return !!c && c.pid !== undefined && !inst.errored && c.exitCode === null && c.signalCode === null;
  }

  /** Obsidian is unloading (until adoption lands, apps do not outlive it): SIGTERM every group now, SIGKILL after the grace. */
  stopAllNow(): void {
    for (const inst of [...this.instances.values()]) {
      if (inst.state !== "stopping") this.beginStop(inst, inst.state === "starting", true);
    }
  }

  // ---- Project delete ---------------------------------------------------------------------------------------------

  /** G3: stop the app if there is one, then remove its registry entry and log. */
  async removeRuntime(project: Project): Promise<void> {
    const inst = this.instances.get(project.slug);
    if (inst) {
      if (inst.state !== "stopping") this.beginStop(inst, inst.state === "starting", false);
      await inst.stopped;
    }
    await this.deps.registry.remove(project.slug).catch(() => undefined);
    await this.deps.fs.removeFile(logPath(this.deps.runtimeDir, project.slug)).catch(() => undefined);
  }
}
