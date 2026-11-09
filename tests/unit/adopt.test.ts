import { beforeEach, describe, expect, it } from "vitest";
import { Adoption, adoptionNotice, ADOPT_GRACE_MS, type AdoptionDeps } from "../../src/adopt";
import { KillTimer } from "../../src/kill-timer";
import { STILL_RUNNING_TEXT } from "../../src/running-list-model";
import type { RegistryEntry } from "../../src/registry";
import { logPath } from "../../src/runtime-paths";
import { Notice, Platform } from "../obsidian-mock";
import { launch } from "../plugin-harness";
import { FakeWorld, project } from "../process-fakes";

const GRACE = ADOPT_GRACE_MS;

type Which = "build-dashboard" | "live-captions";
const SLUGS: Record<Which, { name: string; leader: number; port: number }> = {
  "build-dashboard": { name: "Build Dashboard", leader: 4100, port: 4317 },
  "live-captions": { name: "Live Captions", leader: 4200, port: 8957 },
};

interface Spec {
  slug?: Which;
  killOn?: boolean;
  sessions?: number;
  browserExpected?: boolean;
  /** "live": group as recorded; "reused": same pids, other start times (E6); "gone": nothing left (E7). */
  proc?: "live" | "reused" | "gone" | "dead-leader";
}

/** A world where the last session left apps recorded in the registry, and the plugin is starting again. */
function relaunch(specs: Spec[] = [{}], over: Partial<AdoptionDeps> = {}) {
  const w = new FakeWorld(
    project({ slug: "build-dashboard", name: "Build Dashboard", folder: "/work/build-dashboard", killOnClose: true }),
    project({ slug: "live-captions", name: "Live Captions", folder: "/work/live-captions", killOnClose: true }),
  );
  const sessions = new Map<string, number>();
  const killOn = new Map<string, boolean>();
  const expected: string[] = [];
  const entries: RegistryEntry[] = [];
  for (const [i, spec] of specs.entries()) {
    const slug = spec.slug ?? (i === 0 ? "build-dashboard" : "live-captions");
    const { leader, port } = SLUGS[slug];
    const member = leader + 1;
    const startTime = (pid: number) => w.startTimeFor(pid);
    entries.push({
      slug,
      pid: leader,
      pgid: leader,
      members: [
        { pid: leader, startTime: startTime(leader) },
        { pid: member, startTime: startTime(member) },
      ],
      port,
      startedAt: 1_000 + i,
      browserSessionExpected: spec.browserExpected ?? false,
    });
    const proc = spec.proc ?? "live";
    if (proc === "live") {
      w.addProc(leader, leader);
      w.addProc(member, leader);
    } else if (proc === "dead-leader") {
      w.addProc(member, leader);
    } else if (proc === "reused") {
      w.procs.push({ pid: leader, pgid: leader, startTime: "Sat Nov  7 08:15:44 2026", ignoresTerm: false });
      w.procs.push({ pid: member, pgid: leader, startTime: "Sat Nov  7 08:15:45 2026", ignoresTerm: false });
    }
    if (proc === "live" || proc === "dead-leader") {
      w.listening.set(member, [["127.0.0.1", port]]);
      w.answers.set(port, { html: true });
    }
    sessions.set(slug, spec.sessions ?? 0);
    killOn.set(slug, spec.killOn ?? true);
    if (spec.browserExpected) expected.push(slug);
  }
  for (const e of entries) w.registry.entries.set(e.slug, e);
  for (const [slug, on] of killOn) w.projects.set(slug, { ...w.projects.get(slug)!, killOnClose: on });
  const registryBefore = JSON.stringify([...w.registry.entries]);

  const manager = w.manager();
  const polled: string[][] = [];
  const adoption = new Adoption({
    registry: w.registry,
    table: w.table,
    target: manager,
    getProject: (s) => w.projects.get(s),
    sessionCount: (s) => sessions.get(s) ?? 0,
    killOnClose: (s) => w.projects.get(s)?.killOnClose,
    clock: w.clock,
    notify: (m) => void w.notices.push(m),
    resumeBrowserPoll: async (slugs) => void polled.push(slugs),
    ...over,
  });
  return { w, manager, adoption, sessions, polled, registryBefore };
}

