import { describe, expect, it } from "vitest";
import { FakeWorld, project } from "../process-fakes";

const SLUG = "live-captions";

/** The app started and answering on 8957. */
async function started(w: FakeWorld, over: Parameters<FakeWorld["manager"]>[0] = {}) {
  const m = w.manager(over);
  const opening = m.open(SLUG);
  await w.clock.settle();
  w.serve(8957);
  const outcome = await w.clock.run(opening);
  return { m, outcome };
}

describe("a Stop that arrives during the registry write that follows ready", () => {
  it("open() reports cancelled, not a tab for an app that is being stopped", async () => {
    const w = new FakeWorld();
    const realSet = w.registry.set.bind(w.registry);
    let sets = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // The first write is at spawn; the second records the port after ready, and is held.
    w.registry.set = async (entry) => {
      if (++sets === 2) await gate;
      await realSet(entry);
    };
    const m = w.manager();
    const opening = m.open(SLUG);
    await w.clock.settle();
    w.serve(8957);
    await w.clock.advance(1500);
    expect(sets).toBe(2); // the write is waiting
    expect(m.stateOf(SLUG)).toBe("running");

    const stopping = m.stop(SLUG);
    release();
    const [outcome, stopped] = await w.clock.run(Promise.all([opening, stopping]));
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(stopped).toBe("stopped");
    expect(m.stateOf(SLUG)).toBe("none");
    expect(w.registry.entries.has(SLUG)).toBe(false);
  });
});

describe("a stop that fails keeps the instance (one-instance rule)", () => {
  it("EPERM: Stop says it failed and not that it stopped; the next Open does not spawn a second app; a later Stop works", async () => {
    const w = new FakeWorld();
    const { m } = await started(w);
    w.killError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    w.notices.length = 0;

    expect(await w.clock.run(m.stop(SLUG))).toBe("failed");
    expect(w.notices).toEqual(["Could not stop Live Captions: operation not permitted"]);
    expect(m.stateOf(SLUG)).toBe("running");
    expect(w.registry.entries.has(SLUG)).toBe(true);

    const again = await w.clock.run(m.open(SLUG));
    expect(again.kind).toBe("tab");
    expect(w.spawns).toHaveLength(1);

    w.killError = null;
    expect(await w.clock.run(m.stop(SLUG))).toBe("stopped");
    expect(m.stateOf(SLUG)).toBe("none");
    expect(w.registry.entries.has(SLUG)).toBe(false);
    expect(w.notices.at(-1)).toBe("Stopped Live Captions.");
  });

  it("deleting a project whose app could not be stopped keeps its registry entry, so the next launch adopts it", async () => {
    const w = new FakeWorld();
    const { m } = await started(w);
    w.killError = new Error("operation not permitted");
    await w.clock.run(m.removeRuntime(project()));
    expect(m.stateOf(SLUG)).toBe("running");
    expect(w.registry.entries.has(SLUG)).toBe(true);
  });
});

describe("members started after the app was ready are recorded", () => {
  it("the 5 s member poll records a worker that joined the group while the leader lives", async () => {
    const w = new FakeWorld();
    const { m } = await started(w);
    expect(w.registry.entries.get(SLUG)!.members.map((x) => x.pid)).toEqual([5000]);
    w.addProc(6000, 5000);
    await w.clock.advance(5000);
    expect(w.registry.entries.get(SLUG)!.members.map((x) => x.pid).sort()).toEqual([5000, 6000]);
    expect(m.stateOf(SLUG)).toBe("running");
  });

  it("the leader exits while an unrecorded worker lives: the app is still ours, not 'stopped on its own', and Stop kills the worker", async () => {
    const w = new FakeWorld();
    const { m } = await started(w);
    w.addProc(6000, 5000); // started after ready; no refresh has seen it
    w.procs = w.procs.filter((p) => p.pid !== 5000);
    w.children.get(5000)!.exit(0);
    await w.clock.settle();

    expect(m.stateOf(SLUG)).toBe("running");
    expect(w.notices.some((n) => n.includes("stopped on its own"))).toBe(false);
    expect(w.registry.entries.get(SLUG)!.members.map((x) => x.pid)).toContain(6000);

    expect(await w.clock.run(m.stop(SLUG))).toBe("stopped");
    expect(w.signals[0]).toEqual([-5000, "SIGTERM"]);
    expect(w.procs.some((p) => p.pgid === 5000)).toBe(false);
    expect(m.stateOf(SLUG)).toBe("none");
  });

  it("once the leader is gone and the last worker dies too, the poll ends the app as stopped on its own", async () => {
    const w = new FakeWorld();
    const { m } = await started(w);
    w.addProc(6000, 5000);
    w.procs = w.procs.filter((p) => p.pid !== 5000);
    w.children.get(5000)!.exit(0);
    await w.clock.settle();
    expect(m.stateOf(SLUG)).toBe("running");

    w.procs = [];
    await w.clock.advance(5000);
    expect(m.stateOf(SLUG)).toBe("none");
    expect(w.notices.at(-1)).toBe("Live Captions stopped on its own.");
    expect(w.registry.entries.has(SLUG)).toBe(false);
    expect(w.signals).toEqual([]);
  });

  it("a Stop ends the poll: nothing is looked at afterwards", async () => {
    const w = new FakeWorld();
    const { m } = await started(w);
    await w.clock.run(m.stop(SLUG));
    expect(m.memberPollCount).toBe(0);
    w.psCalls.length = 0;
    await w.clock.advance(30_000);
    expect(w.psCalls).toEqual([]);
  });
});

