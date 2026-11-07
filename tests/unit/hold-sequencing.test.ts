import { describe, expect, it } from "vitest";
import type { BrowserReadResult } from "../../src/browser-poller";
import { HELD_AUTOMATION_DENIED, HELD_BROWSER_UNREADABLE, HELD_BROWSER_UNSUPPORTED, HELD_OPENED_IN_BROWSER } from "../../src/held";
import { HOLD_MS, HoldSequencer } from "../../src/hold-sequencing";
import { FakeClock } from "../fake-clock";

/** G12, G13: the 30 s hold clock starts at the first successful tab read; a seen tab ends the hold; a denial holds for good. */

const tabs = (count: number): BrowserReadResult => ({ kind: "tabs", count });
const NOT_RUNNING: BrowserReadResult = { kind: "not-running" };
const DENIED: BrowserReadResult = { kind: "denied", appName: "Brave Browser" };
const UNSUPPORTED: BrowserReadResult = { kind: "unsupported", bundleId: "com.apple.Safari" };
const ERROR: BrowserReadResult = { kind: "error", message: "boom" };

function rig(initial: ConstructorParameters<typeof HoldSequencer>[1] = { holding: true }) {
  const clock = new FakeClock();
  const changes: Array<string | null> = [];
  const seq: HoldSequencer = new HoldSequencer({ clock, onChange: () => void changes.push(seq.heldReason) }, initial);
  return { clock, seq, changes };
}

describe("the hold clock starts at the first successful read", () => {
  it("the hold is 30 s", () => {
    expect(HOLD_MS).toBe(30_000);
  });

  it("opened in the browser: Held, phase pending, no timer, until a poll reads", () => {
    const { seq, clock } = rig();
    expect(seq.holdPhase).toBe("pending");
    expect(seq.heldReason).toBe(HELD_OPENED_IN_BROWSER);
    expect(seq.hasPendingTimer).toBe(false);
    expect(clock.pendingTimers).toBe(0);
  });

  it("a browser that is not running is not a read: a minute of those starts no clock and the hold stays", async () => {
    const { seq, clock } = rig();
    for (let i = 0; i < 12; i++) {
      seq.apply(NOT_RUNNING);
      await clock.advance(5000);
    }
    expect(seq.holdPhase).toBe("pending");
    expect(seq.heldReason).toBe(HELD_OPENED_IN_BROWSER);
    expect(seq.hasPendingTimer).toBe(false);
  });

  it("unreadable results (unsupported, error) are not reads either", async () => {
    const { seq, clock } = rig();
    seq.apply(UNSUPPORTED);
    seq.apply(ERROR);
    await clock.advance(5 * 60_000);
    expect(seq.holdPhase).toBe("pending");
    expect(seq.hasPendingTimer).toBe(false);
  });

  it("the first successful read with no tab seen starts a 30 s clock, and Held holds until it runs out", async () => {
    const { seq, clock, changes } = rig();
    await clock.advance(17_000); // time before the first read counts for nothing
    seq.apply(tabs(0));
    expect(seq.holdPhase).toBe("timing");
    expect(seq.heldReason).toBe(HELD_OPENED_IN_BROWSER);
    expect(seq.hasPendingTimer).toBe(true);

    await clock.advance(29_999);
    expect(seq.heldReason).toBe(HELD_OPENED_IN_BROWSER);
    await clock.advance(1);
    expect(seq.holdPhase).toBe("over");
    expect(seq.heldReason).toBeNull();
    expect(seq.hasPendingTimer).toBe(false);
    expect(changes.at(-1)).toBeNull(); // the owner heard about it, so Held clears and the 15 s grace can start
  });

  it("more empty reads during the 30 s do not restart the clock", async () => {
    const { seq, clock } = rig();
    seq.apply(tabs(0));
    await clock.advance(20_000);
    seq.apply(tabs(0));
    await clock.advance(10_000);
    expect(seq.holdPhase).toBe("over");
  });
});

describe("a seen tab ends the hold", () => {
  it("on the first read: no clock is left and Held clears at once", () => {
    const { seq, clock, changes } = rig();
    seq.apply(tabs(1));
    expect(seq.holdPhase).toBe("over");
    expect(seq.heldReason).toBeNull();
    expect(seq.tabs).toBe(1);
    expect(clock.pendingTimers).toBe(0);
    expect(changes).toEqual([null]);
  });

  it("during the 30 s: the clock is cancelled", async () => {
    const { seq, clock } = rig();
    seq.apply(tabs(0));
    await clock.advance(10_000);
    seq.apply(tabs(2));
    expect(seq.holdPhase).toBe("over");
    expect(seq.hasPendingTimer).toBe(false);
    expect(clock.pendingTimers).toBe(0);
  });

  it("once over, the tab closing leaves the hold over: no second hold, the count just drops", async () => {
    const { seq } = rig();
    seq.apply(tabs(1));
    seq.apply(tabs(0));
    expect(seq.holdPhase).toBe("over");
    expect(seq.heldReason).toBeNull();
    expect(seq.tabs).toBe(0);
  });

  it("two tabs, then one closed: the count is 1", () => {
    const { seq } = rig();
    seq.apply(tabs(2));
    seq.apply(tabs(1));
    expect(seq.tabs).toBe(1);
    expect(seq.heldReason).toBeNull();
  });

  it("the browser quitting counts zero tabs, without a hold", () => {
    const { seq } = rig();
    seq.apply(tabs(1));
    seq.apply(NOT_RUNNING);
    expect(seq.tabs).toBe(0);
    expect(seq.heldReason).toBeNull();
  });

  it("the browser quitting and coming back: tabs are counted normally again", () => {
    const { seq } = rig();
    seq.apply(tabs(1));
    seq.apply(NOT_RUNNING);
    seq.apply(tabs(1));
    expect(seq.tabs).toBe(1);
    expect(seq.holdPhase).toBe("over");
  });
});