describe("adoption decision table (G10, GP8)", () => {
  // Kill on/off x sessions x browser-expected x process state. Written out by hand.
  const rows: Array<{
    label: string;
    spec: Spec;
    adopted: boolean;
    stoppedAfterGrace: boolean;
    notice: string | null;
    polled: boolean;
  }> = [
    { label: "live, Kill on, no tab", spec: { killOn: true, sessions: 0 }, adopted: true, stoppedAfterGrace: true, notice: "Build Dashboard was left running with no tab open, so it was stopped.", polled: false },
    { label: "live, Kill on, one restored tab", spec: { killOn: true, sessions: 1 }, adopted: true, stoppedAfterGrace: false, notice: null, polled: false },
    { label: "live, Kill off, no tab (GP8)", spec: { killOn: false, sessions: 0 }, adopted: true, stoppedAfterGrace: false, notice: "Build Dashboard is still running from the last session.", polled: false },
    { label: "live, Kill off, one restored tab", spec: { killOn: false, sessions: 1 }, adopted: true, stoppedAfterGrace: false, notice: null, polled: false },
    { label: "live, Kill on, no tab, browser session expected", spec: { killOn: true, sessions: 0, browserExpected: true }, adopted: true, stoppedAfterGrace: true, notice: "Build Dashboard was left running with no tab open, so it was stopped.", polled: true },
    { label: "live, Kill on, a tab, browser session expected", spec: { killOn: true, sessions: 1, browserExpected: true }, adopted: true, stoppedAfterGrace: false, notice: null, polled: true },
    { label: "live, Kill off, no tab, browser session expected", spec: { killOn: false, sessions: 0, browserExpected: true }, adopted: true, stoppedAfterGrace: false, notice: "Build Dashboard is still running from the last session.", polled: true },
    { label: "pid reused, Kill on, no tab (E6)", spec: { proc: "reused", killOn: true, sessions: 0 }, adopted: false, stoppedAfterGrace: false, notice: null, polled: false },
    { label: "pid reused, Kill off (E6)", spec: { proc: "reused", killOn: false, sessions: 0 }, adopted: false, stoppedAfterGrace: false, notice: null, polled: false },
    { label: "nothing left, Kill on, browser session expected (E7)", spec: { proc: "gone", killOn: true, sessions: 0, browserExpected: true }, adopted: false, stoppedAfterGrace: false, notice: null, polled: false },
    { label: "dead leader, live recorded member, Kill on, no tab", spec: { proc: "dead-leader", killOn: true, sessions: 0 }, adopted: true, stoppedAfterGrace: true, notice: "Build Dashboard was left running with no tab open, so it was stopped.", polled: false },
    { label: "dead leader, live recorded member, Kill off", spec: { proc: "dead-leader", killOn: false, sessions: 0 }, adopted: true, stoppedAfterGrace: false, notice: "Build Dashboard is still running from the last session.", polled: false },
  ];

  it.each(rows)("$label", async ({ spec, adopted, stoppedAfterGrace, notice, polled }) => {
    const { w, manager, adoption, polled: polls } = relaunch([spec]);
    const report = await adoption.adoptAll();
    expect(report.adopted).toEqual(adopted ? ["build-dashboard"] : []);
    expect(report.dropped).toEqual(adopted ? [] : ["build-dashboard"]);
    expect(manager.isRunning("build-dashboard")).toBe(adopted);
    expect(w.notices).toEqual([]); // nothing is said before layout ready
    expect(w.signals).toEqual([]);

    const decided = adoption.layoutReady();
    await w.clock.advance(GRACE - 1);
    expect(w.signals).toEqual([]); // not before layout ready + 15 s
    await w.clock.run(decided);

    expect(polls.length).toBe(polled ? 1 : 0);
    expect(w.signals.length > 0).toBe(stoppedAfterGrace);
    if (stoppedAfterGrace) {
      const groups = new Set(w.signals.map(([pid]) => pid));
      expect([...groups]).toEqual([-4100]); // the recorded group, nothing else
      expect(manager.isRunning("build-dashboard")).toBe(false);
      expect(w.registry.entries.has("build-dashboard")).toBe(false);
    } else if (adopted) {
      expect(manager.stateOf("build-dashboard")).toBe("running");
      expect(w.registry.entries.has("build-dashboard")).toBe(true);
    }
    expect(w.notices).toEqual(notice === null ? [] : [notice]);
    expect(adoption.pendingCount).toBe(0);
  });
});

