import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HELD_AUTOMATION_DENIED, HELD_BROWSER_UNREADABLE, HELD_BROWSER_UNSUPPORTED, HELD_OPENED_IN_BROWSER } from "../../src/held";
import { FakeBrowser } from "../browser-fakes";
import { lines, PERMISSION_DENIED, SCRIPT_ERROR } from "../fixtures/osascript-output";
import { Notice, Platform, Setting } from "../obsidian-mock";
import { appTabs, mountTab, openApp, plugin, setWebviewAvailable, SLUG } from "../popout-rig";
import type { Launched } from "../plugin-harness";
import type { FakeWorld } from "../process-fakes";

/**
 * G13 through the real plugin: the real instance manager, session counter, kill timer, browser monitor, poller, hold
 * sequencing, tab view and running list. Faked: processes, lsof and HTTP (as in the other integration tests), the clock,
 * and the three system calls under the browser poll (default browser, running check, osascript). The script text, the
 * parsing of the answer and the URL matching are real.
 *
 * The harness clock stands still between `advance` calls and a poll takes no fake time, so after the pop-out at time P the
 * k-th `advance(5000)` is exactly the k-th poll.
 */

const URL = "http://127.0.0.1:8957/";
const POLL = 5000;
const GRACE = 15_000;
const HOLD = 30_000;

beforeEach(() => {
  Notice.reset();
  Setting.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
  setWebviewAvailable(true);
});
afterEach(() => setWebviewAvailable(false));

type Rig = { w: FakeWorld; l: Launched; browser: FakeBrowser };

/** The app running with a tab, popped out to the browser (so Held, tab closed), and the browser as given. */
async function poppedOut(browser = new FakeBrowser(), projectOver: Parameters<typeof plugin>[0] = {}): Promise<Rig> {
  const { w, l } = await plugin(projectOver, { browser });
  l.tab.display();
  await openApp(w, l);
  await (await mountTab(l)).popOut();
  return { w, l, browser };
}

const row = ({ l }: Rig) => l.rows().map((r) => r.desc);
const state = ({ l }: Rig) => l.plugin.instances.stateOf(SLUG);
const info = ({ l }: Rig) => l.plugin.instances.snapshots()[0];
const stops = ({ w }: Rig) => w.signals.filter(([pid, sig]) => pid < 0 && sig === "SIGTERM").length;

describe("GP6: pop out, the browser tab is seen, then closed", () => {
  it("before the first read: Held with its reason; after the browser lists the tab: 1 browser tab and no Held label", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines() }));
    expect(r.w.external).toEqual([URL]);
    expect(appTabs(r.l)).toEqual([]);
    expect(row(r)).toEqual([expect.stringMatching(/port 8957.*Held: opened in browser, waiting to read its tabs$/)]); // screenshot 1
    expect(r.browser.osascriptCalls).toBe(0);

    r.browser.show(URL, "https://example.com/");
    await r.w.clock.advance(POLL);
    expect(r.browser.osascriptCalls).toBe(1);
    expect(info(r).held).toBe(false);
    expect(row(r)).toEqual([expect.stringMatching(/port 8957.*·  1 browser tab$/)]); // screenshot 2
    expect(row(r)[0]).not.toMatch(/Held/);
    expect(r.l.plugin.browser.tabCount(SLUG)).toBe(1);
    expect(r.w.registry.entries.get(SLUG)).toMatchObject({ browserSessionExpected: true });
    expect(r.w.registry.entries.get(SLUG)?.held).toBeUndefined();
  });

  it("while a tab is listed the app is never signalled, however long; then the tab closes and Stop is called once, 15 s later", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines(URL) }));
    const leader = r.w.leaderPid();
    await r.w.clock.advance(10 * 60_000);
    expect(state(r)).toBe("running");
    expect(r.w.signals).toEqual([]);
    expect(r.l.plugin.killTimer.isPending(SLUG)).toBe(false);

    r.browser.show(); // the tab is closed; the browser stays open
    await r.w.clock.advance(POLL); // the poll that sees it
    expect(r.l.plugin.browser.tabCount(SLUG)).toBe(0);
    expect(row(r)).toEqual([expect.stringMatching(/port 8957.*·  0 tabs$/)]); // screenshot 3: still listed during the grace
    expect(r.l.plugin.killTimer.isPending(SLUG)).toBe(true);

    await r.w.clock.advance(GRACE - 1);
    expect(state(r)).toBe("running");
    expect(stops(r)).toBe(0);
    await r.w.clock.advance(1);
    await r.w.clock.advance(2000);
    expect(r.w.signals[0]).toEqual([-leader, "SIGTERM"]);
    expect(stops(r)).toBe(1);
    expect(state(r)).toBe("none");
    expect(r.w.procs).toEqual([]);
    expect(r.l.rows()).toEqual([]); // screenshot 3: then the list is empty
    expect(r.l.plugin.browser.pollingCount).toBe(0);
  });

  it("a Kill-off project is never stopped when its browser tab closes", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines(URL) }), { killOnClose: false });
    await r.w.clock.advance(POLL);
    r.browser.show();
    await r.w.clock.advance(10 * 60_000);
    expect(state(r)).toBe("running");
    expect(r.w.signals).toEqual([]);
  });
});

