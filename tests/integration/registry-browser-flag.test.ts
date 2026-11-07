import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HELD_AUTOMATION_DENIED, HELD_OPENED_IN_BROWSER } from "../../src/held";
import { Registry } from "../../src/registry";
import { registryPath } from "../../src/runtime-paths";
import { FakeBrowser } from "../browser-fakes";
import { lines, PERMISSION_DENIED } from "../fixtures/osascript-output";
import { Notice, Platform, Setting } from "../obsidian-mock";
import { launch } from "../plugin-harness";
import { mountTab, openAppRealIo, setWebviewAvailable, SLUG } from "../popout-rig";
import { FakeWorld, project } from "../process-fakes";

/**
 * G13, G10: the browser-session-expected flag through a real registry file in a temp runtime directory, and the browser
 * poll resuming at relaunch before any stop decision. Processes and the browser are fakes; the registry file is real.
 */

const URL = "http://127.0.0.1:8957/";
const POLL = 5000;
const GRACE = 15_000;

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "app-runner-browser-flag-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const freshRuntime = () => {
  const dir = path.join(tmp, `rt${n++}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};
const readFile = (runtime: string) => JSON.parse(fs.readFileSync(registryPath(runtime), "utf8")) as { version: number; entries: Record<string, Record<string, unknown>> };

beforeEach(() => {
  Notice.reset();
  Setting.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
  setWebviewAvailable(true);
});
afterEach(() => setWebviewAvailable(false));

/** Session one: the app is opened (popped out to the browser, or just opened), the browser as given, then Obsidian quits. */
async function firstSession(runtime: string, how: "popout" | "plain", browser: FakeBrowser, afterOpen?: (w: FakeWorld) => Promise<void>) {
  const w = new FakeWorld(project());
  const registry = new Registry(registryPath(runtime));
  const l = await launch(w, { registry, runtimeDir: runtime, browser });
  await openAppRealIo(w, l);
  if (how === "popout") await (await mountTab(l)).popOut();
  await w.clock.settle();
  await afterOpen?.(w);
  await registry.read(); // reads are queued behind writes: when it answers, the file is on disk
  l.plugin.onunload();
  Notice.reset();
  return { w, pid: w.leaderPid() };
}

/** The stop of an adopted app finishes through real file I/O as well as fake timers: drive both until it is gone. */
async function untilGone(w: FakeWorld, l: Awaited<ReturnType<typeof launch>>): Promise<void> {
  for (let i = 0; i < 200 && l.plugin.instances.stateOf(SLUG) !== "none"; i++) {
    await w.clock.advance(1000);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const relaunch = (w: FakeWorld, runtime: string, browser: FakeBrowser) => launch(w, { registry: new Registry(registryPath(runtime)), runtimeDir: runtime, browser });

describe("the flag round-trips through running.json", () => {
  it("opened in the browser: the file holds browserSessionExpected true and a fresh Registry reads it back", async () => {
    const runtime = freshRuntime();
    await firstSession(runtime, "popout", new FakeBrowser());
    expect(readFile(runtime).entries[SLUG]).toMatchObject({ browserSessionExpected: true, held: true, heldReason: HELD_OPENED_IN_BROWSER });
    const read = await new Registry(registryPath(runtime)).read();
    expect(read.entries[SLUG].browserSessionExpected).toBe(true);
  });

  it("an app never opened in the browser: the file holds false, and a fresh Registry reads false", async () => {
    const runtime = freshRuntime();
    await firstSession(runtime, "plain", new FakeBrowser());
    expect(readFile(runtime).entries[SLUG].browserSessionExpected).toBe(false);
    expect((await new Registry(registryPath(runtime)).read()).entries[SLUG].browserSessionExpected).toBe(false);
  });

  it("the flag stays set after the hold ends and the tab is seen (it is persisted for the life of the app)", async () => {
    const runtime = freshRuntime();
    const browser = new FakeBrowser({ running: true, answer: lines(URL) });
    await firstSession(runtime, "popout", browser, (w) => w.clock.advance(POLL));
    const entry = readFile(runtime).entries[SLUG];
    expect(entry.browserSessionExpected).toBe(true);
    expect(entry.held).toBeUndefined(); // the hold ended when the tab was seen
  });

  it("a stored entry whose flag is not the boolean true reads as false", async () => {
    const runtime = freshRuntime();
    const base = { slug: "a", pid: 4100, pgid: 4100, members: [{ pid: 4100, startTime: "x" }], port: 4317, startedAt: 1 };
    fs.writeFileSync(registryPath(runtime), JSON.stringify({ version: 1, entries: { a: { ...base, browserSessionExpected: "yes" }, b: { ...base, slug: "b" } } }));
    const { entries } = await new Registry(registryPath(runtime)).read();
    expect(entries.a.browserSessionExpected).toBe(false);
    expect(entries.b.browserSessionExpected).toBe(false);
  });
});

describe("Obsidian quits: polling stops with it, and the file is untouched", () => {
  it("nothing is read after the unload and the registry bytes do not change", async () => {
    const runtime = freshRuntime();
    const browser = new FakeBrowser({ running: true, answer: lines(URL) });
    const { w } = await firstSession(runtime, "popout", browser, (w) => w.clock.advance(POLL));
    const bytes = fs.readFileSync(registryPath(runtime));
    const calls = browser.osascriptCalls;
    await w.clock.advance(10 * 60_000);
    expect(browser.osascriptCalls).toBe(calls);
    expect(fs.readFileSync(registryPath(runtime)).equals(bytes)).toBe(true);
    expect(w.signals).toEqual([]);
  });
});

describe("polling resumes at relaunch before any stop decision (G10)", () => {
  it("the browser tab is still open: it is read at layout ready, before the 15 s decision, and the app is neither stopped nor named as stopped", async () => {
    const runtime = freshRuntime();
    const { w, pid } = await firstSession(runtime, "popout", new FakeBrowser({ running: true, answer: lines(URL) }), (w) => w.clock.advance(POLL));

    const browser = new FakeBrowser({ running: true, answer: lines(URL) });
    const l = await relaunch(w, runtime, browser);
    expect(l.plugin.instances.isAdopted(SLUG)).toBe(true);
    expect(l.plugin.instances.browserSessionExpected(SLUG)).toBe(true);
    expect(l.plugin.browser.isPolling(SLUG)).toBe(true); // polling is on again from the moment the app is adopted
    expect(browser.osascriptCalls).toBe(0);
    expect(l.plugin.killTimer.isPending(SLUG)).toBe(false); // the adoption decision is still to be made

    l.layoutReady();
    await w.clock.settle();
    expect(browser.osascriptCalls).toBe(1); // read at once, not 5 s later
    expect(l.plugin.browser.tabCount(SLUG)).toBe(1);

    await w.clock.advance(GRACE + 1000);
    expect(w.signals).toEqual([]);
    expect(w.procs.some((p) => p.pid === pid)).toBe(true);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(Notice.messages.join("\n")).not.toMatch(/stopped/i);
    l.tab.display();
    expect(l.rows()[0].desc).toMatch(/·  1 browser tab/);

    expect(browser.osascriptCalls).toBeGreaterThan(2); // and the 5 s cadence goes on
    await w.clock.advance(10 * 60_000);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.signals).toEqual([]);
  });

  it("the browser tab was closed while Obsidian was away: the app is stopped 15 s after layout ready, and only after the browser was read", async () => {
    const runtime = freshRuntime();
    const { w } = await firstSession(runtime, "popout", new FakeBrowser({ running: true, answer: lines(URL) }), (w) => w.clock.advance(POLL));

    const browser = new FakeBrowser({ running: true, answer: lines() });
    const l = await relaunch(w, runtime, browser);
    l.layoutReady();
    await w.clock.settle();
    expect(browser.osascriptCalls).toBe(1);
    expect(w.signals).toEqual([]);

    await w.clock.advance(GRACE - 1000);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    await w.clock.advance(1000);
    expect(w.signals.length).toBeGreaterThan(0); // the stop has begun, 15 s after layout ready
    await untilGone(w, l);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("none");
    expect(w.procs).toEqual([]);
    expect(Notice.messages.join("\n")).toMatch(/Live Captions was left running with no tab open, so it was stopped/);
  });

  it("the browser is not running at relaunch (hold already ended): no AppleScript, zero tabs, stopped after the 15 s", async () => {
    const runtime = freshRuntime();
    const { w } = await firstSession(runtime, "popout", new FakeBrowser({ running: true, answer: lines(URL) }), (w) => w.clock.advance(POLL));
    const browser = new FakeBrowser({ running: false });
    const l = await relaunch(w, runtime, browser);
    l.layoutReady();
    await w.clock.settle();
    expect(browser.runningChecks.length).toBeGreaterThanOrEqual(1);
    expect(browser.osascriptCalls).toBe(0);
    await w.clock.advance(GRACE);
    await untilGone(w, l);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("none");
  });

  it("an Obsidian tab restored at relaunch keeps the app even with no browser tab", async () => {
    const runtime = freshRuntime();
    const { w } = await firstSession(runtime, "popout", new FakeBrowser({ running: true, answer: lines(URL) }), (w) => w.clock.advance(POLL));
    const l = await launch(w, { registry: new Registry(registryPath(runtime)), runtimeDir: runtime, browser: new FakeBrowser({ running: false }), restoredTabs: [SLUG] });
    l.layoutReady();
    await w.clock.advance(10 * 60_000);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.signals).toEqual([]);
  });

  it("the hold was still in progress at quit: the relaunch read sees the tab and ends it", async () => {
    const runtime = freshRuntime();
    const { w } = await firstSession(runtime, "popout", new FakeBrowser({ running: false }));
    expect(readFile(runtime).entries[SLUG]).toMatchObject({ held: true, heldReason: HELD_OPENED_IN_BROWSER, browserSessionExpected: true });

    const browser = new FakeBrowser({ running: true, answer: lines(URL) });
    const l = await relaunch(w, runtime, browser);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
    l.layoutReady();
    await w.clock.settle();
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(l.plugin.browser.tabCount(SLUG)).toBe(1);
    await w.clock.advance(10 * 60_000);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect((await new Registry(registryPath(runtime)).read()).entries[SLUG].held).toBeUndefined();
  });

  it("a denied permission is still in force after a relaunch: Held with the denial, nothing is read, nothing is stopped", async () => {
    const runtime = freshRuntime();
    const { w } = await firstSession(runtime, "popout", new FakeBrowser({ running: true, answer: PERMISSION_DENIED }), (w) => w.clock.advance(POLL));
    expect(readFile(runtime).entries[SLUG]).toMatchObject({ held: true, heldReason: HELD_AUTOMATION_DENIED });

    const browser = new FakeBrowser({ running: true, answer: lines(URL) });
    const l = await relaunch(w, runtime, browser);
    l.layoutReady();
    await w.clock.advance(10 * 60_000);
    expect(browser.osascriptCalls).toBe(0);
    expect(l.plugin.browser.isPolling(SLUG)).toBe(false);
    expect(l.plugin.instances.snapshots()[0]).toMatchObject({ held: true, heldReason: HELD_AUTOMATION_DENIED });
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.signals).toEqual([]);
    Notice.messages.length = 0;
  });

  it("an app that was never in the browser is not polled at relaunch", async () => {
    const runtime = freshRuntime();
    const { w } = await firstSession(runtime, "plain", new FakeBrowser());
    const browser = new FakeBrowser({ running: true, answer: lines(URL) });
    const l = await launch(w, { registry: new Registry(registryPath(runtime)), runtimeDir: runtime, browser, restoredTabs: [SLUG] });
    l.layoutReady();
    await w.clock.advance(10 * 60_000);
    expect(l.plugin.browser.pollingCount).toBe(0);
    expect(browser.defaultReads).toBe(0);
    expect(browser.osascriptCalls).toBe(0);
  });
});
