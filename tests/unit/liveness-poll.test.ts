import { describe, expect, it } from "vitest";
import { Adoption } from "../../src/adopt";
import type { InstanceEvent } from "../../src/instance";
import { LIVENESS_MS, LivenessPoll, type LivenessVerdict } from "../../src/liveness-poll";
import { FakeClock } from "../fake-clock";
import { FakeWorld, project } from "../process-fakes";

describe("LivenessPoll on its own", () => {
  function poll(verdicts: LivenessVerdict[] | ((slug: string) => LivenessVerdict | Promise<LivenessVerdict>)) {
    const clock = new FakeClock();
    const calls: Array<[string, number]> = [];
    const p = new LivenessPoll({
      clock,
      check: async (slug) => {
        calls.push([slug, clock.now()]);
        return typeof verdicts === "function" ? verdicts(slug) : (verdicts.shift() ?? "alive");
      },
    });
    return { clock, calls, p };
  }

  it("checks every 5 s, exactly, starting 5 s after watch", async () => {
    const { clock, calls, p } = poll([]);
    const t0 = clock.now();
    p.watch("a");
    await clock.advance(LIVENESS_MS - 1);
    expect(calls).toEqual([]);
    await clock.advance(1);
    await clock.advance(LIVENESS_MS);
    await clock.advance(LIVENESS_MS);
    expect(calls.map(([, t]) => t - t0)).toEqual([5000, 10_000, 15_000]);
    expect(LIVENESS_MS).toBe(5000);
  });

  it("watching the same app twice makes one timer, and watched apps have independent timers", async () => {
    const { clock, calls, p } = poll([]);
    p.watch("a");
    p.watch("a");
    p.watch("b");
    expect(clock.pendingTimers).toBe(2);
    await clock.advance(LIVENESS_MS);
    expect(calls.map(([s]) => s).sort()).toEqual(["a", "b"]);
  });

  it("a gone verdict stops polling that app for good", async () => {
    const { clock, calls, p } = poll(["alive", "gone"]);
    p.watch("a");
    await clock.advance(60_000);
    expect(calls).toHaveLength(2);
    expect(p.isWatching("a")).toBe(false);
    expect(clock.pendingTimers).toBe(0);
  });

  it("a check that throws counts as alive and polling continues", async () => {
    const clock = new FakeClock();
    let n = 0;
    const p = new LivenessPoll({
      clock,
      check: async () => {
        if (++n === 1) throw new Error("ps hiccup");
        return "alive";
      },
    });
    p.watch("a");
    await clock.advance(15_000);
    expect(n).toBe(3);
  });

  it("unwatch cancels the timer; a check already running does not schedule another", async () => {
    const clock = new FakeClock();
    let release!: () => void;
    const slow = new Promise<LivenessVerdict>((r) => (release = () => r("alive")));
    let n = 0;
    const p = new LivenessPoll({ clock, check: () => (++n === 1 ? slow : Promise.resolve("alive")) });
    p.watch("a");
    await clock.advance(5000); // the first check is now in flight
    p.unwatch("a");
    release();
    await clock.advance(60_000);
    expect(n).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it("dispose clears every timer, and nothing can be watched afterwards", async () => {
    const { clock, calls, p } = poll([]);
    p.watch("a");
    p.watch("b");
    p.dispose();
    expect(clock.pendingTimers).toBe(0);
    p.watch("c");
    expect(clock.pendingTimers).toBe(0);
    await clock.advance(60_000);
    expect(calls).toEqual([]);
  });
});

/** An adopted app, running from the last session, with Kill off so adoption leaves it alone. */
async function adopted() {
  const w = new FakeWorld(project({ slug: "build-dashboard", name: "Build Dashboard", killOnClose: false }));
  w.addProc(4100, 4100);
  w.addProc(4101, 4100);
  w.listening.set(4101, [["127.0.0.1", 4317]]);
  w.answers.set(4317, { html: true });
  w.registry.entries.set("build-dashboard", {
    slug: "build-dashboard",
    pid: 4100,
    pgid: 4100,
    members: [
      { pid: 4100, startTime: w.startTimeFor(4100) },
      { pid: 4101, startTime: w.startTimeFor(4101) },
    ],
    port: 4317,
    startedAt: 1,
    browserSessionExpected: false,
  });
  const manager = w.manager();
  const events: InstanceEvent[] = [];
  manager.subscribe((e) => events.push(e));
  const adoption = new Adoption({
    registry: w.registry,
    table: w.table,
    target: manager,
    getProject: (s) => w.projects.get(s),
    sessionCount: () => 0,
    killOnClose: () => false,
    clock: w.clock,
    notify: (m) => void w.notices.push(m),
  });
  await adoption.adoptAll();
  w.notices.length = 0;
  events.length = 0;
  w.psCalls.length = 0;
  return { w, manager, events, adoption };
}

describe("an adopted app is watched because it is not our child (E21)", () => {
  it("the poll looks every 5 s with ps scoped to the recorded members and group, and an app that is alive stays", async () => {
    const { w, manager } = await adopted();
    await w.clock.advance(4999);
    expect(w.psCalls).toEqual([]);
    await w.clock.advance(1);
    expect(w.psCalls).toEqual([{ pids: [4100, 4101], pgids: [4100] }]);
    await w.clock.advance(10_000);
    expect(w.psCalls).toHaveLength(3);
    expect(manager.stateOf("build-dashboard")).toBe("running");
    expect(w.signals).toEqual([]);
  });

  it("notices death with no child exit event: the instance ends as crashed, once, the entry is dropped, and the tab is told", async () => {
    const { w, manager, events } = await adopted();
    expect(w.children.size).toBe(0); // there is no child object to hear an exit from
    w.procs = []; // the app dies while nobody is looking
    await w.clock.advance(4999);
    expect(manager.stateOf("build-dashboard")).toBe("running");
    await w.clock.advance(1);
    expect(manager.stateOf("build-dashboard")).toBe("none");
    expect(events).toEqual([{ type: "ended", slug: "build-dashboard", cause: "crashed" }]);
    expect(w.registry.entries.has("build-dashboard")).toBe(false);
    expect(w.registry.removes).toBe(1);
    expect(w.notices).toEqual(["Build Dashboard stopped on its own."]);
    // Dropped once: later ticks do nothing.
    await w.clock.advance(60_000);
    expect(w.registry.removes).toBe(1);
    expect(events).toHaveLength(1);
    expect(w.signals).toEqual([]);
  });

  it("only the recorded members count: a stranger that took over the leader's pid does not keep the app alive", async () => {
    const { w, manager } = await adopted();
    w.procs = [{ pid: 4100, pgid: 4100, startTime: "Sat Nov  7 09:00:00 2026", ignoresTerm: false }];
    await w.clock.advance(5000);
    expect(manager.stateOf("build-dashboard")).toBe("none");
    expect(w.signals).toEqual([]); // nothing is signalled for a process we do not own
  });

  it("the leader dying while a recorded member lives is not death", async () => {
    const { w, manager } = await adopted();
    w.procs = w.procs.filter((p) => p.pid !== 4100);
    await w.clock.advance(30_000);
    expect(manager.stateOf("build-dashboard")).toBe("running");
  });

  it("an app whose members change is followed: a new child in the group is recorded", async () => {
    const { w, manager } = await adopted();
    w.addProc(4150, 4100);
    w.procs = w.procs.filter((p) => p.pid !== 4101);
    await w.clock.advance(5000);
    await w.clock.advance(5000);
    expect(manager.stateOf("build-dashboard")).toBe("running"); // the leader still lives
    const recorded = () => w.registry.entries.get("build-dashboard")!.members.map((m) => m.pid);
    expect(recorded()).toContain(4150);
    expect(w.registry.entries.get("build-dashboard")!.members.find((m) => m.pid === 4150)!.startTime).toBe(w.startTimeFor(4150));

    // Every originally recorded member is gone; only the member that joined later lives. The app is still ours.
    w.procs = w.procs.filter((p) => p.pid === 4150);
    await w.clock.advance(10_000);
    expect(manager.stateOf("build-dashboard")).toBe("running");
    expect(w.registry.entries.has("build-dashboard")).toBe(true);
    expect(w.registry.removes).toBe(0);

    // And Stop can still reach it.
    await w.clock.run(manager.stop("build-dashboard"));
    expect(w.signals[0]).toEqual([-4100, "SIGTERM"]);
    expect(w.procs.some((p) => p.pid === 4150)).toBe(false);
  });

  it("a member that joined the group is what a relaunch adopts by when the original members are gone", async () => {
    const { w } = await adopted();
    w.addProc(4150, 4100);
    await w.clock.advance(5000);
    w.procs = w.procs.filter((p) => p.pid === 4150);
    const manager2 = w.manager();
    const adoption2 = new Adoption({
      registry: w.registry,
      table: w.table,
      target: manager2,
      getProject: (s) => w.projects.get(s),
      sessionCount: () => 0,
      killOnClose: () => false,
      clock: w.clock,
      notify: (m) => void w.notices.push(m),
    });
    await adoption2.adoptAll();
    expect(manager2.stateOf("build-dashboard")).toBe("running");
    expect(w.registry.entries.has("build-dashboard")).toBe(true);
    expect(w.signals).toEqual([]);
  });

  it("polling stops after Stop: no ps look is made again", async () => {
    const { w, manager } = await adopted();
    await w.clock.run(manager.stop("build-dashboard"));
    w.psCalls.length = 0;
    await w.clock.advance(60_000);
    expect(w.psCalls).toEqual([]);
  });

  it("polling stops at unload: the timer is gone, nothing is looked at, nothing is written", async () => {
    const { w, manager, events } = await adopted();
    manager.dispose();
    w.procs = []; // dies after unload: this plugin instance is gone and must not react
    await w.clock.advance(60_000);
    expect(w.psCalls).toEqual([]);
    expect(events).toEqual([]);
    expect(w.registry.removes).toBe(0);
    expect(w.signals).toEqual([]);
  });

  it("an app started in this session is not polled: its exit event is how we know", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const opening = m.open("live-captions");
    await w.clock.settle();
    w.serve(8957);
    await w.clock.run(opening);
    w.psCalls.length = 0;
    await w.clock.advance(20_000);
    expect(w.psCalls).toEqual([]);
  });

  it("a ps look that fails does not end the app", async () => {
    const { w, manager } = await adopted();
    w.table.snapshotScoped = async () => {
      throw new Error("ps failed");
    };
    await w.clock.advance(30_000);
    expect(manager.stateOf("build-dashboard")).toBe("running");
    expect(w.registry.removes).toBe(0);
  });
});
