import { describe, expect, it } from "vitest";
import { GRACE_MS, KillTimer } from "../../src/kill-timer";
import { SessionCounter, type SessionLeaf } from "../../src/session-counter";
import { VIEW_TYPE_APP } from "../../src/webview-view";
import { HELD_OPENED_IN_BROWSER } from "../../src/held";
import { FakeWorld } from "../process-fakes";

const SLUG = "live-captions";
const MINUTE = 60_000;

const tab = (): SessionLeaf => ({ getViewState: () => ({ type: VIEW_TYPE_APP, state: { slug: SLUG } }) });

/**
 * The real instance manager, session counter and kill timer on the fake clock. The browser hand-off is the real
 * `popOut` (the opener is a recorder), so Held is set the way a user sets it, not by hand.
 */
async function rig(kill: boolean) {
  const w = new FakeWorld();
  w.projects.set(SLUG, { ...w.projects.get(SLUG)!, killOnClose: kill });
  const m = w.manager();
  const leaves: SessionLeaf[] = [];
  const sessions = new SessionCounter(() => leaves);
  const timer = new KillTimer({
    clock: w.clock,
    sessionCount: (s) => sessions.count(s),
    stateOf: (s) => m.stateOf(s),
    isHeld: (s) => m.isHeld(s),
    stopFailed: (s) => m.stopFailedOf(s),
    killOnClose: (s) => w.projects.get(s)?.killOnClose,
    stop: (s) => m.stop(s),
    onInstanceChange: (l) => m.subscribe((e) => l(e.slug)),
    onSessionChange: (l) => sessions.subscribe(l),
  });
  const opening = m.open(SLUG);
  await w.clock.settle();
  w.serve(8957);
  await w.clock.run(opening);
  const first = tab();
  leaves.push(first);
  sessions.refresh();
  return {
    w,
    m,
    timer,
    closeTab() {
      leaves.splice(leaves.indexOf(first), 1);
      sessions.refresh();
    },
    /** A new tab, as the Open command makes after `open` answers `tab`. Returns the function that closes it. */
    openTab() {
      const t = tab();
      leaves.push(t);
      sessions.refresh();
      return () => {
        leaves.splice(leaves.indexOf(t), 1);
        sessions.refresh();
      };
    },
  };
}

describe("G14 with the 15 s kill-on-close timer", () => {
  it("Held (popped out) with zero tabs for 10 minutes: no timer, no stop, no signal", async () => {
    const r = await rig(true);
    expect((await r.m.popOut(SLUG)).kind).toBe("opened");
    expect(r.m.snapshots()[0].heldReason).toBe(HELD_OPENED_IN_BROWSER);
    r.closeTab(); // what the real tab does when it closes after the hand-off
    expect(r.timer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(10 * MINUTE);
    expect(r.m.stateOf(SLUG)).toBe("running");
    expect(r.w.signals).toEqual([]);
    expect(r.timer.pendingCount).toBe(0);
  });

  it("not Held with zero tabs: stopped at 15 s, not before", async () => {
    const r = await rig(true);
    r.closeTab();
    expect(r.timer.isPending(SLUG)).toBe(true);
    await r.w.clock.advance(GRACE_MS - 1);
    expect(r.m.stateOf(SLUG)).toBe("running");
    await r.w.clock.advance(1);
    await r.w.clock.advance(2000); // the stop that began finishes
    expect(r.m.stateOf(SLUG)).toBe("none");
  });

  it("Kill off never stops, Held or not", async () => {
    const r = await rig(false);
    r.closeTab();
    await r.w.clock.advance(10 * MINUTE);
    expect(r.m.stateOf(SLUG)).toBe("running");
    await r.m.popOut(SLUG);
    await r.w.clock.advance(10 * MINUTE);
    expect(r.m.stateOf(SLUG)).toBe("running");
    expect(r.w.signals).toEqual([]);
  });

  it("a pending 15 s timer is cancelled the moment the app becomes Held", async () => {
    const r = await rig(true);
    r.closeTab();
    expect(r.timer.isPending(SLUG)).toBe(true);
    await r.w.clock.advance(10_000);
    await r.m.popOut(SLUG);
    expect(r.timer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(MINUTE);
    expect(r.m.stateOf(SLUG)).toBe("running");
    expect(r.w.signals).toEqual([]);
  });

  it("Held with no 30 s rule in this PR: still running at 29, 30, 31 s and 10 minutes", async () => {
    const r = await rig(true);
    await r.m.popOut(SLUG);
    r.closeTab();
    for (const ms of [29_000, 1_000, 1_000, 10 * MINUTE]) {
      await r.w.clock.advance(ms);
      expect(r.m.stateOf(SLUG)).toBe("running");
    }
  });
});

describe("a Stop the kill timer made that fails", () => {
  const eperm = () => Object.assign(new Error("operation not permitted"), { code: "EPERM" });

  it("is tried once: one signal attempt and one notice over two minutes, the app stays running", async () => {
    const r = await rig(true);
    r.w.killError = eperm();
    r.w.notices.length = 0;
    r.closeTab();
    await r.w.clock.advance(2 * MINUTE);
    expect(r.w.signals).toEqual([[-5000, "SIGTERM"]]);
    expect(r.w.notices).toEqual(["Could not stop Live Captions: operation not permitted"]);
    expect(r.m.stateOf(SLUG)).toBe("running");
    expect(r.w.registry.entries.has(SLUG)).toBe(true);
    expect(r.timer.pendingCount).toBe(0);
  });

  it("the user's own Stop afterwards still works and ends the app", async () => {
    const r = await rig(true);
    r.w.killError = eperm();
    r.closeTab();
    await r.w.clock.advance(MINUTE);
    r.w.killError = null;
    expect(await r.w.clock.run(r.m.stop(SLUG))).toBe("stopped");
    expect(r.m.stateOf(SLUG)).toBe("none");
  });

  it("opening the app again lets a later close stop it once more", async () => {
    const r = await rig(true);
    r.w.killError = eperm();
    r.closeTab();
    await r.w.clock.advance(MINUTE);
    expect(r.w.signals).toHaveLength(1);

    r.w.killError = null;
    expect((await r.w.clock.run(r.m.open(SLUG))).kind).toBe("tab");
    const closeSecond = r.openTab();
    expect(r.timer.isPending(SLUG)).toBe(false);
    closeSecond();
    expect(r.timer.isPending(SLUG)).toBe(true);
    await r.w.clock.advance(GRACE_MS + 2000);
    expect(r.m.stateOf(SLUG)).toBe("none");
  });
});