describe("Obsidian tabs and browser tabs count together", () => {
  it("one of each reads as both; closing the Obsidian tab leaves the browser tab as the session; closing that stops the app", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines(URL) }));
    await r.l.plugin.openProject(SLUG); // Open on a running app opens a tab (the setting is off)
    await r.w.clock.advance(POLL);
    expect(row(r)).toEqual([expect.stringMatching(/·  1 tab, 1 browser tab$/)]);

    r.l.leaves.splice(0); // the Obsidian tab closes
    r.l.layoutChange();
    expect(r.l.plugin.sessions.count(SLUG)).toBe(0);
    await r.w.clock.advance(5 * 60_000);
    expect(state(r)).toBe("running");
    expect(row(r)).toEqual([expect.stringMatching(/·  1 browser tab$/)]);

    r.browser.show();
    await r.w.clock.advance(POLL + GRACE + 2000);
    expect(state(r)).toBe("none");
    expect(stops(r)).toBe(1);
  });

  it("an Obsidian tab open keeps the app when the browser has none", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines(URL) }));
    await r.l.plugin.openProject(SLUG);
    await r.w.clock.advance(POLL);
    r.browser.show();
    await r.w.clock.advance(5 * 60_000);
    expect(state(r)).toBe("running");
    expect(r.w.signals).toEqual([]);
  });
});

describe("two tabs on the same port, then one closed", () => {
  it("the count goes 2 to 1 and no stop starts", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines(URL, "http://localhost:8957/other") }));
    await r.w.clock.advance(POLL);
    expect(row(r)).toEqual([expect.stringMatching(/·  2 browser tabs$/)]);
    r.browser.show(URL);
    await r.w.clock.advance(POLL);
    expect(row(r)).toEqual([expect.stringMatching(/·  1 browser tab$/)]);
    expect(r.l.plugin.killTimer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(5 * 60_000);
    expect(state(r)).toBe("running");
    expect(r.w.signals).toEqual([]);
  });
});

describe("only tabs of this app on this port count", () => {
  it("a tab on another port, another host, a file or a browser page never matches: the hold ends 30 s after the first read, the grace follows, the app stops", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines("http://127.0.0.1:4317/", "https://example.com:8957/", "file:///Users/dan/index.html", "chrome://newtab/", "http://192.168.1.2:8957/") }));
    await r.w.clock.advance(POLL); // first successful read: the 30 s clock starts
    expect(r.l.plugin.browser.tabCount(SLUG)).toBe(0);
    expect(r.l.plugin.browser.hasHoldTimer(SLUG)).toBe(true);
    expect(info(r).held).toBe(true);

    await r.w.clock.advance(HOLD - 1);
    expect(info(r).held).toBe(true);
    expect(r.l.plugin.killTimer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(1);
    expect(info(r).held).toBe(false);
    expect(r.l.plugin.killTimer.isPending(SLUG)).toBe(true); // E10: unseen, so the grace starts when the hold ends

    await r.w.clock.advance(GRACE - 1);
    expect(state(r)).toBe("running");
    await r.w.clock.advance(1);
    await r.w.clock.advance(2000);
    expect(state(r)).toBe("none");
    expect(stops(r)).toBe(1);
  });

  it("a tab that shows up late, during the 30 s, ends the hold and keeps the app", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines() }));
    await r.w.clock.advance(POLL);
    await r.w.clock.advance(15_000);
    r.browser.show(URL);
    await r.w.clock.advance(POLL);
    expect(info(r).held).toBe(false);
    expect(r.l.plugin.browser.hasHoldTimer(SLUG)).toBe(false);
    await r.w.clock.advance(10 * 60_000);
    expect(state(r)).toBe("running");
    expect(r.w.signals).toEqual([]);
  });
});

