import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { realClock } from "../../src/clock";
import { InstanceManager, type InstanceEvent } from "../../src/instance";
import { KillTimer } from "../../src/kill-timer";
import { loopbackGet } from "../../src/loopback-http";
import type { LsofRunner } from "../../src/port-discovery";
import { realKill, realProcessTable } from "../../src/process-group";
import { Registry } from "../../src/registry";
import { realRuntimeFs } from "../../src/runtime-fs";
import { logPath, registryPath } from "../../src/runtime-paths";
import { SessionCounter, type SessionLeaf } from "../../src/session-counter";
import { readLogTail } from "../../src/stopped-panel";
import { VIEW_TYPE_APP } from "../../src/webview-view";
import { project } from "../process-fakes";

/**
 * The fixture app (tests/fixtures/fake-app.mjs) as a real child in its own process group, with the real ps, signals,
 * loopback HTTP probe and registry file, and the real instance manager, session counter and kill timer. Only the
 * Obsidian workspace is a list of leaves, and lsof is read back from the port the fixture prints (as in start-stop.test.ts).
 * Everything listens on an OS-chosen port or on a free port the test picked, never a product port. The grace is
 * shortened to 400 ms so the real clock can be used.
 */

const SLUG = "live-captions";
const GRACE = 400;
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/fake-app.mjs");
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "app-runner-lifecycle-"));
const groups: number[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Does anything answer on the port? */
async function answers(port: number): Promise<boolean> {
  try {
    await loopbackGet(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

/** A port nothing is listening on right now (bound and released). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function fakeLsofFor(logFile: string): LsofRunner {
  return async (pids) => {
    let text = "";
    try {
      text = fs.readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
    const lines = [...text.matchAll(/^listening (\d+)$/gm)].map((m) => `node ${pids[0]} dan 12u IPv4 0x1 0t0 TCP 127.0.0.1:${m[1]} (LISTEN)`);
    return lines.length ? ["COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME", ...lines].join("\n") : "";
  };
}

function rig(flags = "", graceMs = GRACE) {
  const runtime = path.join(tmp, `rt-${Math.random().toString(36).slice(2)}`);
  const folder = path.join(tmp, "work");
  fs.mkdirSync(folder, { recursive: true });
  const p = project({ folder, command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} ${flags}` });
  const registry = new Registry(registryPath(runtime));
  const notices: string[] = [];
  const m = new InstanceManager({
    getProject: () => p,
    runtimeDir: runtime,
    notify: (n) => void notices.push(n),
    openExternal: () => {},
    pickPort: async (_p, ports) => ports[0],
    rememberUrl: async () => {},
    fs: realRuntimeFs,
    shell: "/bin/sh",
    shellFlags: "-c",
    table: realProcessTable,
    lsof: fakeLsofFor(logPath(runtime, SLUG)),
    kill: realKill,
    http: loopbackGet,
    clock: realClock,
    registry,
    graceMs: 1500,
    readyTimeoutMs: 15_000,
  });

  // The Obsidian workspace, reduced to leaves; the session counter and kill timer are the real ones.
  const leaves: SessionLeaf[] = [];
  const sessions = new SessionCounter(() => leaves);
  const timer = new KillTimer({
    clock: realClock,
    graceMs,
    sessionCount: (s) => sessions.count(s),
    stateOf: (s) => m.stateOf(s),
    isHeld: (s) => m.isHeld(s),
    killOnClose: () => p.killOnClose,
    stop: (s) => m.stop(s),
    onInstanceChange: (l) => m.subscribe((e) => l(e.slug)),
    onSessionChange: (l) => sessions.subscribe(l),
  });
  const events: InstanceEvent[] = [];
  m.subscribe((e) => events.push(e));
  cleanups.push(async () => {
    timer.dispose();
    await m.stop(SLUG).catch(() => undefined);
  });

  const r = {
    m,
    p,
    runtime,
    registry,
    notices,
    sessions,
    timer,
    events,
    leaves,
    /** Open: start (or join) and open one tab on the URL. */
    async open() {
      const outcome = await m.open(SLUG);
      if (outcome.kind === "tab") r.tab();
      return outcome;
    },
    tab(): SessionLeaf {
      const l: SessionLeaf = { getViewState: () => ({ type: VIEW_TYPE_APP, state: { slug: SLUG } }) };
      leaves.push(l);
      sessions.refresh();
      return l;
    },
    close(l: SessionLeaf) {
      leaves.splice(leaves.indexOf(l), 1);
      sessions.refresh();
    },
    async pgid(): Promise<number> {
      const entry = (await registry.read()).entries[SLUG];
      groups.push(entry.pgid);
      return entry.pgid;
    },
    port: () => m.snapshots()[0]?.port ?? null,
  };
  return r;
}

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL"); // only groups this test started
    } catch {
      /* gone */
    }
  }
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("open, duplicate, close, grace, stop (GP4, GP5)", () => {
  it("two tabs share one process; closing one keeps the app; closing the last stops it after the grace", async () => {
    const r = rig();
    const outcome = await r.open();
    expect(outcome.kind).toBe("tab");
    const pgid = await r.pgid();
    const port = r.port()!;
    expect(await answers(port)).toBe(true);
    expect(r.sessions.count(SLUG)).toBe(1);

    const duplicate = r.tab(); // duplicating the tab: no second spawn
    expect(r.sessions.count(SLUG)).toBe(2);
    expect(r.m.snapshots()).toHaveLength(1);
    expect(r.m.snapshots()[0]).toMatchObject({ slug: SLUG, state: "running", port });
    expect(Object.keys((await r.registry.read()).entries)).toEqual([SLUG]);

    r.close(duplicate); // one of two: no timer
    expect(r.timer.isPending(SLUG)).toBe(false);
    await sleep(GRACE * 2);
    expect(r.m.stateOf(SLUG)).toBe("running");
    expect(await answers(port)).toBe(true);

    r.close(r.leaves[0]); // the last one
    expect(r.timer.isPending(SLUG)).toBe(true);
    await sleep(GRACE / 2);
    expect(r.m.stateOf(SLUG)).toBe("running"); // inside the grace
    await until("the app to stop", () => r.m.stateOf(SLUG) === "none");
    await until("the process group to be gone", () => !alive(pgid));
    expect(await answers(port)).toBe(false);
    expect(r.m.snapshots()).toEqual([]);
    expect((await r.registry.read()).entries).toEqual({});
    expect(r.events.at(-1)).toEqual({ type: "ended", slug: SLUG, cause: "requested" });
  }, 30_000);

  it("a tab dragged out and back in (detach, attach) within the grace leaves the app running", async () => {
    const r = rig();
    await r.open();
    const pgid = await r.pgid();
    const dragged = r.leaves[0];
    r.close(dragged);
    await sleep(GRACE / 2);
    r.leaves.push(dragged);
    r.sessions.refresh();
    await sleep(GRACE * 2);
    expect(r.m.stateOf(SLUG)).toBe("running");
    expect(alive(pgid)).toBe(true);
  }, 30_000);

  it("with Kill off the app sits at zero tabs and is never auto-stopped", async () => {
    const r = rig();
    r.p.killOnClose = false;
    await r.open();
    r.close(r.leaves[0]);
    await sleep(GRACE * 3);
    expect(r.m.stateOf(SLUG)).toBe("running");
    expect(r.timer.pendingCount).toBe(0);
  }, 30_000);

  it("a stubborn app that ignores SIGTERM is SIGKILLed after the stop's own grace, and the auto-stop still ends cleanly", async () => {
    const r = rig("--ignore-sigterm");
    await r.open();
    const pgid = await r.pgid();
    r.close(r.leaves[0]);
    await until("the app to stop", () => r.m.stateOf(SLUG) === "none", 15_000);
    await until("the group to be gone", () => !alive(pgid));
  }, 30_000);
});

