import { describe, expect, it } from "vitest";
import { GRACE_MS, KillTimer } from "../../src/kill-timer";
import { SessionCounter, type SessionLeaf } from "../../src/session-counter";
import { VIEW_TYPE_APP } from "../../src/webview-view";
import { FakeWorld } from "../process-fakes";

const SLUG = "live-captions";
const SECOND = 1000;

/** A saved App Runner tab for the project. */
const tab = (slug = SLUG): SessionLeaf => ({ getViewState: () => ({ type: VIEW_TYPE_APP, state: { slug } }) });

/**
 * The real instance manager, session counter and kill timer on a fake clock and fake process world. Tabs are leaves in
 * a list; the only thing faked is the process side, as in the other unit tests.
 */
function rig(over: { kill?: boolean } = {}) {
  const w = new FakeWorld();
  w.projects.set(SLUG, { ...w.projects.get(SLUG)!, killOnClose: over.kill ?? true });
  const m = w.manager();
  const leaves: SessionLeaf[] = [];
  const sessions = new SessionCounter(() => leaves);
  const stops: string[] = [];
  const timer = new KillTimer({
    clock: w.clock,
    sessionCount: (s) => sessions.count(s),
    stateOf: (s) => m.stateOf(s),
    isHeld: (s) => m.isHeld(s),
    killOnClose: (s) => w.projects.get(s)?.killOnClose,
    stop: (s) => {
      stops.push(s);
      return m.stop(s);
    },
    onInstanceChange: (l) => m.subscribe((e) => l(e.slug)),
    onSessionChange: (l) => sessions.subscribe(l),
  });
  let maxPending = 0;
  m.subscribe(() => (maxPending = Math.max(maxPending, timer.pendingCount)));
  sessions.subscribe(() => (maxPending = Math.max(maxPending, timer.pendingCount)));
  return {
    w,
    m,
    sessions,
    timer,
    stops,
    leaves,
    get maxPending() {
      return maxPending;
    },
    /** Fake-clock timers that are not the 5 s member poll of the running app (that one is not the kill timer's). */
    get killTimers() {
      return w.clock.pendingTimers - m.memberPollCount;
    },
    async start() {
      const opening = m.open(SLUG);
      await w.clock.settle();
      w.serve(8957);
      await w.clock.run(opening);
    },
    open(): SessionLeaf {
      const l = tab();
      leaves.push(l);
      sessions.refresh();
      return l;
    },
    close(l: SessionLeaf) {
      leaves.splice(leaves.indexOf(l), 1);
      sessions.refresh();
    },
    setKill(on: boolean) {
      w.projects.set(SLUG, { ...w.projects.get(SLUG)!, killOnClose: on });
      timer.evaluate(SLUG); // what ProjectManager.setToggle's hook does
    },
  };
}

describe("G14 the rule, over Kill, Held, sessions and the 14 s / 15 s boundary", () => {
  const cases: Array<{ kill: boolean; held: boolean; tabs: 0 | 1; waitMs: number; stopped: boolean }> = [];
  for (const kill of [true, false]) {
    for (const held of [false, true]) {
      for (const tabs of [0, 1] as const) {
        for (const waitMs of [14_999, 15_000]) {
          cases.push({ kill, held, tabs, waitMs, stopped: kill && !held && tabs === 0 && waitMs >= 15_000 });
        }
      }
    }
  }

  it.each(cases)("Kill $kill, Held $held, $tabs tabs at zero for $waitMs ms: stopped $stopped", async ({ kill, held, tabs, waitMs, stopped }) => {
    const r = rig({ kill });
    await r.start();
    const tabLeaf = r.open();
    if (tabs === 0) r.close(tabLeaf); // the count falls to zero now
    if (held) r.m.setHeld(SLUG, true, "popped out");
    await r.w.clock.advance(waitMs);
    // The timer has just fired or not; a stop that began takes a few more ticks of the clock to finish.
    expect(r.m.stateOf(SLUG) === "running").toBe(!stopped);
    expect(r.stops).toEqual(stopped ? [SLUG] : []);
    expect(r.w.signals.length > 0).toBe(stopped);
    if (stopped) {
      await r.w.clock.advance(2 * SECOND);
      expect(r.m.stateOf(SLUG)).toBe("none");
    }
  });

  it("the grace is 15 s", () => {
    expect(GRACE_MS).toBe(15_000);
    expect(rig().timer.graceMs).toBe(15_000);
  });
});