describe("Open in browser and the panel's Start", () => {
  it("open with browser: false gives a tab even when Open in browser is on, and holds nothing", async () => {
    const w = new FakeWorld(project({ openInBrowser: true }));
    const { m, outcome } = await started(w);
    expect(outcome.kind).toBe("browser"); // the Open command: the browser
    w.external.length = 0;

    const again = await m.open(SLUG, { browser: false });
    expect(again).toEqual({ kind: "tab", url: "http://127.0.0.1:8957/" });
    expect(w.external).toEqual([]);
  });

  it("a start asked for with browser: false does not open the browser either", async () => {
    const w = new FakeWorld(project({ openInBrowser: true }));
    const m = w.manager();
    const opening = m.open(SLUG, { browser: false });
    await w.clock.settle();
    w.serve(8957);
    expect((await w.clock.run(opening)).kind).toBe("tab");
    expect(w.external).toEqual([]);
    expect(m.isHeld(SLUG)).toBe(false);
  });

  it("a project with Open in browser on is Held after the start's browser open, so Kill on does not stop it", async () => {
    const w = new FakeWorld(project({ openInBrowser: true }));
    const { m } = await started(w);
    expect(m.isHeld(SLUG)).toBe(true);
    expect(m.heldReasonOf(SLUG)).toBe("opened-in-browser");
  });
});

describe("Pop out and Open in browser during one start open the browser once", () => {
  it.each([
    ["an opener that answers at once", 0],
    ["an opener that takes a moment", 5],
  ])("%s", async (_name, delayMs) => {
    const w = new FakeWorld(project({ openInBrowser: true }));
    const m = w.manager({
      openExternal: async (u) => {
        w.external.push(u);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      },
    });
    const opening = m.open(SLUG);
    await w.clock.settle();
    const popping = m.popOut(SLUG);
    w.serve(8957);
    const [outcome, popped] = await w.clock.run(Promise.all([opening, popping]));
    expect(outcome.kind).toBe("browser");
    expect(popped).toEqual({ kind: "opened", url: "http://127.0.0.1:8957/" });
    expect(w.external).toEqual(["http://127.0.0.1:8957/"]);
  });

  it("a later, separate Pop out still opens the browser again (the user asked)", async () => {
    const w = new FakeWorld();
    const { m } = await started(w);
    await w.clock.run(m.popOut(SLUG));
    await w.clock.run(m.popOut(SLUG));
    expect(w.external).toHaveLength(2);
  });
});

describe("Pop out on an app whose port is not known yet", () => {
  it("looks for the port once before giving up, as Open does", async () => {
    const w = new FakeWorld();
    const { m } = await started(w);
    (m as unknown as { instances: Map<string, { url: string | null }> }).instances.get(SLUG)!.url = null;
    const popped = await w.clock.run(m.popOut(SLUG));
    expect(popped).toEqual({ kind: "opened", url: "http://127.0.0.1:8957/" });
    expect(w.external).toEqual(["http://127.0.0.1:8957/"]);
  });
});