describe("crash (G9)", () => {
  it("an app that exits on its own is reported once, dropped from the list and its registry entry, and never restarted", async () => {
    const r = rig("--noise 12 --crash-after 600");
    await r.open();
    const pgid = await r.pgid();
    expect(r.m.stateOf(SLUG)).toBe("running");
    await until("the crash to be noticed", () => r.m.stateOf(SLUG) === "none");
    await until("the entry to be removed", async () => Object.keys((await r.registry.read()).entries).length === 0);
    expect(r.events.filter((e) => e.type === "ended")).toEqual([{ type: "ended", slug: SLUG, cause: "crashed" }]);
    expect(r.m.snapshots()).toEqual([]);
    expect(r.notices.at(-1)).toBe("Live Captions stopped on its own.");
    expect(alive(pgid)).toBe(false);

    // The panel's log: the last 10 lines of what the app wrote.
    const tail = await readLogTail(realRuntimeFs, logPath(r.runtime, SLUG));
    expect(tail).toHaveLength(10);
    expect(tail.at(-1)).toBe("fake-app: crashing on purpose");

    // F4: nothing starts it again.
    const started = r.notices.filter((n) => n === "Starting Live Captions").length;
    await sleep(1500);
    expect(r.m.stateOf(SLUG)).toBe("none");
    expect(r.notices.filter((n) => n === "Starting Live Captions")).toHaveLength(started);
  }, 30_000);

  it("a crash while the grace timer is pending cancels the timer, and the app is not stopped a second time", async () => {
    // A long grace, so the crash (1.5 s after listening) lands well inside it however long the ready wait took.
    const r = rig("--crash-after 1500", 6000);
    await r.open();
    r.close(r.leaves[0]);
    expect(r.timer.isPending(SLUG)).toBe(true);
    await until("the crash to be noticed", () => r.m.stateOf(SLUG) === "none");
    expect(r.timer.isPending(SLUG)).toBe(false);
    expect(r.events.filter((e) => e.type === "ended").map((e) => e.type === "ended" && e.cause)).toEqual(["crashed"]);
    expect(r.notices).not.toContain("Stopped Live Captions.");
  }, 30_000);
});

