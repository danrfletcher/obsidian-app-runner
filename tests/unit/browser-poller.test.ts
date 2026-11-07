import { describe, expect, it } from "vitest";
import { BROWSER_POLL_MS, BrowserPoller, readBrowserTabs, type BrowserReadResult } from "../../src/browser-poller";
import { FakeBrowser } from "../browser-fakes";
import { FakeClock } from "../fake-clock";
import { APP_NOT_RUNNING, lines, NO_OUTPUT, NO_TABS, PERMISSION_DENIED, SCRIPT_ERROR, TABS_PER_BROWSER, TIMED_OUT } from "../fixtures/osascript-output";

/**
 * The poll with a fake clock, a fake process check and a fake osascript runner. Only those three are faked: the script,
 * the parsing of what comes back, the URL matching and the result classification are the real code.
 */

const PORT = 8957;

describe("readBrowserTabs: one look", () => {
  it.each([
    ["brave", "com.brave.Browser", 1],
    ["chrome", "com.google.Chrome", 1],
    ["arc", "company.thebrowser.Browser", 1],
    ["edge", "com.microsoft.edgemac", 1],
  ] as const)("%s: counts the tabs on the port from that browser's canned listing, and asks only that browser", async (id, bundleId, expected) => {
    const b = new FakeBrowser({ bundleId, running: true, answer: TABS_PER_BROWSER[id] });
    expect(await readBrowserTabs(b.deps(), PORT)).toEqual({ kind: "tabs", count: expected });
    expect(b.runningChecks).toEqual([bundleId]);
    expect(b.scripts).toHaveLength(1);
  });

  it("an empty listing is zero tabs", async () => {
    for (const answer of [NO_TABS, NO_OUTPUT, lines()]) {
      const b = new FakeBrowser({ running: true, answer });
      expect(await readBrowserTabs(b.deps(), PORT)).toEqual({ kind: "tabs", count: 0 });
    }
  });

  it("E23: the browser is not running: no AppleScript is sent, and the result is not-running", async () => {
    const b = new FakeBrowser({ running: false });
    expect(await readBrowserTabs(b.deps(), PORT)).toEqual({ kind: "not-running" });
    expect(b.runningChecks).toEqual(["com.brave.Browser"]);
    expect(b.osascriptCalls).toBe(0);
  });

  it("E9: an unsupported default browser is reported by bundle id, and neither the process check nor osascript is used", async () => {
    for (const bundleId of ["com.apple.Safari", "org.mozilla.firefox", "com.kagi.kagimacOS", "com.example.unknown"]) {
      const b = new FakeBrowser({ bundleId, running: true });
      expect(await readBrowserTabs(b.deps(), PORT)).toEqual({ kind: "unsupported", bundleId });
      expect(b.runningChecks).toEqual([]);
      expect(b.osascriptCalls).toBe(0);
    }
  });

  it("E9: a refused permission is denied, with the browser's app name", async () => {
    const b = new FakeBrowser({ running: true, answer: PERMISSION_DENIED });
    expect(await readBrowserTabs(b.deps(), PORT)).toEqual({ kind: "denied", appName: "Brave Browser" });
  });

  it("E9: any other osascript failure is an error with its first line", async () => {
    const b = new FakeBrowser({ running: true, answer: SCRIPT_ERROR });
    expect(await readBrowserTabs(b.deps(), PORT)).toEqual({ kind: "error", message: SCRIPT_ERROR.stderr.trim() });
    b.answer = TIMED_OUT;
    expect(await readBrowserTabs(b.deps(), PORT)).toEqual({ kind: "error", message: "osascript timed out" });
  });

  it("the browser quitting between the check and the call is not running, not an error", async () => {
    const b = new FakeBrowser({ running: true, answer: APP_NOT_RUNNING });
    expect(await readBrowserTabs(b.deps(), PORT)).toEqual({ kind: "not-running" });
  });

  it("E9: a failure to read the default browser, or a runner that throws, is an error result, never an exception", async () => {
    const a = new FakeBrowser({ running: true });
    a.defaultError = new Error("plutil failed");
    expect(await readBrowserTabs(a.deps(), PORT)).toEqual({ kind: "error", message: "plutil failed" });

    const b = new FakeBrowser({ running: true });
    b.answer = () => {
      throw new Error("spawn EAGAIN");
    };
    expect(await readBrowserTabs(b.deps(), PORT)).toEqual({ kind: "error", message: "spawn EAGAIN" });
  });

  it("the script sent is the fixed one for the default browser", async () => {
    const b = new FakeBrowser({ bundleId: "com.microsoft.edgemac", running: true });
    await readBrowserTabs(b.deps(), PORT);
    expect(b.scripts[0].filter((_, i) => i % 2 === 0)).toEqual(Array(11).fill("-e"));
    expect(b.scripts[0].join("\n")).toContain('tell application "Microsoft Edge"');
    expect(b.scripts[0].join("\n")).not.toContain("Brave");
  });
});