describe("E23: a browser that is not running", () => {
  it("before the first read: nothing is sent to it for a long time, the app stays Held on the pop-out reason and is never stopped", async () => {
    const r = await poppedOut(new FakeBrowser({ running: false }));
    await r.w.clock.advance(10 * 60_000);
    expect(r.browser.osascriptCalls).toBe(0);
    expect(r.browser.runningChecks.length).toBeGreaterThan(100);
    expect(info(r)).toMatchObject({ held: true, heldReason: HELD_OPENED_IN_BROWSER });
    expect(state(r)).toBe("running");
    expect(r.w.signals).toEqual([]);
  });

  it("after a tab was seen, the browser quitting counts zero tabs and the app stops 15 s after that poll, with no osascript sent to the quit browser", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines(URL) }));
    await r.w.clock.advance(POLL);
    expect(r.l.plugin.browser.tabCount(SLUG)).toBe(1);
    const calls = r.browser.osascriptCalls;

    r.browser.running = false;
    await r.w.clock.advance(POLL);
    expect(r.l.plugin.browser.tabCount(SLUG)).toBe(0);
    expect(r.l.plugin.killTimer.isPending(SLUG)).toBe(true);
    await r.w.clock.advance(GRACE - 1);
    expect(state(r)).toBe("running");
    await r.w.clock.advance(1);
    await r.w.clock.advance(2000);
    expect(state(r)).toBe("none");
    expect(r.browser.osascriptCalls).toBe(calls);
  });

  it("the browser quits and relaunches between polls: the poll after counts tabs normally and the gap alone does not stop the app", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines(URL) }));
    await r.w.clock.advance(POLL);
    r.browser.running = false;
    await r.w.clock.advance(POLL);
    await r.w.clock.advance(POLL); // 10 s of zero tabs: the grace (15 s) is running
    expect(r.l.plugin.killTimer.isPending(SLUG)).toBe(true);
    r.browser.show(URL); // relaunched, the tab restored
    await r.w.clock.advance(POLL);
    expect(r.l.plugin.browser.tabCount(SLUG)).toBe(1);
    expect(r.l.plugin.killTimer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(10 * 60_000);
    expect(state(r)).toBe("running");
    expect(r.w.signals).toEqual([]);
  });
});