describe("Stop while starting (G8)", () => {
  it("cancels the start: no tab opens, the process group is gone and nothing is left waiting for a port", async () => {
    const r = rig("--listen-after 5000");
    const opening = r.open();
    await until("the app to be spawned", async () => Object.keys((await r.registry.read()).entries).length === 1);
    const pgid = await r.pgid();
    expect(r.m.stateOf(SLUG)).toBe("starting");

    expect(await r.m.stop(SLUG)).toBe("cancelled");
    expect((await opening).kind).toBe("cancelled");
    expect(r.leaves).toEqual([]);
    expect(r.m.stateOf(SLUG)).toBe("none");
    await until("the group to be gone", () => !alive(pgid));
    expect((await r.registry.read()).entries).toEqual({});
    expect(r.timer.pendingCount).toBe(0);
    expect(r.events.filter((e) => e.type === "ended")).toHaveLength(1);
  }, 30_000);

  it("Stop when nothing runs says so and touches nothing", async () => {
    const r = rig();
    expect(await r.m.stop(SLUG)).toBe("nothing");
    expect(r.notices).toEqual(["Nothing running for Live Captions."]);
    expect(r.events).toEqual([]);
  }, 30_000);
});

describe("a start that fails never arms the timer", () => {
  it("a command that exits at once opens no tab, and the grace timer is never started", async () => {
    const r = rig();
    r.p.command = "exit 3";
    let armed = 0;
    r.m.subscribe(() => (armed = Math.max(armed, r.timer.pendingCount)));
    expect((await r.open()).kind).toBe("failed");
    expect(r.leaves).toEqual([]);
    await sleep(GRACE * 2);
    expect(armed).toBe(0);
    expect(r.events.filter((e) => e.type === "ended")).toEqual([{ type: "ended", slug: SLUG, cause: "start-failed" }]);
  }, 30_000);
});

describe("a port change after restart (E19)", () => {
  it("the instance and the list show the new port; the old one is closed", async () => {
    const [first, second] = [await freePort(), await freePort()];
    const r = rig(`--port ${first}`);
    await r.open();
    await r.pgid();
    expect(r.port()).toBe(first);
    expect(r.m.urlOf(SLUG)).toBe(`http://127.0.0.1:${first}/`);

    expect(await r.m.stop(SLUG)).toBe("stopped");
    await until("the old port to close", async () => !(await answers(first)));

    r.p.command = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} --port ${second}`;
    await r.open();
    await r.pgid();
    expect(r.port()).toBe(second);
    expect(r.m.urlOf(SLUG)).toBe(`http://127.0.0.1:${second}/`); // what a Reload reads
    expect(r.m.snapshots().map((s) => s.port)).toEqual([second]);
    expect(await answers(first)).toBe(false);
    expect(await answers(second)).toBe(true);
  }, 30_000);
});