describe("a browser that cannot be read holds the app and shows why", () => {
  it("unsupported: Held with that reason, zero tabs; a later successful read clears it", () => {
    const { seq } = rig({ holding: false });
    seq.apply(UNSUPPORTED);
    expect(seq.heldReason).toBe(HELD_BROWSER_UNSUPPORTED);
    expect(seq.tabs).toBe(0);
    seq.apply(tabs(1)); // the user switched the default browser
    expect(seq.heldReason).toBeNull();
    expect(seq.tabs).toBe(1);
  });

  it("a read error: Held with that reason; the next good read clears it", () => {
    const { seq } = rig({ holding: false });
    seq.apply(tabs(1));
    seq.apply(ERROR);
    expect(seq.heldReason).toBe(HELD_BROWSER_UNREADABLE);
    expect(seq.tabs).toBe(0);
    seq.apply(tabs(1));
    expect(seq.heldReason).toBeNull();
  });

  it("a problem takes the place of the pop-out reason while it lasts, and the pop-out hold is still there after it", () => {
    const { seq } = rig();
    seq.apply(ERROR);
    expect(seq.heldReason).toBe(HELD_BROWSER_UNREADABLE);
    seq.apply(NOT_RUNNING);
    expect(seq.heldReason).toBe(HELD_OPENED_IN_BROWSER);
  });

  it("an error while the 30 s clock runs does not stop it", async () => {
    const { seq, clock } = rig();
    seq.apply(tabs(0));
    await clock.advance(10_000);
    seq.apply(ERROR);
    await clock.advance(20_000);
    expect(seq.holdPhase).toBe("over");
    expect(seq.heldReason).toBe(HELD_BROWSER_UNREADABLE); // still unreadable, so still Held and never stopped
    seq.apply(tabs(0));
    expect(seq.heldReason).toBeNull(); // readable and unseen: the grace may begin
  });
});

describe("a denied permission holds permanently", () => {
  it("Held with the denial; zero tabs", () => {
    const { seq } = rig();
    seq.apply(DENIED);
    expect(seq.denied).toBe(true);
    expect(seq.heldReason).toBe(HELD_AUTOMATION_DENIED);
    expect(seq.tabs).toBe(0);
  });

  it("nothing after it changes the reason: not a good read, a seen tab, the 30 s clock or a fresh hold", async () => {
    const { seq, clock } = rig();
    seq.apply(DENIED);
    seq.apply(tabs(3));
    seq.apply(NOT_RUNNING);
    seq.apply(ERROR);
    seq.apply(UNSUPPORTED);
    seq.begin();
    await clock.advance(10 * 60_000);
    expect(seq.heldReason).toBe(HELD_AUTOMATION_DENIED);
    expect(seq.tabs).toBe(0);
    expect(seq.denied).toBe(true);
  });

  it("a denial recorded in the registry is still in force after a relaunch", () => {
    const { seq } = rig({ holding: true, problem: HELD_AUTOMATION_DENIED });
    expect(seq.denied).toBe(true);
    seq.apply(tabs(1));
    expect(seq.heldReason).toBe(HELD_AUTOMATION_DENIED);
  });

  it("an unknown reason carried over is not a problem", () => {
    const { seq } = rig({ holding: true, problem: "something-else" });
    expect(seq.problemReason).toBeNull();
    expect(seq.heldReason).toBe(HELD_OPENED_IN_BROWSER);
  });
});

describe("a fresh hold and the end of the sequencer", () => {
  it("opening in the browser again after the hold ended starts a new hold with no clock until the next read", async () => {
    const { seq, clock, changes } = rig();
    seq.apply(tabs(1));
    seq.begin();
    expect(seq.holdPhase).toBe("pending");
    expect(seq.heldReason).toBe(HELD_OPENED_IN_BROWSER);
    expect(changes.at(-1)).toBe(HELD_OPENED_IN_BROWSER);
    await clock.advance(5 * 60_000);
    expect(seq.holdPhase).toBe("pending");
  });

  it("begin during the 30 s clock cancels it", () => {
    const { seq, clock } = rig();
    seq.apply(tabs(0));
    seq.begin();
    expect(clock.pendingTimers).toBe(0);
  });

  it("relaunched without a hold in progress (the entry was not Held): the hold is over", () => {
    const { seq } = rig({ holding: false });
    expect(seq.holdPhase).toBe("over");
    expect(seq.heldReason).toBeNull();
  });

  it("dispose cancels the clock; nothing is reported afterwards", async () => {
    const { seq, clock, changes } = rig();
    seq.apply(tabs(0));
    const heard = changes.length;
    seq.dispose();
    expect(clock.pendingTimers).toBe(0);
    seq.apply(tabs(1));
    seq.begin();
    await clock.advance(60_000);
    expect(changes).toHaveLength(heard);
  });
});