function rig(over: { read?: (slug: string) => Promise<BrowserReadResult | null> } = {}) {
  const clock = new FakeClock();
  const browser = new FakeBrowser({ running: true, answer: lines("http://127.0.0.1:8957/") });
  const results: Array<[string, BrowserReadResult]> = [];
  const poller = new BrowserPoller({
    clock,
    read: over.read ?? ((slug) => (slug === "none" ? Promise.resolve(null) : readBrowserTabs(browser.deps(), PORT))),
    onResult: (slug, r) => void results.push([slug, r]),
  });
  return { clock, browser, results, poller };
}

describe("the 5 s cadence", () => {
  it("the interval is 5 s", () => {
    expect(BROWSER_POLL_MS).toBe(5000);
  });

  it("nothing is read before 5 s, one look at 5 s, and one more every 5 s after", async () => {
    const { clock, browser, poller, results } = rig();
    poller.start("live-captions");
    await clock.advance(4999);
    expect(browser.osascriptCalls).toBe(0);
    await clock.advance(1);
    expect(browser.osascriptCalls).toBe(1);
    await clock.advance(5000);
    expect(browser.osascriptCalls).toBe(2);
    await clock.advance(10_000);
    expect(browser.osascriptCalls).toBe(4);
    expect(results.map(([, r]) => r)).toEqual(Array(4).fill({ kind: "tabs", count: 1 }));
  });

  it("starting a project twice keeps one timer", async () => {
    const { clock, browser, poller } = rig();
    poller.start("a");
    poller.start("a");
    await clock.advance(5000);
    expect(browser.osascriptCalls).toBe(1);
    expect(poller.watchedCount).toBe(1);
  });

  it("E23: the browser not running for a whole minute: twelve looks, zero osascript calls, twelve not-running results", async () => {
    const { clock, browser, poller, results } = rig();
    browser.running = false;
    poller.start("a");
    await clock.advance(60_000);
    expect(browser.runningChecks).toHaveLength(12);
    expect(browser.osascriptCalls).toBe(0);
    expect(results).toHaveLength(12);
    expect(results.every(([, r]) => r.kind === "not-running")).toBe(true);
  });

  it("a read that has nothing to look for yet (null) is skipped, and polling goes on", async () => {
    const { clock, poller, results, browser } = rig();
    poller.start("none");
    await clock.advance(20_000);
    expect(results).toEqual([]);
    expect(browser.osascriptCalls).toBe(0);
    expect(poller.isWatching("none")).toBe(true);
  });

  it("a read that throws becomes an error result and polling goes on", async () => {
    let n = 0;
    const { clock, poller, results } = rig({
      read: async () => {
        if (++n === 1) throw new Error("boom");
        return { kind: "tabs", count: 0 };
      },
    });
    poller.start("a");
    await clock.advance(10_000);
    expect(results.map(([, r]) => r)).toEqual([{ kind: "error", message: "boom" }, { kind: "tabs", count: 0 }]);
  });

  it("a result listener that throws does not end the poll", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const poller = new BrowserPoller({
      clock,
      read: async () => ({ kind: "tabs", count: 0 }),
      onResult: () => {
        calls++;
        throw new Error("listener failed");
      },
    });
    poller.start("a");
    await clock.advance(15_000);
    expect(calls).toBe(3);
  });
});