describe("E9: a browser that cannot be read holds the app, never stops it, and Open in browser and Pop out still open the page", () => {
  it.each([
    ["Safari", "com.apple.Safari"],
    ["Firefox", "org.mozilla.firefox"],
    ["Orion", "com.kagi.kagimacOS"],
  ])("%s as the default browser: Held with the reason on the row and in a notice, no osascript, nothing stopped", async (_name, bundleId) => {
    const r = await poppedOut(new FakeBrowser({ bundleId, running: true, answer: lines() }));
    await r.w.clock.advance(POLL);
    expect(info(r)).toMatchObject({ held: true, heldReason: HELD_BROWSER_UNSUPPORTED });
    expect(row(r)).toEqual([expect.stringMatching(/Held: default browser not supported \(Brave, Chrome, Arc or Edge only\), stops only on Stop$/)]);
    expect(Notice.messages.filter((m) => /Brave, Chrome, Arc and Edge/.test(m))).toHaveLength(1);

    await r.w.clock.advance(10 * 60_000);
    expect(r.browser.osascriptCalls).toBe(0);
    expect(r.browser.runningChecks).toEqual([]);
    expect(state(r)).toBe("running");
    expect(r.w.signals).toEqual([]);
    expect(Notice.messages.filter((m) => /Brave, Chrome, Arc and Edge/.test(m))).toHaveLength(1); // said once

    // Pop out and Open in browser still open the page.
    r.w.external.length = 0;
    expect((await r.l.plugin.instances.popOut(SLUG)).kind).toBe("opened");
    await r.l.plugin.manager.setToggle(SLUG, "openInBrowser", true);
    await r.l.plugin.openProject(SLUG);
    expect(r.w.external).toEqual([URL, URL]);
    expect(info(r).heldReason).toBe(HELD_BROWSER_UNSUPPORTED);
  });

  it("the user switches the default browser to a supported one: the next poll reads it and the hold sequencing takes over", async () => {
    const r = await poppedOut(new FakeBrowser({ bundleId: "com.apple.Safari", running: true, answer: lines(URL) }));
    await r.w.clock.advance(POLL);
    expect(info(r).heldReason).toBe(HELD_BROWSER_UNSUPPORTED);
    r.browser.bundleId = "com.google.Chrome";
    await r.w.clock.advance(POLL);
    expect(info(r).held).toBe(false);
    expect(row(r)).toEqual([expect.stringMatching(/·  1 browser tab$/)]);
  });

  it("a permission denied: Held with the denial and a notice; the app is still running", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: PERMISSION_DENIED }));
    await r.w.clock.advance(POLL);
    expect(info(r)).toMatchObject({ held: true, heldReason: HELD_AUTOMATION_DENIED });
    expect(row(r)).toEqual([expect.stringMatching(/Held: browser Automation permission denied, stops only on Stop$/)]); // screenshot 4
    expect(Notice.messages.filter((m) => /Automation/.test(m))).toHaveLength(1);
    expect(state(r)).toBe("running");
    expect(r.w.registry.entries.get(SLUG)).toMatchObject({ held: true, heldReason: HELD_AUTOMATION_DENIED, browserSessionExpected: true });
  });

  it("a denial is permanent: later polls do not retry, even if the answer would now be good, and the reason stays until the app is stopped", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: PERMISSION_DENIED }));
    await r.w.clock.advance(POLL);
    expect(r.browser.osascriptCalls).toBe(1);
    expect(r.l.plugin.browser.isPolling(SLUG)).toBe(false);

    r.browser.show(URL); // the user fixed it in System Settings, but the denial stands for this instance
    await r.w.clock.advance(10 * 60_000);
    expect(r.browser.osascriptCalls).toBe(1);
    expect(info(r)).toMatchObject({ held: true, heldReason: HELD_AUTOMATION_DENIED });
    expect(r.l.plugin.browser.tabCount(SLUG)).toBe(0);
    expect(state(r)).toBe("running");
    expect(r.w.signals).toEqual([]);

    // Popping out again does not bring the poll back or change the reason.
    await r.l.plugin.instances.popOut(SLUG);
    await r.w.clock.advance(10 * 60_000);
    expect(r.browser.osascriptCalls).toBe(1);
    expect(info(r).heldReason).toBe(HELD_AUTOMATION_DENIED);

    await r.w.clock.run(r.l.plugin.stopProject(SLUG));
    expect(state(r)).toBe("none");
    expect(r.l.rows()).toEqual([]);
  });

  it("a revoked permission (the first reads worked): treated as unreadable and permanent, Held, never stopped", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines(URL) }));
    await r.w.clock.advance(POLL);
    expect(info(r).held).toBe(false);
    r.browser.answer = PERMISSION_DENIED;
    await r.w.clock.advance(POLL);
    expect(info(r)).toMatchObject({ held: true, heldReason: HELD_AUTOMATION_DENIED });
    expect(r.l.plugin.browser.tabCount(SLUG)).toBe(0);
    await r.w.clock.advance(10 * 60_000);
    expect(state(r)).toBe("running");
    expect(r.w.signals).toEqual([]);
  });

  it("a read error: Held while unreadable, never stopped; the next good read releases it", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: SCRIPT_ERROR }));
    await r.w.clock.advance(POLL);
    expect(info(r)).toMatchObject({ held: true, heldReason: HELD_BROWSER_UNREADABLE });
    expect(row(r)).toEqual([expect.stringMatching(/Held: could not read the browser's tabs$/)]);
    await r.w.clock.advance(5 * 60_000);
    expect(state(r)).toBe("running");
    expect(r.w.signals).toEqual([]);
    expect(r.browser.osascriptCalls).toBeGreaterThan(10); // errors are retried, unlike a denial

    r.browser.show(URL);
    await r.w.clock.advance(POLL);
    expect(info(r).held).toBe(false);
    expect(row(r)).toEqual([expect.stringMatching(/·  1 browser tab$/)]);
  });
});

