import type { Clock } from "./clock";
import type { HttpGet } from "./loopback-http";
import { LivenessPoll, type LivenessVerdict } from "./liveness-poll";
import { choosePort, loopbackCandidates, parseLsof, type Answer, type LsofRunner } from "./port-discovery";
import { isOwned, membersOf, mergeMembers, stopGroup, type KillFn, type Member, type ProcessTable } from "./process-group";
import type { Project } from "./project";
import { probe, waitForReady } from "./ready-wait";
import type { RegistryEntry, RegistryStore } from "./registry";
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

/** Why an instance went away: a Stop (or cancelled start, or unload), the app exiting on its own, or a start that failed. */
export type EndCause = "requested" | "crashed" | "start-failed";

/**
 * What the instance manager tells subscribers. `changed` fires when an instance appears or its state, port or Held flag
 * changes. `ended` fires exactly once per instance, after it has left the table, with the reason.
 */
export type InstanceEvent = { type: "changed"; slug: string } | { type: "ended"; slug: string; cause: EndCause };

/** A read-only view of one instance, for the running list. */
export interface InstanceInfo {
  slug: string;
  name: string;
  state: InstanceState;
  port: number | null;
  url: string | null;
  startedAt: number;
  held: boolean;
  heldReason: string;
  /** G7, G10: found in the registry at launch ("Still running from last session"), not started in this session. */
  adopted: boolean;
}

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
  /** Why the instance will end, if it ends through the stop path. A Stop is the default; a failed start says so. */
  endCause: EndCause;
  /** Held instances are never auto-stopped (G14). Set by whoever holds it; this PR only reads it. */
  held: boolean;
  heldReason: string;
  /** G10: found in the registry at launch. It is not our child, so only the 5 s liveness poll can tell that it died. */
  adopted: boolean;
  /** G13: persisted in the registry so the browser poll can resume at relaunch. This PR only stores it. */
  browserSessionExpected: boolean;
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
  registry: RegistryStore;
  /** Timings, overridable by tests. Defaults: 5 s grace, 60 s ready timeout, 5 s liveness poll. */
  graceMs?: number;
  readyTimeoutMs?: number;
  livenessMs?: number;
}

/** How an app was reached after launch: its port and page, or null while it listens on nothing we can reach yet. */
export interface Rediscovery {
  port: number;
  url: string;
}

export interface StopOptions {
  /** Adoption stops several apps and tells the user once; it asks Stop not to say "Stopped X." for each. */
  silent?: boolean;
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
 * - An adopted instance (found in the registry at launch) is running from the start. It is not our child, so a 5 s
 *   liveness poll looks for a recorded member that is still alive; when there is none the app has died (E21).
 * - Nothing here stops an app because Obsidian is quitting or the plugin is unloading (G15): `dispose` only lets go.
 *
 * It is the `RuntimeSeams` the project manager uses to know whether a project is running and to clean up on delete.
 */
export class InstanceManager implements RuntimeSeams {
  private readonly instances = new Map<string, Instance>();
  private readonly listeners = new Set<(event: InstanceEvent) => void>();
  private readonly liveness: LivenessPoll;
  private disposed = false;

  constructor(private readonly deps: InstanceDeps) {
    this.liveness = new LivenessPoll({ clock: deps.clock, check: (slug) => this.checkAdopted(slug), intervalMs: deps.livenessMs });
  }

  /** Hear about instances appearing, changing and ending. Returns the unsubscribe. */
  subscribe(listener: (event: InstanceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Forget every subscriber. Instances are not touched. */
  clearListeners(): void {
    this.listeners.clear();
  }

  /**
   * Plugin unload or disable (G15). Apps keep running and the registry is left exactly as it is: the liveness poll is
   * cancelled, a start still waiting for its port stops waiting (its entry was written at spawn, so the next launch
   * adopts it), and no listener is called again. Nothing is signalled and nothing is written from here on.
   */
  dispose(): void {
    this.disposed = true;
    this.liveness.dispose();
    for (const inst of this.instances.values()) {
      inst.abort.abort();
      inst.resolveReady({ kind: "cancelled" });
    }
    this.listeners.clear();
  }

  private emit(event: InstanceEvent): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A subscriber's failure must not break the state machine or the other subscribers.
      }
    }
  }

  /** The state of the project's instance, or "none". */
  stateOf(slug: string): InstanceState | "none" {
    return this.instances.get(slug)?.state ?? "none";
  }

  isRunning(slug: string): boolean {
    return this.instances.has(slug);
  }