describe("stale entries are dropped and never signalled (E6, E7)", () => {
  it("E6: a reused pid is dropped from the registry and receives no kill call at all", async () => {
    const { w, adoption } = relaunch([{ proc: "reused" }]);
    const report = await adoption.adoptAll();
    await adoption.layoutReady();
    await w.clock.advance(60_000);
    expect(report.dropped).toEqual(["build-dashboard"]);
    expect(w.registry.entries.size).toBe(0);
    expect(w.signals).toEqual([]);
    expect(w.notices).toEqual([]);
  });

  it("E7: after a reboot every entry is stale: all are dropped, no signal is sent, no notice is shown", async () => {
    const { w, manager, adoption } = relaunch([{ proc: "gone" }, { proc: "gone" }]);
    const report = await adoption.adoptAll();
    await adoption.layoutReady();
    await w.clock.advance(60_000);
    expect(report.dropped.sort()).toEqual(["build-dashboard", "live-captions"]);
    expect(report.adopted).toEqual([]);
    expect(w.registry.entries.size).toBe(0);
    expect(manager.snapshots()).toEqual([]);
    expect(w.signals).toEqual([]);
    expect(w.notices).toEqual([]);
  });

  it("a stale entry among live ones is dropped while the live ones are adopted", async () => {
    const { w, manager, adoption } = relaunch([{ proc: "live", killOn: false }, { proc: "reused" }]);
    const report = await adoption.adoptAll();
    expect(report).toEqual({ adopted: ["build-dashboard"], dropped: ["live-captions"], refused: [] });
    expect([...w.registry.entries.keys()]).toEqual(["build-dashboard"]);
    expect(manager.snapshots().map((s) => s.slug)).toEqual(["build-dashboard"]);
  });
});