describe("Open in browser (the setting) starts the same monitoring", () => {
  it("a cold Open with the setting on: Held, expected, polled, then the tab is seen", async () => {
    const browser = new FakeBrowser({ running: true, answer: lines(URL) });
    const { w, l } = await plugin({ openInBrowser: true }, { browser });
    l.tab.display();
    await openApp(w, l);
    expect(w.external).toEqual([URL]);
    expect(l.plugin.browser.isPolling(SLUG)).toBe(true);
    await w.clock.advance(POLL);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(l.plugin.browser.tabCount(SLUG)).toBe(1);
  });

  it("a plain Open, never opened in the browser: no polling at all and no system call to the browser", async () => {
    const browser = new FakeBrowser({ running: true, answer: lines(URL) });
    const { w, l } = await plugin({}, { browser });
    await openApp(w, l);
    await w.clock.advance(10 * 60_000);
    expect(l.plugin.browser.pollingCount).toBe(0);
    expect(browser.defaultReads).toBe(0);
    expect(browser.runningChecks).toEqual([]);
    expect(browser.osascriptCalls).toBe(0);
  });

  it("a second pop out after the hold ended starts a fresh hold", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines(URL) }));
    await r.w.clock.advance(POLL);
    expect(info(r).held).toBe(false);
    await r.l.plugin.instances.popOut(SLUG);
    expect(info(r)).toMatchObject({ held: true, heldReason: HELD_OPENED_IN_BROWSER });
    await r.w.clock.advance(POLL);
    expect(info(r).held).toBe(false);
  });
});

describe("Stop, unload and a crash cancel the poller and any pending hold or grace timer", () => {
  it("Stop during the 30 s hold: the poller and the hold clock are gone, nothing more is read", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines() }));
    await r.w.clock.advance(POLL);
    expect(r.l.plugin.browser.hasHoldTimer(SLUG)).toBe(true);
    await r.w.clock.run(r.l.plugin.stopProject(SLUG));
    const calls = r.browser.osascriptCalls;
    expect(r.l.plugin.browser.isPolling(SLUG)).toBe(false);
    expect(r.l.plugin.browser.hasHoldTimer(SLUG)).toBe(false);
    await r.w.clock.advance(10 * 60_000);
    expect(r.browser.osascriptCalls).toBe(calls);
    expect(r.w.clock.pendingTimers).toBe(0);
  });

  it("Stop during the 15 s grace: the grace timer is gone and the stop happens once, from the Stop", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines(URL) }));
    await r.w.clock.advance(POLL);
    r.browser.show();
    await r.w.clock.advance(POLL);
    expect(r.l.plugin.killTimer.isPending(SLUG)).toBe(true);
    await r.w.clock.run(r.l.plugin.stopProject(SLUG));
    expect(r.l.plugin.killTimer.isPending(SLUG)).toBe(false);
    await r.w.clock.advance(10 * 60_000);
    expect(stops(r)).toBe(1);
    expect(r.l.plugin.browser.pollingCount).toBe(0);
  });

  it("the app crashing: polling and the hold clock end with the instance", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines() }));
    await r.w.clock.advance(POLL);
    expect(r.l.plugin.browser.hasHoldTimer(SLUG)).toBe(true);
    r.w.procs = [];
    r.w.children.get(r.w.leaderPid())!.exit(1);
    await r.w.clock.settle();
    expect(state(r)).toBe("none");
    expect(r.l.plugin.browser.isPolling(SLUG)).toBe(false);
    expect(r.l.plugin.browser.hasHoldTimer(SLUG)).toBe(false);
    const calls = r.browser.osascriptCalls;
    await r.w.clock.advance(10 * 60_000);
    expect(r.browser.osascriptCalls).toBe(calls);
    expect(r.w.clock.pendingTimers).toBe(0);
  });

  it("plugin unload: polling and timers stop, the app keeps running, and the registry entry is left exactly as it was", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true, answer: lines() }));
    await r.w.clock.advance(POLL);
    const entry = JSON.stringify(r.w.registry.entries.get(SLUG));
    const writes = r.w.registry.sets;
    const calls = r.browser.osascriptCalls;
    r.l.plugin.onunload();
    expect(r.l.plugin.browser.pollingCount).toBe(0);
    await r.w.clock.advance(10 * 60_000);
    expect(r.browser.osascriptCalls).toBe(calls);
    expect(r.w.signals).toEqual([]);
    expect(r.w.procs.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.w.registry.entries.get(SLUG))).toBe(entry);
    expect(r.w.registry.sets).toBe(writes);
  });

  it("an unload during a slow osascript drops its answer", async () => {
    const r = await poppedOut(new FakeBrowser({ running: true }));
    let release!: (v: ReturnType<typeof lines>) => void;
    r.browser.answer = () => new Promise((resolve) => (release = resolve));
    await r.w.clock.advance(POLL);
    r.l.plugin.onunload();
    release(lines(URL));
    await r.w.clock.advance(10 * 60_000);
    expect(r.l.plugin.browser.tabCount(SLUG)).toBe(0);
    expect(r.w.signals).toEqual([]);
  });
});
