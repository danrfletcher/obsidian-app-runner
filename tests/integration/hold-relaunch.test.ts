import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HELD_BROWSER_UNREADABLE, HELD_BROWSER_UNSUPPORTED } from "../../src/held";
import { FakeBrowser } from "../browser-fakes";
import { lines } from "../fixtures/osascript-output";
import { Notice, Platform, Setting } from "../obsidian-mock";
import { launch } from "../plugin-harness";
import { mountTab, openApp, plugin, setWebviewAvailable, SLUG } from "../popout-rig";

/**
 * G10, G12, G13 across an Obsidian restart, through the real plugin on a fake process world and an in-memory registry:
 * what the second session knows about the browser hold the first one was in.
 */

const URL = "http://127.0.0.1:8957/";
const POLL = 5000;
const HOLD = 30_000;
const GRACE = 15_000;

beforeEach(() => {
  Notice.reset();
  Setting.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
  setWebviewAvailable(true);
});
afterEach(() => setWebviewAvailable(false));

describe("the 30 s hold that had already ended is not started again at relaunch", () => {
  it("Held only because the browser could not be read: the relaunch keeps the ended hold, so the next good read with no tab releases it", async () => {
    const browser = new FakeBrowser({ running: true, answer: lines() });
    const { w, l } = await plugin({ killOnClose: false }, { browser });
    await openApp(w, l);
    await (await mountTab(l)).popOut();
    await w.clock.advance(POLL); // the first read: no tab, the 30 s clock starts
    await w.clock.advance(HOLD); // it runs out: the hold is over
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);

    browser.bundleId = "com.apple.Safari"; // the user switched the default browser to one that cannot be read
    await w.clock.advance(POLL);
    expect(l.plugin.instances.heldReasonOf(SLUG)).toBe(HELD_BROWSER_UNSUPPORTED);
    expect(w.registry.entries.get(SLUG)).toMatchObject({ held: true, heldReason: HELD_BROWSER_UNSUPPORTED, holdOver: true });

    l.plugin.onunload();
    const again = new FakeBrowser({ running: true, answer: lines() }); // a readable browser, no tab of the app
    const l2 = await launch(w, { browser: again });
    expect(l2.plugin.instances.holdOverOf(SLUG)).toBe(true);
    l2.layoutReady();
    await w.clock.settle();
    await w.clock.advance(POLL);

    expect(l2.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(l2.plugin.browser.hasHoldTimer(SLUG)).toBe(false); // no new 30 s hold
    expect(w.registry.entries.get(SLUG)?.held).toBeUndefined();
  });

  it("a hold still in progress when Obsidian quit is rebuilt as pending (a fresh 30 s clock at the first read)", async () => {
    const browser = new FakeBrowser({ running: false });
    const { w, l } = await plugin({ killOnClose: false }, { browser });
    await openApp(w, l);
    await (await mountTab(l)).popOut();
    expect(w.registry.entries.get(SLUG)).toMatchObject({ held: true, heldReason: "opened-in-browser" });
    expect(w.registry.entries.get(SLUG)?.holdOver).toBeUndefined();

    l.plugin.onunload();
    const again = new FakeBrowser({ running: true, answer: lines() });
    const l2 = await launch(w, { browser: again });
    expect(l2.plugin.instances.holdOverOf(SLUG)).toBe(false);
    l2.layoutReady();
    await w.clock.settle();
    await w.clock.advance(POLL);
    expect(l2.plugin.browser.hasHoldTimer(SLUG)).toBe(true);
    expect(l2.plugin.instances.isHeld(SLUG)).toBe(true);
    await w.clock.advance(HOLD);
    expect(l2.plugin.instances.isHeld(SLUG)).toBe(false);
  });

  it("a new pop out after the hold ended starts a fresh hold and drops the saved 'over'", async () => {
    const browser = new FakeBrowser({ running: true, answer: lines() });
    const { w, l } = await plugin({ killOnClose: false }, { browser });
    await openApp(w, l);
    await (await mountTab(l)).popOut();
    await w.clock.advance(POLL + HOLD);
    browser.bundleId = "com.apple.Safari";
    await w.clock.advance(POLL);
    expect(w.registry.entries.get(SLUG)?.holdOver).toBe(true);

    await l.plugin.instances.popOut(SLUG);
    expect(l.plugin.instances.holdOverOf(SLUG)).toBe(false);
    expect(w.registry.entries.get(SLUG)?.holdOver).toBeUndefined();
  });
});

describe("an adopted app whose port is not known yet is not judged by browser tabs it cannot match", () => {
  it("it is held as unreadable instead of counting zero browser tabs, and is not stopped 15 s after layout ready; once the port is found the tab counts", async () => {
    const browser = new FakeBrowser({ running: true, answer: lines(URL) });
    const { w, l } = await plugin({ killOnClose: true }, { browser });
    await openApp(w, l);
    await (await mountTab(l)).popOut();
    await w.clock.advance(POLL); // the tab is seen: the hold ends
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);

    l.plugin.onunload();
    w.registry.entries.get(SLUG)!.port = null; // what the last session knew
    w.answers.delete(8957); // and the app does not answer yet, so the port cannot be found again
    const l2 = await launch(w, { browser });
    expect(l2.plugin.instances.portOf(SLUG)).toBeNull();
    l2.layoutReady();
    await w.clock.settle();

    expect(l2.plugin.instances.heldReasonOf(SLUG)).toBe(HELD_BROWSER_UNREADABLE);
    await w.clock.advance(GRACE + 2000);
    expect(l2.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.signals).toEqual([]);

    w.answers.set(8957, { html: true }); // the app answers: the liveness poll finds the port, the next browser poll reads the tab
    await w.clock.advance(POLL * 3);
    expect(l2.plugin.instances.portOf(SLUG)).toBe(8957);
    expect(l2.plugin.browser.tabCount(SLUG)).toBe(1);
    expect(l2.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(l2.plugin.instances.stateOf(SLUG)).toBe("running");
  });
});