describe("adopted instances (G7, G10, E5)", () => {
  it("an adopted app is running at once, marked adopted, with its port rediscovered and no answering port needed to adopt it (E5)", async () => {
    // The app moved to another port while Obsidian was closed: the recorded one no longer answers.
    const { w, manager, adoption } = relaunch([{ killOn: false }]);
    w.answers.delete(4317);
    w.listening.set(4101, [["127.0.0.1", 4999]]);
    w.answers.set(4999, { html: true });
    await adoption.adoptAll();
    const [row] = manager.snapshots();
    expect(row).toMatchObject({ slug: "build-dashboard", state: "running", port: 4999, url: "http://127.0.0.1:4999/", adopted: true });
    expect(w.registry.entries.get("build-dashboard")?.port).toBe(4999); // written back
  });

  it("an app that was adopted while still starting (no port recorded) gets its port at launch (E5)", async () => {
    const { w, manager, adoption } = relaunch([{}]);
    w.registry.entries.get("build-dashboard")!.port = null;
    await adoption.adoptAll();
    expect(manager.snapshots()[0]).toMatchObject({ state: "running", port: 4317, adopted: true });
  });

  it("an adopted app whose port cannot be reached yet is still adopted and stoppable; its url is unknown", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: false }]);
    w.answers.clear();
    w.listening.clear();
    await adoption.adoptAll();
    expect(manager.snapshots()[0]).toMatchObject({ state: "running", port: 4317, url: null, adopted: true });
    expect(manager.urlOf("build-dashboard")).toBeUndefined();
    await w.clock.run(manager.stop("build-dashboard"));
    expect(w.signals[0]).toEqual([-4100, "SIGTERM"]);
    expect(manager.isRunning("build-dashboard")).toBe(false);
  });

  it("Stop on an adopted app ends the whole recorded group and drops the entry (GP8)", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: false }]);
    await adoption.adoptAll();
    await adoption.layoutReady();
    expect(await w.clock.run(manager.stop("build-dashboard"))).toBe("stopped");
    expect(w.procs).toEqual([]);
    expect(w.registry.entries.size).toBe(0);
    expect(new Set(w.signals.map(([pid]) => pid))).toEqual(new Set([-4100]));
  });

  it("a dead leader with a live recorded member is adopted and Stop kills what is left", async () => {
    const { w, manager, adoption } = relaunch([{ proc: "dead-leader", killOn: false }]);
    await adoption.adoptAll();
    expect(manager.isRunning("build-dashboard")).toBe(true);
    await w.clock.run(manager.stop("build-dashboard"));
    expect(w.procs).toEqual([]);
    expect(w.signals[0]).toEqual([-4100, "SIGTERM"]);
  });

  it("a project that was deleted from settings while its app ran is still adopted, under its slug, and never auto-stopped", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: true }]);
    w.projects.delete("build-dashboard");
    await adoption.adoptAll();
    await adoption.layoutReady();
    await w.clock.advance(60_000);
    expect(manager.snapshots()[0]).toMatchObject({ slug: "build-dashboard", name: "build-dashboard", adopted: true });
    expect(w.signals).toEqual([]);
  });

  it("a second adoption of the same slug is refused (F10)", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: false }]);
    await adoption.adoptAll();
    const again = await adoption.adoptAll();
    expect(again).toEqual({ adopted: [], dropped: [], refused: ["build-dashboard"] });
    expect(manager.snapshots()).toHaveLength(1);
    expect(w.signals).toEqual([]);
  });

  it("an instance started in this session is not replaced by adoption", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: false }]);
    expect(manager.adopt(w.registry.entries.get("build-dashboard")!, w.projects.get("build-dashboard")!, [])).toBe("adopted");
    expect(manager.adopt(w.registry.entries.get("build-dashboard")!, w.projects.get("build-dashboard")!, [])).toBe("refused");
    const report = await adoption.adoptAll();
    expect(report.refused).toEqual(["build-dashboard"]);
  });
});

describe("one aggregated notice", () => {
  it("names what was stopped and what is still running in a single notice", async () => {
    const { w, adoption } = relaunch([
      { slug: "build-dashboard", killOn: true, sessions: 0 },
      { slug: "live-captions", killOn: false, sessions: 0 },
    ]);
    await adoption.adoptAll();
    await w.clock.run(adoption.layoutReady());
    expect(w.notices).toEqual(["Build Dashboard was left running with no tab open, so it was stopped. Live Captions is still running from the last session."]);
  });

  it("joins several names", () => {
    expect(adoptionNotice(["A", "B", "C"], ["D", "E"])).toBe("A, B and C were left running with no tab open, so they were stopped. D and E are still running from the last session.");
    expect(adoptionNotice([], ["D"])).toBe("D is still running from the last session.");
    expect(adoptionNotice([], [])).toBeNull();
  });

  it("says nothing at all when every adopted app has a restored tab", async () => {
    const { w, adoption } = relaunch([{ sessions: 1 }, { sessions: 2, killOn: false }]);
    await adoption.adoptAll();
    await w.clock.run(adoption.layoutReady());
    expect(w.notices).toEqual([]);
  });
});