describe("G14 session transitions", () => {
  it("a new tab inside the 15 s cancels the timer, and the next close starts a fresh 15 s", async () => {
    const r = rig();
    await r.start();
    const first = r.open();
    r.close(first);
    expect(r.timer.isPending(SLUG)).toBe(true);
    await r.w.clock.advance(14 * SECOND);
    const second = r.open();
    expect(r.timer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(60 * SECOND);
    expect(r.m.stateOf(SLUG)).toBe("running");
    r.close(second);
    await r.w.clock.advance(14 * SECOND);
    expect(r.m.stateOf(SLUG)).toBe("running");
    await r.w.clock.advance(SECOND);
    await r.w.clock.advance(2 * SECOND); // let the stop that just began finish
    expect(r.m.stateOf(SLUG)).toBe("none");
    expect(r.stops).toEqual([SLUG]);
  });

  it("closing one of two tabs does not start the timer; closing the second does (GP5)", async () => {
    const r = rig();
    await r.start();
    const a = r.open();
    const b = r.open();
    r.close(a);
    expect(r.timer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(60 * SECOND);
    expect(r.m.stateOf(SLUG)).toBe("running");
    r.close(b);
    expect(r.timer.isPending(SLUG)).toBe(true);
    await r.w.clock.advance(15 * SECOND);
    await r.w.clock.advance(2 * SECOND); // let the stop that just began finish
    expect(r.m.stateOf(SLUG)).toBe("none");
    expect(r.m.snapshots()).toEqual([]);
  });

  it("E14: detach then attach in the same tick never stops the app", async () => {
    const r = rig();
    await r.start();
    const dragged = r.open();
    r.close(dragged);
    r.leaves.push(dragged);
    r.sessions.refresh();
    expect(r.sessions.count(SLUG)).toBe(1);
    expect(r.timer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(60 * SECOND);
    expect(r.stops).toEqual([]);
    expect(r.m.stateOf(SLUG)).toBe("running");
  });

  it("E14: detach, 14 s, attach: the app is still running and stays so", async () => {
    const r = rig();
    await r.start();
    const dragged = r.open();
    r.close(dragged);
    await r.w.clock.advance(14 * SECOND);
    expect(r.m.stateOf(SLUG)).toBe("running");
    r.leaves.push(dragged);
    r.sessions.refresh();
    await r.w.clock.advance(60 * SECOND);
    expect(r.stops).toEqual([]);
    expect(r.m.stateOf(SLUG)).toBe("running");
    expect(r.sessions.count(SLUG)).toBe(1);
  });

  it("a freshly started app with no tab yet is stopped after 15 s, but a tab arriving in time keeps it (the Open flow)", async () => {
    const lazy = rig();
    await lazy.start();
    expect(lazy.timer.isPending(SLUG)).toBe(true);
    lazy.open();
    expect(lazy.timer.isPending(SLUG)).toBe(false);

    const none = rig();
    await none.start();
    await none.w.clock.advance(15 * SECOND);
    await none.w.clock.advance(2 * SECOND); // let the stop that just began finish
    expect(none.m.stateOf(SLUG)).toBe("none");
  });

  it("tabs of another project do not hold this one open", async () => {
    const r = rig();
    await r.start();
    r.leaves.push(tab("some-other-app"));
    r.sessions.refresh();
    await r.w.clock.advance(15 * SECOND);
    await r.w.clock.advance(2 * SECOND); // let the stop that just began finish
    expect(r.m.stateOf(SLUG)).toBe("none");
  });
});

describe("G14 the Kill toggle applies at once", () => {
  it("off cancels a pending timer; the app then sits at zero for ever", async () => {
    const r = rig();
    await r.start();
    expect(r.timer.isPending(SLUG)).toBe(true);
    await r.w.clock.advance(5 * SECOND);
    r.setKill(false);
    expect(r.timer.isPending(SLUG)).toBe(false);
    expect(r.killTimers).toBe(0);
    await r.w.clock.advance(3600 * SECOND);
    expect(r.stops).toEqual([]);
    expect(r.m.stateOf(SLUG)).toBe("running");
  });

  it("on with zero sessions starts a timer counted from the toggle, not from earlier", async () => {
    const r = rig({ kill: false });
    await r.start();
    expect(r.timer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(100 * SECOND);
    r.setKill(true);
    expect(r.timer.isPending(SLUG)).toBe(true);
    await r.w.clock.advance(14_999);
    expect(r.m.stateOf(SLUG)).toBe("running");
    await r.w.clock.advance(1);
    await r.w.clock.advance(2 * SECOND); // let the stop that just began finish
    expect(r.m.stateOf(SLUG)).toBe("none");
  });

  it("on while a tab is open starts nothing", async () => {
    const r = rig({ kill: false });
    await r.start();
    r.open();
    r.setKill(true);
    expect(r.timer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(60 * SECOND);
    expect(r.m.stateOf(SLUG)).toBe("running");
  });

  it("toggling on and off and on again keeps one timer, running from the last switch on", async () => {
    const r = rig({ kill: false });
    await r.start();
    r.setKill(true);
    await r.w.clock.advance(10 * SECOND);
    r.setKill(false);
    r.setKill(true);
    expect(r.timer.pendingCount).toBe(1);
    expect(r.killTimers).toBe(1);
    await r.w.clock.advance(14 * SECOND);
    expect(r.m.stateOf(SLUG)).toBe("running");
    await r.w.clock.advance(SECOND);
    await r.w.clock.advance(2 * SECOND); // let the stop that just began finish
    expect(r.m.stateOf(SLUG)).toBe("none");
  });

  it("deleting the project while a timer is pending cancels it", async () => {
    const r = rig();
    await r.start();
    r.w.projects.delete(SLUG);
    r.timer.evaluate(SLUG);
    expect(r.timer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(60 * SECOND);
    expect(r.stops).toEqual([]);
  });
});

describe("G14 Held", () => {
  it("a Held instance is not stopped at zero sessions with Kill on; releasing it starts the 15 s", async () => {
    const r = rig();
    await r.start();
    r.m.setHeld(SLUG, true, "popped out");
    expect(r.timer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(600 * SECOND);
    expect(r.m.stateOf(SLUG)).toBe("running");
    r.m.setHeld(SLUG, false);
    expect(r.timer.isPending(SLUG)).toBe(true);
    await r.w.clock.advance(15 * SECOND);
    await r.w.clock.advance(2 * SECOND); // let the stop that just began finish
    expect(r.m.stateOf(SLUG)).toBe("none");
  });

  it("holding an instance whose timer is pending cancels the timer", async () => {
    const r = rig();
    await r.start();
    await r.w.clock.advance(10 * SECOND);
    r.m.setHeld(SLUG, true, "popped out");
    expect(r.timer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(60 * SECOND);
    expect(r.stops).toEqual([]);
  });
});

describe("edge cases around the timer", () => {
  it("five rapid open/close cycles of the last tab leave one pending timer, never two, and one stop", async () => {
    const r = rig();
    await r.start();
    for (let i = 0; i < 5; i++) {
      const l = r.open();
      expect(r.timer.pendingCount).toBe(0);
      r.close(l);
      expect(r.timer.pendingCount).toBe(1);
      await r.w.clock.advance(2 * SECOND);
    }
    expect(r.maxPending).toBe(1);
    expect(r.killTimers).toBe(1); // the fake clock's own list: no cancelled timer is left behind
    // The last close was 2 s ago, so 13 s more is the full 15 s.
    await r.w.clock.advance(12_999);
    expect(r.stops).toEqual([]);
    await r.w.clock.advance(1);
    expect(r.stops).toEqual([SLUG]);
    await r.w.clock.advance(60 * SECOND);
    expect(r.stops).toEqual([SLUG]);
  });

  it("repeated events at zero sessions do not restart the timer already running", async () => {
    const r = rig();
    await r.start();
    await r.w.clock.advance(10 * SECOND);
    for (let i = 0; i < 5; i++) {
      r.sessions.refresh();
      r.timer.evaluate(SLUG);
      r.m.setHeld(SLUG, false);
    }
    expect(r.killTimers).toBe(1);
    await r.w.clock.advance(5 * SECOND);
    await r.w.clock.advance(2 * SECOND); // let the stop that just began finish
    expect(r.m.stateOf(SLUG)).toBe("none");
  });

  it("closing the last tab while a Stop is in flight neither throws nor calls stop a second time", async () => {
    const r = rig();
    r.w.nextLeader = { ignoresTerm: true };
    await r.start();
    const l = r.open();
    const stopping = r.m.stop(SLUG); // the user's Stop, held in its 5 s grace by a stubborn child
    await r.w.clock.advance(SECOND);
    expect(r.m.stateOf(SLUG)).toBe("stopping");
    expect(() => r.close(l)).not.toThrow();
    expect(r.timer.isPending(SLUG)).toBe(false);
    await r.w.clock.run(stopping);
    await r.w.clock.advance(60 * SECOND);
    expect(r.stops).toEqual([]); // the timer never called stop
    expect(r.w.signals.filter(([, s]) => s === "SIGTERM")).toHaveLength(1);
    await r.w.clock.advance(2 * SECOND); // let the stop that just began finish
    expect(r.m.stateOf(SLUG)).toBe("none");
  });

  it("a Stop that arrives while the timer is pending cancels the timer, so stop is not called twice", async () => {
    const r = rig();
    await r.start();
    r.close(r.open());
    await r.w.clock.advance(10 * SECOND);
    await r.w.clock.run(r.m.stop(SLUG));
    expect(r.timer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(60 * SECOND);
    expect(r.stops).toEqual([]);
  });

  it("a crash while the timer is pending cancels it: the app is not stopped a second time", async () => {
    const r = rig();
    await r.start();
    r.close(r.open());
    await r.w.clock.advance(5 * SECOND);
    expect(r.timer.isPending(SLUG)).toBe(true);
    r.w.procs = [];
    r.w.children.get(r.w.leaderPid())!.exit(1);
    await r.w.clock.settle();
    await r.w.clock.advance(2 * SECOND); // let the stop that just began finish
    expect(r.m.stateOf(SLUG)).toBe("none");
    expect(r.timer.isPending(SLUG)).toBe(false);
    expect(r.w.clock.pendingTimers).toBe(0);
    await r.w.clock.advance(60 * SECOND);
    expect(r.stops).toEqual([]);
    expect(r.w.signals).toEqual([]);
  });

  it("a start that fails, with no tab ever opened, never arms the timer", async () => {
    const r = rig();
    r.w.nextLeader = { exitsWith: 127 };
    expect((await r.w.clock.run(r.m.open(SLUG))).kind).toBe("failed");
    expect(r.maxPending).toBe(0);
    expect(r.w.clock.pendingTimers).toBe(0);
    await r.w.clock.advance(60 * SECOND);
    expect(r.stops).toEqual([]);
  });

  it("a start cancelled by Stop never arms it either", async () => {
    const r = rig();
    const opening = r.m.open(SLUG);
    await r.w.clock.settle();
    await r.w.clock.run(r.m.stop(SLUG));
    await r.w.clock.run(opening);
    expect(r.maxPending).toBe(0);
    expect(r.timer.pendingCount).toBe(0);
  });

  it("a timer that fires for an app already stopped does nothing (the state is checked again at fire time)", async () => {
    const r = rig();
    await r.start();
    r.close(r.open());
    // The app goes away without any event reaching the timer (as a listener failure would cause).
    r.m.clearListeners();
    await r.w.clock.run(r.m.stop(SLUG));
    await r.w.clock.advance(60 * SECOND);
    expect(r.stops).toEqual([]);
  });
});

describe("F4 no restart, ever", () => {
  it("after a crash, 60 s of fake time spawns nothing and signals nothing", async () => {
    const r = rig();
    await r.start();
    r.open();
    expect(r.w.spawns).toHaveLength(1);
    r.w.procs = [];
    r.w.children.get(r.w.leaderPid())!.exit(1);
    await r.w.clock.settle();
    await r.w.clock.advance(60 * SECOND);
    expect(r.w.spawns).toHaveLength(1);
    await r.w.clock.advance(2 * SECOND); // let the stop that just began finish
    expect(r.m.stateOf(SLUG)).toBe("none");
    expect(r.w.signals).toEqual([]);
  });

  it("after a Stop, and after an auto-stop, 60 s of fake time spawns nothing", async () => {
    const r = rig();
    await r.start();
    await r.w.clock.run(r.m.stop(SLUG));
    await r.w.clock.advance(60 * SECOND);
    expect(r.w.spawns).toHaveLength(1);

    const auto = rig();
    await auto.start();
    await auto.w.clock.advance(15 * SECOND);
    await auto.w.clock.advance(2 * SECOND); // let the stop that just began finish
    expect(auto.m.stateOf(SLUG)).toBe("none");
    await auto.w.clock.advance(60 * SECOND);
    expect(auto.w.spawns).toHaveLength(1);
  });
});

describe("unload", () => {
  it("dispose cancels every timer and drops every listener: no stop fires afterwards", async () => {
    const r = rig();
    await r.start();
    r.close(r.open());
    expect(r.timer.pendingCount).toBe(1);
    expect(r.m.listenerCount).toBeGreaterThan(0);
    r.timer.dispose();
    expect(r.timer.pendingCount).toBe(0);
    await r.w.clock.advance(120 * SECOND);
    expect(r.stops).toEqual([]);
    expect(r.m.stateOf(SLUG)).toBe("running");
    // later events do not arm anything
    r.open();
    r.sessions.refresh();
    r.timer.evaluate(SLUG);
    expect(r.timer.pendingCount).toBe(0);
  });
});
