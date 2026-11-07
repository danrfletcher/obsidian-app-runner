import { describe, expect, it } from "vitest";
import type { InstanceEvent, InstanceManager } from "../../src/instance";
import { FakeWorld } from "../process-fakes";

const SLUG = "live-captions";

/** Record every event, with the instance's state at the moment it was heard. */
function record(m: InstanceManager) {
  const events: Array<InstanceEvent & { state: string }> = [];
  const off = m.subscribe((e) => events.push({ ...e, state: m.stateOf(e.slug) }));
  const ended = () => events.filter((e) => e.type === "ended");
  return { events, ended, off };
}

async function startApp(w: FakeWorld, m: InstanceManager) {
  const opening = m.open(SLUG);
  await w.clock.settle();
  w.serve(8957);
  await w.clock.run(opening);
}

describe("instance events: how an instance ends", () => {
  it("an app that exits on its own emits one ended event, cause crashed, after it has left the table", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const { ended, events } = record(m);
    await startApp(w, m);
    w.procs = [];
    w.children.get(w.leaderPid())!.exit(1);
    await w.clock.settle();
    expect(ended()).toEqual([{ type: "ended", slug: SLUG, cause: "crashed", state: "none" }]);
    expect(events.map((e) => (e.type === "changed" ? e.state : `ended:${e.cause}`))).toEqual(["starting", "running", "ended:crashed"]);
    expect(w.signals).toEqual([]); // nothing was stopped: it was already gone
  });

  it("a requested Stop emits one ended event, cause requested; the leader exiting because of the Stop is not a crash", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const { ended, events } = record(m);
    await startApp(w, m);
    const leader = w.leaderPid();
    await w.clock.run(m.stop(SLUG)); // the fake kill removes the group and fires the leader's exit event
    await w.clock.advance(2000);
    expect(w.children.get(leader)!.signalCode).toBe("SIGTERM");
    expect(ended()).toEqual([{ type: "ended", slug: SLUG, cause: "requested", state: "none" }]);
    expect(events.map((e) => (e.type === "changed" ? e.state : `ended:${e.cause}`))).toEqual(["starting", "running", "stopping", "ended:requested"]);
    expect(w.notices).not.toContain("Live Captions stopped on its own.");
  });

  it("the app exiting while Stop is waiting out its 5 s grace is still one requested end", async () => {
    const w = new FakeWorld();
    w.nextLeader = { ignoresTerm: true };
    const m = w.manager();
    const { ended } = record(m);
    await startApp(w, m);
    const stopping = m.stop(SLUG);
    await w.clock.advance(1000);
    expect(m.stateOf(SLUG)).toBe("stopping");
    // The app dies by itself in the middle of the stop.
    w.procs = [];
    w.children.get(w.leaderPid())!.exit(1);
    await w.clock.run(stopping);
    await w.clock.advance(6000);
    expect(ended().map((e) => e.type === "ended" && e.cause)).toEqual(["requested"]);
    expect(w.notices).not.toContain("Live Captions stopped on its own.");
  });

  it("a start that fails emits one ended event, cause start-failed, and never reports running", async () => {
    const w = new FakeWorld();
    w.nextLeader = { exitsWith: 127 };
    const m = w.manager();
    const { ended, events } = record(m);
    expect((await w.clock.run(m.open(SLUG))).kind).toBe("failed");
    expect(ended()).toEqual([{ type: "ended", slug: SLUG, cause: "start-failed", state: "none" }]);
    expect(events.filter((e) => e.type === "changed").map((e) => e.state)).toEqual(["starting", "stopping"]);
  });

  it("Stop while starting emits one ended event (a cancelled start is a requested stop)", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const { ended } = record(m);
    const opening = m.open(SLUG);
    await w.clock.settle();
    expect(m.stateOf(SLUG)).toBe("starting");
    expect(await w.clock.run(m.stop(SLUG))).toBe("cancelled");
    expect((await w.clock.run(opening)).kind).toBe("cancelled");
    expect(ended().map((e) => e.type === "ended" && e.cause)).toEqual(["requested"]);
  });

  it("Stop when nothing runs emits nothing", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const { events } = record(m);
    expect(await m.stop(SLUG)).toBe("nothing");
    expect(events).toEqual([]);
  });

  it("a second Stop while stopping adds no second ended event", async () => {
    const w = new FakeWorld();
    w.nextLeader = { ignoresTerm: true };
    const m = w.manager();
    const { ended } = record(m);
    await startApp(w, m);
    const first = m.stop(SLUG);
    await w.clock.advance(500);
    const second = m.stop(SLUG);
    await w.clock.run(Promise.all([first, second]));
    expect(ended()).toHaveLength(1);
  });

  it("starting again after an end gives a fresh instance with its own events", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const { ended } = record(m);
    await startApp(w, m);
    await w.clock.run(m.stop(SLUG));
    await startApp(w, m);
    await w.clock.run(m.stop(SLUG));
    expect(ended()).toHaveLength(2);
  });
});

describe("instance events: subscribing", () => {
  it("unsubscribe stops delivery; clearListeners drops everyone", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const a = record(m);
    const b = record(m);
    expect(m.listenerCount).toBe(2);
    a.off();
    expect(m.listenerCount).toBe(1);
    await startApp(w, m);
    expect(a.events).toEqual([]);
    expect(b.events.length).toBeGreaterThan(0);
    m.clearListeners();
    expect(m.listenerCount).toBe(0);
    const before = b.events.length;
    await w.clock.run(m.stop(SLUG));
    expect(b.events).toHaveLength(before);
  });

  it("a listener that throws does not stop the others or the stop", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    m.subscribe(() => {
      throw new Error("boom");
    });
    const { ended } = record(m);
    await startApp(w, m);
    expect(await w.clock.run(m.stop(SLUG))).toBe("stopped");
    expect(ended()).toHaveLength(1);
  });

  it("the port shows in the snapshot once running, and a restart on another port shows the new one (E19)", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    await startApp(w, m);
    expect(m.snapshots().map((s) => [s.slug, s.name, s.state, s.port])).toEqual([[SLUG, "Live Captions", "running", 8957]]);
    await w.clock.run(m.stop(SLUG));
    expect(m.snapshots()).toEqual([]);
    const opening = m.open(SLUG);
    await w.clock.settle();
    w.serve(9100);
    await w.clock.run(opening);
    expect(m.snapshots().map((s) => s.port)).toEqual([9100]);
    expect(m.urlOf(SLUG)).toBe("http://127.0.0.1:9100/");
  });

  it("setHeld changes the flag, says so once, and does nothing for an app that is not there", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    m.setHeld(SLUG, true, "x"); // nothing runs
    const { events } = record(m);
    expect(events).toEqual([]);
    await startApp(w, m);
    const n = events.length;
    m.setHeld(SLUG, true, "popped out");
    m.setHeld(SLUG, true, "popped out"); // no change
    expect(events).toHaveLength(n + 1);
    expect(m.isHeld(SLUG)).toBe(true);
    expect(m.snapshots()[0]).toMatchObject({ held: true, heldReason: "popped out" });
    m.setHeld(SLUG, false);
    expect(m.isHeld(SLUG)).toBe(false);
    expect(m.snapshots()[0].heldReason).toBe("");
  });
});