describe("the stop decision waits for layout ready + 15 s (G10)", () => {
  it("nothing is stopped by adoptAll alone, however long it takes", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: true, sessions: 0 }]);
    await adoption.adoptAll();
    await w.clock.advance(10 * 60_000);
    expect(manager.isRunning("build-dashboard")).toBe(true);
    expect(w.signals).toEqual([]);
  });

  it("a tab that appears during the 15 s keeps the app", async () => {
    const { w, manager, adoption, sessions } = relaunch([{ killOn: true, sessions: 0 }]);
    await adoption.adoptAll();
    const decided = adoption.layoutReady();
    await w.clock.advance(GRACE / 2);
    sessions.set("build-dashboard", 1);
    await w.clock.run(decided);
    expect(manager.isRunning("build-dashboard")).toBe(true);
    expect(w.signals).toEqual([]);
    expect(w.notices).toEqual([]);
  });

  it("Kill switched off during the 15 s keeps the app, and the notice says it is still running", async () => {
    const { w, adoption } = relaunch([{ killOn: true, sessions: 0 }]);
    await adoption.adoptAll();
    const decided = adoption.layoutReady();
    await w.clock.advance(GRACE / 2);
    w.projects.set("build-dashboard", { ...w.projects.get("build-dashboard")!, killOnClose: false });
    await w.clock.run(decided);
    expect(w.signals).toEqual([]);
    expect(w.notices).toEqual(["Build Dashboard is still running from the last session."]);
  });

  it("an app the user stopped by hand during the 15 s is not stopped twice and is not named", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: true, sessions: 0 }]);
    await adoption.adoptAll();
    const decided = adoption.layoutReady();
    await w.clock.advance(GRACE / 3);
    await w.clock.run(manager.stop("build-dashboard"));
    const signalsAfterStop = w.signals.length;
    await w.clock.run(decided);
    expect(w.signals).toHaveLength(signalsAfterStop);
    expect(w.notices.filter((n) => n.includes("left running"))).toEqual([]);
  });

  it("a Held app is not stopped", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: true, sessions: 0 }]);
    await adoption.adoptAll();
    manager.setHeld("build-dashboard", true, "a browser tab is open");
    await w.clock.run(adoption.layoutReady());
    expect(w.signals).toEqual([]);
    expect(manager.isRunning("build-dashboard")).toBe(true);
  });

  it("the kill timer is suspended for an adopted app until the decision is made, then takes over", async () => {
    const { w, manager, adoption, sessions } = relaunch([{ killOn: true, sessions: 1 }]);
    const timer = new KillTimer({
      clock: w.clock,
      sessionCount: (s) => sessions.get(s) ?? 0,
      stateOf: (s) => manager.stateOf(s),
      isHeld: (s) => manager.isHeld(s),
      suspended: (s) => adoption.suspended(s),
      killOnClose: (s) => w.projects.get(s)?.killOnClose,
      stop: (s) => manager.stop(s),
      onInstanceChange: (l) => manager.subscribe((e) => l(e.slug)),
      onSessionChange: () => () => undefined,
    });
    await adoption.adoptAll();
    // Tabs are not counted yet (0): without the suspension the 15 s timer would stop the app before layout ready.
    sessions.set("build-dashboard", 0);
    timer.evaluate("build-dashboard");
    expect(timer.isPending("build-dashboard")).toBe(false);
    await w.clock.advance(5 * 60_000);
    expect(w.signals).toEqual([]);

    // Restored tabs are counted; the decision keeps the app; from now on the ordinary rule applies.
    sessions.set("build-dashboard", 1);
    await adoption.layoutReady();
    expect(adoption.suspended("build-dashboard")).toBe(false);
    sessions.set("build-dashboard", 0);
    timer.evaluate("build-dashboard");
    expect(timer.isPending("build-dashboard")).toBe(true);
    await w.clock.advance(15_000);
    expect(w.signals[0]).toEqual([-4100, "SIGTERM"]);
    timer.dispose();
  });
});