  /** G7: the instance was found in the registry at launch rather than started in this session. */
  isAdopted(slug: string): boolean {
    return this.instances.get(slug)?.adopted ?? false;
  }

  /** G14: a Held instance is never auto-stopped. */
  isHeld(slug: string): boolean {
    return this.instances.get(slug)?.held ?? false;
  }

  /** Mark an instance Held (with the reason shown in the running list) or release it. Does nothing when nothing runs. */
  setHeld(slug: string, held: boolean, reason = ""): void {
    const inst = this.instances.get(slug);
    if (!inst || (inst.held === held && inst.heldReason === (held ? reason : ""))) return;
    inst.held = held;
    inst.heldReason = held ? reason : "";
    this.emit({ type: "changed", slug });
  }

  /** G13: whether a browser session is expected for the app; saved in the registry so it survives a relaunch. */
  browserSessionExpected(slug: string): boolean {
    return this.instances.get(slug)?.browserSessionExpected ?? false;
  }

  /** Record that a browser session is (or is no longer) expected. A failed write leaves the earlier entry in place. */
  async setBrowserSessionExpected(slug: string, expected: boolean): Promise<void> {
    const inst = this.instances.get(slug);
    if (!inst || inst.browserSessionExpected === expected) return;
    inst.browserSessionExpected = expected;
    if (inst.pgid > 0 && inst.state !== "stopping") await this.deps.registry.set(this.entryOf(inst)).catch(() => undefined);
  }

  /** Every instance as the running list shows it, in the order they were created. */
  snapshots(): InstanceInfo[] {
    return [...this.instances.values()].map((i) => ({
      slug: i.slug,
      name: this.deps.getProject(i.slug)?.name ?? i.project.name,
      state: i.state,
      port: i.port,
      url: i.url,
      startedAt: i.startedAt,
      held: i.held,
      heldReason: i.heldReason,
      adopted: i.adopted,
    }));
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
        case "running": {
          if (inst.url === null) {
            // An adopted app whose port is not known yet: look once more before giving up.
            await this.rediscover(slug);
            if (inst.url === null) {
              this.deps.notify(`${project.name} is running but has not opened a web port yet. Try again in a moment.`);
              return { kind: "failed" };
            }
          }
          return this.arrive(slug, inst.url);
        }
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
      endCause: "requested",
      held: false,
      heldReason: "",
      adopted: false,
      browserSessionExpected: false,
    };
    this.instances.set(project.slug, inst);
    this.deps.notify(`Starting ${project.name}`);
    this.emit({ type: "changed", slug: project.slug });
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