describe("polls never overlap", () => {
  it("a slow osascript (over 5 s) delays the next poll instead of stacking another", async () => {
    const { clock, browser, poller, results } = rig();
    let release!: (r: ReturnType<typeof lines>) => void;
    browser.answer = () => new Promise((resolve) => (release = resolve));
    poller.start("a");
    await clock.advance(5000);
    expect(browser.osascriptCalls).toBe(1);

    await clock.advance(60_000); // twelve intervals pass while the first look is still waiting
    expect(browser.osascriptCalls).toBe(1);
    expect(results).toEqual([]);

    browser.answer = lines("http://127.0.0.1:8957/");
    release(lines());
    await clock.settle();
    expect(results.map(([, r]) => r)).toEqual([{ kind: "tabs", count: 0 }]);
    expect(browser.osascriptCalls).toBe(1); // the next look is 5 s after this one finished, not at once

    await clock.advance(4999);
    expect(browser.osascriptCalls).toBe(1);
    await clock.advance(1);
    expect(browser.osascriptCalls).toBe(2);
    expect(results.at(-1)![1]).toEqual({ kind: "tabs", count: 1 });
  });

  it("pollNow while a look is running joins it: one osascript call, one result", async () => {
    const { clock, browser, poller, results } = rig();
    let release!: (r: ReturnType<typeof lines>) => void;
    browser.answer = () => new Promise((resolve) => (release = resolve));
    poller.start("a");
    await clock.advance(5000);
    const a = poller.pollNow("a");
    const b = poller.pollNow("a");
    expect(browser.osascriptCalls).toBe(1);
    release(lines("http://localhost:8957/"));
    await Promise.all([a, b]);
    expect(results).toHaveLength(1);
  });

  it("pollNow looks at once, replaces the waiting timer, and the cadence carries on 5 s after it", async () => {
    const { clock, browser, poller, results } = rig();
    poller.start("a");
    await clock.advance(3000);
    await poller.pollNow("a");
    expect(browser.osascriptCalls).toBe(1);
    expect(results).toHaveLength(1);
    await clock.advance(4999);
    expect(browser.osascriptCalls).toBe(1); // the old timer (due at 5 s) is gone
    await clock.advance(1);
    expect(browser.osascriptCalls).toBe(2);
  });

  it("pollNow on a project that is not watched does nothing", async () => {
    const { poller, browser } = rig();
    await poller.pollNow("a");
    expect(browser.osascriptCalls).toBe(0);
  });
});

describe("stop and dispose", () => {
  it("stop cancels the timer: nothing is read afterwards", async () => {
    const { clock, browser, poller } = rig();
    poller.start("a");
    await clock.advance(5000);
    poller.stop("a");
    expect(clock.pendingTimers).toBe(0);
    await clock.advance(60_000);
    expect(browser.osascriptCalls).toBe(1);
    expect(poller.isWatching("a")).toBe(false);
  });

  it("stop while a look is running drops its result and schedules nothing", async () => {
    const { clock, browser, poller, results } = rig();
    let release!: (r: ReturnType<typeof lines>) => void;
    browser.answer = () => new Promise((resolve) => (release = resolve));
    poller.start("a");
    await clock.advance(5000);
    poller.stop("a");
    release(lines("http://127.0.0.1:8957/"));
    await clock.advance(60_000);
    expect(results).toEqual([]);
    expect(clock.pendingTimers).toBe(0);
    expect(browser.osascriptCalls).toBe(1);
  });

  it("a project stopped and started again during a look gets only its own results", async () => {
    const { clock, browser, poller, results } = rig();
    let release!: (r: ReturnType<typeof lines>) => void;
    browser.answer = () => new Promise((resolve) => (release = resolve));
    poller.start("a");
    await clock.advance(5000);
    poller.stop("a");
    poller.start("a");
    release(lines("http://127.0.0.1:8957/")); // the old look's answer
    await clock.settle();
    expect(results).toEqual([]);
    expect(poller.isWatching("a")).toBe(true);
  });

  it("dispose cancels every timer and later starts do nothing", async () => {
    const { clock, browser, poller } = rig();
    poller.start("a");
    poller.start("b");
    poller.dispose();
    expect(clock.pendingTimers).toBe(0);
    poller.start("c");
    await clock.advance(60_000);
    expect(browser.osascriptCalls).toBe(0);
    expect(poller.watchedCount).toBe(0);
  });
});