describe("browser poll hook (G10, G13)", () => {
  it("resumes for the apps whose entry expects a browser session, and the stop decision waits for it", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const polled: string[][] = [];
    const { w, manager, adoption } = relaunch([{ killOn: true, sessions: 0, browserExpected: true }, { killOn: true, sessions: 0 }], {
      resumeBrowserPoll: async (slugs) => {
        polled.push(slugs);
        await gate;
      },
    });
    await adoption.adoptAll();
    expect(manager.browserSessionExpected("build-dashboard")).toBe(true);
    expect(manager.browserSessionExpected("live-captions")).toBe(false);
    const decided = adoption.layoutReady();
    await w.clock.advance(5 * 60_000);
    expect(polled).toEqual([["build-dashboard"]]);
    expect(w.signals).toEqual([]); // still waiting for the poll
    finish();
    await w.clock.run(decided);
    expect(w.signals.length).toBeGreaterThan(0);
  });

  it("a poll that fails does not skip the decision", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: false, browserExpected: true }], {
      resumeBrowserPoll: async () => {
        throw new Error("no browser");
      },
    });
    await adoption.adoptAll();
    await w.clock.run(adoption.layoutReady());
    expect(w.notices).toEqual(["Build Dashboard is still running from the last session."]);
    expect(manager.isRunning("build-dashboard")).toBe(true);
  });

  it("the flag is saved in the registry entry and survives a write-back", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: false, browserExpected: true }]);
    await adoption.adoptAll();
    expect(w.registry.entries.get("build-dashboard")?.browserSessionExpected).toBe(true);
    await manager.setBrowserSessionExpected("build-dashboard", false);
    expect(w.registry.entries.get("build-dashboard")?.browserSessionExpected).toBe(false);
  });
});

describe("a registry that cannot be read (corrupt file handling)", () => {
  it("adopts nothing, signals nothing and says so once", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: true }]);
    w.registry.failReads = true;
    const report = await adoption.adoptAll();
    await w.clock.run(adoption.layoutReady());
    expect(report).toEqual({ adopted: [], dropped: [], refused: [] });
    expect(manager.snapshots()).toEqual([]);
    expect(w.signals).toEqual([]);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toContain("left any running apps alone");
    expect(w.registry.entries.size).toBe(1); // the file is untouched
  });

  it("a failed ps look keeps every entry and signals nothing", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: true }]);
    w.table.snapshotScoped = async () => {
      throw new Error("ps failed");
    };
    const report = await adoption.adoptAll();
    expect(report.adopted).toEqual([]);
    expect(report.dropped).toEqual([]);
    expect(manager.snapshots()).toEqual([]);
    expect(w.registry.entries.size).toBe(1);
    expect(w.signals).toEqual([]);
  });
});

describe("two entries for one slug (F10)", () => {
  it("only the newest is adopted and the older group is neither adopted nor signalled", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: true, sessions: 0 }]);
    // A hand-edited file: the same slug recorded twice. The registry reader keeps the newer one.
    const older: RegistryEntry = { slug: "build-dashboard", pid: 4300, pgid: 4300, members: [{ pid: 4300, startTime: w.startTimeFor(4300) }], port: 4317, startedAt: 10, browserSessionExpected: false };
    w.addProc(4300, 4300);
    const read = w.registry.read.bind(w.registry);
    w.registry.read = async () => {
      const r = await read();
      return { ...r, entries: { "build-dashboard": r.entries["build-dashboard"] }, duplicatesDropped: 1 };
    };
    w.registry.entries.set("older", older);
    await adoption.adoptAll();
    await w.clock.run(adoption.layoutReady());
    expect(manager.isRunning("build-dashboard")).toBe(false);
    const signalled = new Set(w.signals.map(([pid]) => pid));
    expect(signalled).toEqual(new Set([-4100]));
    expect(w.procs.some((p) => p.pgid === 4300)).toBe(true); // the older, unrelated group is still there
  });
});