      const rows = await this.deps.table.snapshotScoped({ pids: [inst.pgid], pgids: [inst.pgid] });
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
      } catch (e) {
        if (!inst.cancelled) await this.fail(inst, { kind: "registry-failed", message: e instanceof Error ? e.message : String(e) });
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
      if (this.disposed) return; // unloaded while waiting: the app keeps running and the next launch adopts it (G15)

      if (result.kind === "ready") {
        inst.port = result.port;
        inst.url = result.url;
        inst.state = "running";
        this.emit({ type: "changed", slug: inst.slug });
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
    return {
      slug: inst.slug,
      pid: inst.pgid,
      pgid: inst.pgid,
      members: inst.members,
      port: inst.port,
      startedAt: inst.startedAt,
      browserSessionExpected: inst.browserSessionExpected,
    };
  }

  /**
   * The pids now in the app's group. The group counts as ours only while a member we recorded is alive in it; then
   * members we had not seen yet are recorded too (and written to the registry). Empty when the group is gone.
   */
  private async refreshMembers(inst: Instance): Promise<number[]> {
    const rows = await this.deps.table.snapshotScoped({ pids: inst.members.map((m) => m.pid), pgids: [inst.pgid] });
    if (!isOwned(rows, inst.pgid, inst.members)) return [];
    const current = membersOf(rows, inst.pgid);
    const merged = mergeMembers(inst.members, current);
    if (merged.length !== inst.members.length) {
      inst.members = merged;
      if (inst.state !== "stopping" && !this.disposed && this.instances.get(inst.slug) === inst) {
        void this.deps.registry.set(this.entryOf(inst)).catch(() => undefined);
      }
    }
    return current.map((m) => m.pid);
  }

  /** The leader exited. Record whoever is left in the group; a running app with nobody left is gone. */
  private onChildExit(inst: Instance): void {
    if (inst.pgid === 0 || this.disposed) return;
    void this.refreshMembers(inst)
      .then(async (alive) => {
        if (inst.state !== "running" || alive.length > 0 || this.instances.get(inst.slug) !== inst) return;
        await this.markDied(inst);
      })
      .catch(() => undefined);
  }

  /** The app exited by itself: no Stop was requested (a Stop moves the state to stopping first). Nothing restarts it (F4). */
  private async markDied(inst: Instance): Promise<void> {
    inst.endCause = "crashed";
    this.instances.delete(inst.slug);
    this.liveness.unwatch(inst.slug);
    this.emit({ type: "ended", slug: inst.slug, cause: "crashed" });
    await this.deps.registry.remove(inst.slug).catch(() => undefined);
    this.deps.notify(`${inst.project.name} stopped on its own.`);
  }

  /** A start that failed: the notice (with the log lines) first, then the group is stopped and the instance cleared. */
  private async fail(inst: Instance, failure: StartFailure): Promise<void> {
    if (inst.state === "stopping") return;
    inst.state = "stopping";
    this.liveness.unwatch(inst.slug);
    inst.endCause = "start-failed";
    inst.abort.abort();
    this.emit({ type: "changed", slug: inst.slug });
    inst.stopped = (async () => {
      this.deps.notify(startFailureNotice(inst.project.name, failure, await this.deps.fs.readTail(inst.logFile, LOG_TAIL_BYTES)));
      await this.killAndClean(inst);
    })();
    await inst.stopped;
    inst.resolveReady({ kind: "failed" });
  }

  // ---- Stop -------------------------------------------------------------------------------------------------------

  async stop(slug: string, options: StopOptions = {}): Promise<StopResult> {
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
    this.beginStop(inst, cancelling);
    await inst.stopped;
    if (!options.silent) this.deps.notify(cancelling ? `Cancelled starting ${inst.project.name}.` : `Stopped ${inst.project.name}.`);
    return cancelling ? "cancelled" : "stopped";
  }

  private beginStop(inst: Instance, cancelling: boolean): void {
    inst.state = "stopping";
    this.liveness.unwatch(inst.slug);
    inst.cancelled = inst.cancelled || cancelling;
    inst.abort.abort();
    this.emit({ type: "changed", slug: inst.slug });
    inst.stopped = this.killAndClean(inst).then(() => {
      if (cancelling) inst.resolveReady({ kind: "cancelled" });
    });
  }

  /** Stop the group, then take the registry entry and the instance away. A group that could not be stopped keeps its entry. */
  private async killAndClean(inst: Instance): Promise<void> {
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
          graceMs: this.deps.graceMs,
        });
      } catch (e) {
        stopFailed = true;
        this.deps.notify(`Could not stop ${inst.project.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!stopFailed) await this.deps.registry.remove(inst.slug).catch(() => undefined);
    if (this.instances.get(inst.slug) === inst) {
      this.instances.delete(inst.slug);
      this.emit({ type: "ended", slug: inst.slug, cause: inst.endCause });
    }
  }

  private leaderAlive(inst: Instance): boolean {
    const c = inst.child;
    return !!c && c.pid !== undefined && !inst.errored && c.exitCode === null && c.signalCode === null;
  }

  // ---- Adoption (G10) ---------------------------------------------------------------------------------------------

  /**
   * Take over an app the registry says this plugin started in an earlier session. The caller has already checked that
   * a recorded member is alive (the stale-entry rule); `members` are the group's members as that look saw them. The
   * instance exists at once, so a second adoption of the same slug is refused (F10). Its port is found by
   * `rediscover`, and from now on a 5 s poll watches for its death (E21).
   */
  adopt(entry: RegistryEntry, project: Project, members: readonly Member[]): "adopted" | "refused" {
    if (this.disposed || this.instances.has(entry.slug)) return "refused";
    const inst: Instance = {
      slug: entry.slug,
      project: { ...project },
      state: "running",
      logFile: logPath(this.deps.runtimeDir, entry.slug),
      startedAt: entry.startedAt,
      pgid: entry.pgid,
      members: mergeMembers(entry.members, members),
      port: entry.port,
      url: null,
      abort: new AbortController(),
      cancelled: false,
      errored: false,
      ready: Promise.resolve({ kind: "cancelled" }),
      resolveReady: () => undefined,
      stopped: null,
      endCause: "requested",
      held: false,
      heldReason: "",
      adopted: true,
      browserSessionExpected: entry.browserSessionExpected,
    };
    this.instances.set(entry.slug, inst);
    this.liveness.watch(entry.slug);
    this.emit({ type: "changed", slug: entry.slug });
    return "adopted";
  }

  /** Write the instance's current entry to the registry (members, port, flag). A failed write leaves the earlier entry. */
  async persist(slug: string): Promise<void> {
    const inst = this.instances.get(slug);
    if (!inst || inst.pgid <= 0 || inst.state === "stopping" || this.disposed) return;
    await this.deps.registry.set(this.entryOf(inst)).catch(() => undefined);
  }

  /**
   * Find the port an adopted app listens on now, without asking anything of the registry first: the recorded group's
   * live members only (ps scoped to them, lsof scoped to their pids). The recorded port wins if it still answers;
   * otherwise a port serving HTML, the lowest one when there are several (no picker at launch), else the lowest
   * answering port. A project URL override must still be a port this group listens on. Returns what it found.
   */
  async rediscover(slug: string): Promise<Rediscovery | null> {
    const inst = this.instances.get(slug);
    if (!inst || inst.state !== "running" || this.disposed) return null;
    const rows = await this.deps.table.snapshotScoped({ pids: inst.members.map((m) => m.pid), pgids: [inst.pgid] });
    if (!isOwned(rows, inst.pgid, inst.members)) return null;
    const current = membersOf(rows, inst.pgid);
    inst.members = mergeMembers(inst.members, current);
    const listeners = parseLsof(await this.deps.lsof(current.map((m) => m.pid)));
    const override = inst.project.urlOverride.trim();
    const overridePort = override !== "" && isLoopbackUrl(override) ? Number(new URL(override).port || (/^https:/i.test(override) ? 443 : 80)) : null;
    const targets = loopbackCandidates(listeners)
      .filter((c) => overridePort === null || c.port === overridePort)
      .map((c) => ({ port: c.port, url: overridePort !== null ? override : `http://${c.host}:${c.port}/` }));
    const probed = await Promise.all(targets.map(async (t) => ({ t, r: await probe(t.url, { httpGet: this.deps.http, clock: this.deps.clock }) })));
    const answered = probed.filter((p) => p.r !== null);
    if (answered.length === 0 || this.disposed || this.instances.get(slug) !== inst || inst.state !== "running") return null;
    const answers: Answer[] = answered.map((p) => ({ port: p.t.port, html: p.r!.html }));
    let port: number;
    if (inst.port !== null && answers.some((a) => a.port === inst.port)) port = inst.port;
    else {
      const choice = choosePort(answers);
      port = choice.kind === "port" ? choice.port : choice.kind === "picker" ? choice.ports[0] : answers[0].port;
    }
    const url = answered.find((p) => p.t.port === port)!.t.url;
    const changed = inst.port !== port || inst.url !== url;
    inst.port = port;
    inst.url = url;
    if (changed) {
      this.emit({ type: "changed", slug });
      await this.deps.registry.set(this.entryOf(inst)).catch(() => undefined);
    }
    return { port, url };
  }

  /**
   * One tick of the liveness poll (E21). The look names only the recorded members and the recorded group. With none of
   * them alive (same pid and start time) the app is gone: the entry is dropped once and the tab shows App stopped.
   * Otherwise any new members of the group are recorded, in memory and in the registry.
   * While the port is still unknown (the app was adopted mid-start) each tick tries to find it.
   */
  private async checkAdopted(slug: string): Promise<LivenessVerdict> {
    const inst = this.instances.get(slug);
    if (this.disposed || !inst || !inst.adopted) return "gone";
    if (inst.state !== "running") return "alive";
    const rows = await this.deps.table.snapshotScoped({ pids: inst.members.map((m) => m.pid), pgids: [inst.pgid] });
    if (this.disposed || this.instances.get(slug) !== inst || inst.state !== "running") return "alive";
    if (!isOwned(rows, inst.pgid, inst.members)) {
      await this.markDied(inst);
      return "gone";
    }
    // Record members that joined the group since the last look, so a later relaunch still finds the app by one of them.
    const merged = mergeMembers(inst.members, membersOf(rows, inst.pgid));
    if (merged.length !== inst.members.length) {
      inst.members = merged;
      await this.deps.registry.set(this.entryOf(inst)).catch(() => undefined);
    }
    if (inst.url === null) await this.rediscover(slug).catch(() => undefined);
    return "alive";
  }

  // ---- Project delete ---------------------------------------------------------------------------------------------

  /** G3: stop the app if there is one, then remove its registry entry and log. */
  async removeRuntime(project: Project): Promise<void> {
    const inst = this.instances.get(project.slug);
    if (inst) {
      if (inst.state !== "stopping") this.beginStop(inst, inst.state === "starting");
      await inst.stopped;
    }
    await this.deps.registry.remove(project.slug).catch(() => undefined);
    await this.deps.fs.removeFile(logPath(this.deps.runtimeDir, project.slug)).catch(() => undefined);
  }
}