describe("only recorded pids and groups are looked at or signalled (F11, F14)", () => {
  it("F14: at launch every ps look names recorded pids and groups, and lsof is asked only about recorded members", async () => {
    const { w, adoption } = relaunch([{ killOn: false }, { killOn: false }]);
    w.addProc(7777, 7777); // someone else's process, listening on an unrelated port
    w.listening.set(7777, [["127.0.0.1", 6000]]);
    w.answers.set(6000, { html: true });
    await adoption.adoptAll();
    await w.clock.run(adoption.layoutReady());

    expect(w.psCalls.length).toBeGreaterThan(0);
    const recordedPids = new Set([4100, 4101, 4200, 4201]);
    const recordedGroups = new Set([4100, 4200]);
    for (const call of w.psCalls) {
      expect(call.pids.length + call.pgids.length).toBeGreaterThan(0);
      expect(call.pids.every((p) => recordedPids.has(p))).toBe(true);
      expect(call.pgids.every((g) => recordedGroups.has(g))).toBe(true);
    }
    expect(w.lsofCalls.length).toBeGreaterThan(0);
    for (const pids of w.lsofCalls) {
      expect(pids.length).toBeGreaterThan(0);
      expect(pids.every((p) => recordedPids.has(p))).toBe(true);
    }
    expect(w.probes.every((u) => !u.includes(":6000"))).toBe(true); // the stranger's port is never probed
  });

  it("F11: only recorded groups are signalled when stopping, never a neighbour", async () => {
    const { w, manager, adoption } = relaunch([{ killOn: true }, { killOn: false }]);
    w.addProc(7777, 7777);
    await adoption.adoptAll();
    await w.clock.run(adoption.layoutReady());
    await w.clock.run(manager.stop("live-captions"));
    for (const [pid] of w.signals) expect([-4100, -4200]).toContain(pid);
    expect(w.procs.some((p) => p.pid === 7777)).toBe(true);
  });
});

describe("F11 an unknown listener on the app's port is neither adopted nor signalled", () => {
  beforeEach(() => {
    Notice.reset();
    Platform.isDesktopApp = true;
    Platform.isMacOS = true;
  });

  it("with an empty registry and a stranger on 4317, the plugin adopts nothing, and Open reports address in use without touching it", async () => {
    const w = new FakeWorld(project({ slug: "build-dashboard", name: "Build Dashboard", folder: "/work/build-dashboard", command: "npm run start" }));
    w.addProc(7777, 7777); // not ours: started by hand
    w.listening.set(7777, [["127.0.0.1", 4317]]);
    w.answers.set(4317, { html: true });

    const l = await launch(w);
    l.layoutReady();
    expect(l.plugin.instances.snapshots()).toEqual([]);

    const opening = l.plugin.openProject("build-dashboard");
    await w.clock.settle();
    // Our app finds the port taken and dies, as a real server would.
    w.logs.set(logPath("/runtime/k", "build-dashboard"), "Error: listen EADDRINUSE: address already in use 127.0.0.1:4317");
    w.procs = w.procs.filter((p) => p.pid === 7777);
    w.children.get(w.leaderPid())!.exit(1);
    await w.clock.run(opening);

    expect(Notice.messages.at(-1)).toContain("its port is already in use by another program");
    expect(l.plugin.instances.isRunning("build-dashboard")).toBe(false);
    expect(l.leaves).toEqual([]); // no tab was opened on the stranger
    expect(w.procs.map((p) => p.pid)).toEqual([7777]);
    expect(w.signals.filter(([pid]) => pid === -7777 || pid === 7777)).toEqual([]);
    expect(w.probes.filter((u) => u.includes(":4317"))).toEqual([]); // never even probed
    expect(w.registry.entries.size).toBe(0);
  });

  it("a stale entry whose old port is now held by a stranger is dropped; the stranger is neither adopted nor signalled", async () => {
    const w = new FakeWorld(project({ slug: "build-dashboard", name: "Build Dashboard", folder: "/work/build-dashboard" }));
    w.registry.entries.set("build-dashboard", {
      slug: "build-dashboard",
      pid: 4100,
      pgid: 4100,
      members: [{ pid: 4100, startTime: w.startTimeFor(4100) }],
      port: 4317,
      startedAt: 1,
      browserSessionExpected: false,
    });
    w.addProc(7777, 7777);
    w.listening.set(7777, [["127.0.0.1", 4317]]);
    w.answers.set(4317, { html: true });
    const l = await launch(w);
    l.layoutReady();
    await w.clock.advance(60_000);
    expect(l.plugin.instances.snapshots()).toEqual([]);
    expect(w.registry.entries.size).toBe(0);
    expect(w.signals).toEqual([]);
    expect(w.lsofCalls).toEqual([]);
    expect(w.probes).toEqual([]);
  });
});
