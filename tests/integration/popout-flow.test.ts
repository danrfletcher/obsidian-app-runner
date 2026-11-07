import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heldReasonText, HELD_OPENED_IN_BROWSER } from "../../src/held";
import { VIEW_TYPE_APP } from "../../src/webview-view";
import { FakeMenu, FakeNode, Notice, Platform, Setting } from "../obsidian-mock";
import { addTab, appTabs, mountTab, openApp, plugin, setWebviewAvailable, SLUG } from "../popout-rig";
import { FakeWorld } from "../process-fakes";

/**
 * Pop out to browser and Open in browser through the real plugin: the real instance manager, session counter, kill timer,
 * tab view and running list, on a fake process, fake lsof and a recorder in place of the browser (`openExternal`), so no
 * test launches a browser.
 */

const URL = "http://127.0.0.1:8957/";

beforeEach(() => {
  Notice.reset();
  Setting.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
  setWebviewAvailable(true);
});
afterEach(() => setWebviewAvailable(false));

/** What the running list says in the sessions cell for the app. */
const listed = (l: Awaited<ReturnType<typeof plugin>>["l"]) => l.rows().map((r) => r.desc);

/** E9: nothing but the app itself was ever spawned; no osascript. */
const spawnedOnlyTheApp = (w: FakeWorld) => {
  expect(w.spawns).toHaveLength(1);
  expect(w.spawns.some((s) => /osascript/.test(`${s.command} ${s.args.join(" ")}`))).toBe(false);
};

describe("Open in browser, cold start (G12)", () => {
  it("starts the app, opens the browser once at the instance URL when ready, opens no tab, and the instance is Held", async () => {
    const { w, l } = await plugin({ openInBrowser: true });
    const opening = l.plugin.openProject(SLUG);
    await w.clock.settle();
    expect(w.external).toEqual([]); // not before the app answers
    w.serve(8957);
    await w.clock.run(opening);

    expect(w.external).toEqual([URL]);
    expect(appTabs(l)).toEqual([]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
    expect(w.registry.entries.get(SLUG)).toMatchObject({ held: true, heldReason: HELD_OPENED_IN_BROWSER, browserSessionExpected: true });
    spawnedOnlyTheApp(w);
  });

  it("the running list shows the Held reason instead of a bare zero", async () => {
    const { w, l } = await plugin({ openInBrowser: true });
    l.tab.display();
    await openApp(w, l);
    expect(listed(l)).toEqual([expect.stringMatching(/Held: opened in browser, waiting to read its tabs$/)]);
    expect(listed(l)[0]).not.toMatch(/0 tabs/);
    expect(heldReasonText(HELD_OPENED_IN_BROWSER)).toBe("opened in browser, waiting to read its tabs");
  });

  it("a double Open while it starts opens the browser once", async () => {
    const { w, l } = await plugin({ openInBrowser: true });
    const a = l.plugin.openProject(SLUG);
    const b = l.plugin.openProject(SLUG);
    await w.clock.settle();
    w.serve(8957);
    await w.clock.run(Promise.all([a, b]));
    expect(w.external).toEqual([URL]);
    expect(w.spawns).toHaveLength(1);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
  });

  it("Stop during starting cancels the start and nothing opens", async () => {
    const { w, l } = await plugin({ openInBrowser: true });
    const opening = l.plugin.openProject(SLUG);
    await w.clock.settle();
    await w.clock.run(l.plugin.stopProject(SLUG));
    w.serve(8957);
    await w.clock.run(opening);
    expect(w.external).toEqual([]);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("none");
    expect(w.procs).toEqual([]);
  });

  it("with the app already running, Open in browser opens the browser only: no tab, no second instance", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l); // setting off: a tab
    expect(appTabs(l)).toHaveLength(1);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);

    await l.plugin.manager.setToggle(SLUG, "openInBrowser", true); // applies at once
    await l.plugin.openProject(SLUG);
    expect(w.external).toEqual([URL]);
    expect(appTabs(l)).toHaveLength(1); // still the one tab from before
    expect(w.spawns).toHaveLength(1);
    expect(l.plugin.instances.snapshots()).toHaveLength(1);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
  });

  it("turning the setting off applies to the next Open and does not clear Held on a running app", async () => {
    const { w, l } = await plugin({ openInBrowser: true });
    await openApp(w, l);
    await l.plugin.manager.setToggle(SLUG, "openInBrowser", false);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
    await l.plugin.openProject(SLUG);
    expect(appTabs(l)).toHaveLength(1); // the next Open is a tab
    expect(w.external).toEqual([URL]); // and nothing more went to the browser
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
  });
});

describe("Pop out from a tab (G12)", () => {
  it("the tab menu and the tab header both offer Pop out to browser", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    const view = await mountTab(l);
    expect((view as unknown as { actions: Array<{ title: string }> }).actions.map((a) => a.title)).toEqual(["Pop out to browser"]);
    const menu = new FakeMenu();
    view.onPaneMenu(menu as never, "tab-header");
    expect(menu.items.map((i) => i.title)).toEqual(["Pop out to browser"]);
  });

  it("GP6: the tab closes, the browser opens the loopback URL, the app keeps running and is Held; later nothing stops it", async () => {
    const { w, l } = await plugin({});
    l.tab.display();
    await openApp(w, l);
    const view = await mountTab(l);
    const menu = new FakeMenu();
    view.onPaneMenu(menu as never, "tab-header");
    menu.items[0].click();
    await w.clock.settle();

    expect(w.external).toEqual([URL]);
    expect(appTabs(l)).toEqual([]);
    expect(l.leaves.length).toBe(0);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
    expect(l.plugin.sessions.count(SLUG)).toBe(0);
    expect(l.plugin.killTimer.isPending(SLUG)).toBe(false);

    // The harness browser is not running, so no poll ever reads a tab: the hold never starts its clock, and well past the grace the app is still there.
    await w.clock.advance(10 * 60_000);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.signals).toEqual([]);
    expect(w.answers.has(8957)).toBe(true);
    expect(listed(l)).toEqual([expect.stringMatching(/port 8957.*Held: opened in browser, waiting to read its tabs$/)]);
    spawnedOnlyTheApp(w);
  });

  it("GP6: Stop (command) on a Held app ends the group, closes the port, empties the list and clears Held", async () => {
    const { w, l } = await plugin({});
    l.tab.display();
    await openApp(w, l);
    const view = await mountTab(l);
    await view.popOut();
    const leader = w.leaderPid();

    await w.clock.run(l.plugin.stopProject(SLUG));
    expect(w.signals[0]).toEqual([-leader, "SIGTERM"]);
    expect(w.procs).toEqual([]);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("none");
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(w.registry.entries.has(SLUG)).toBe(false);
    expect(l.rows()).toEqual([]);
  });

  it("GP6: Stop from the running list does the same", async () => {
    const { w, l } = await plugin({ openInBrowser: true });
    l.tab.display();
    await openApp(w, l);
    expect(l.rows()).toHaveLength(1);
    const stopButton = l.rows()[0].buttons.find((b) => b.text === "Stop")!;
    stopButton.handler!();
    await w.clock.advance(2000);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("none");
    expect(w.procs).toEqual([]);
    expect(l.rows()).toEqual([]);
  });

  it("with other tabs of the app open, only the clicked tab closes and the instance is still Held", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    const first = { view: await mountTab(l), leaf: appTabs(l)[0] };
    const second = await addTab(l);
    expect(l.plugin.sessions.count(SLUG)).toBe(2);

    await second.view.popOut();
    expect(second.leaf.detached).toBe(true);
    expect(l.leaves.includes(second.leaf)).toBe(false);
    expect(l.leaves.includes(first.leaf)).toBe(true);
    expect(appTabs(l)).toHaveLength(1);
    expect(l.plugin.sessions.count(SLUG)).toBe(1);
    expect(w.external).toEqual([URL]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
  });

  it("a double click on Pop out gives one browser open and one Held flag", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    const view = await mountTab(l);
    const a = view.popOut();
    const b = view.popOut();
    expect(await Promise.all([a, b])).toEqual([true, false]);
    expect(w.external).toEqual([URL]);
    expect(w.registry.entries.get(SLUG)).toMatchObject({ held: true });
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
  });

  it("two Pop outs of the app at once (the manager, as two commands would call it) open one page", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    const [a, b] = await Promise.all([l.plugin.instances.popOut(SLUG), l.plugin.instances.popOut(SLUG)]);
    expect([a.kind, b.kind]).toEqual(["opened", "opened"]);
    expect(w.external).toEqual([URL]);
  });

  it("Pop out during starting joins the start: one browser open once the app answers, one Held flag", async () => {
    const { w, l } = await plugin({});
    const opening = l.plugin.openProject(SLUG);
    await w.clock.settle();
    const a = l.plugin.instances.popOut(SLUG);
    const b = l.plugin.instances.popOut(SLUG);
    await w.clock.settle();
    expect(w.external).toEqual([]);
    w.serve(8957);
    await w.clock.run(Promise.all([opening, a, b]));
    expect(w.external).toEqual([URL]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
  });

  it("Stop during a Pop out that waits for the start cancels it: nothing opens, nothing is Held", async () => {
    const { w, l } = await plugin({});
    const opening = l.plugin.openProject(SLUG);
    await w.clock.settle();
    const popping = l.plugin.instances.popOut(SLUG);
    await w.clock.run(l.plugin.stopProject(SLUG));
    expect((await w.clock.run(popping)).kind).toBe("cancelled");
    await w.clock.run(opening);
    expect(w.external).toEqual([]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(w.registry.entries.has(SLUG)).toBe(false);
  });

  it("E13: a restored tab showing the App stopped panel opens no browser and sets no Held", async () => {
    const { w, l } = await plugin({}, { restoredTabs: [SLUG] });
    l.layoutReady();
    const view = await mountTab(l);
    expect((view.contentEl as unknown as FakeNode).textContent()).toMatch(/App stopped/);
    Notice.reset();

    expect(await view.popOut()).toBe(false);
    expect(w.external).toEqual([]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("none");
    expect(l.leaves[0].detached).toBe(false);
    expect(Notice.messages).toEqual(["Live Captions is not running, so there is nothing to open in the browser."]);
  });
});

describe("failures leave the tab and the app alone", () => {
  const failing = { configure: (p: { instanceDeps: { openExternal?: (u: string) => void } }) => (p.instanceDeps.openExternal = () => { throw new Error("no default browser"); }) };

  it("a browser opener that throws: a notice, the tab stays open, Held is not set, the app is not stopped", async () => {
    const { w, l } = await plugin({}, failing as never);
    await openApp(w, l);
    const view = await mountTab(l);
    Notice.reset();

    expect(await view.popOut()).toBe(false);
    expect(Notice.messages).toEqual(["Could not open Live Captions in your browser: no default browser"]);
    expect(appTabs(l)).toHaveLength(1);
    expect(l.leaves[0].detached).toBe(false);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.signals).toEqual([]);
    expect(w.registry.entries.get(SLUG)?.held).toBeUndefined();
  });

  it("Open in browser with an opener that throws: a notice, no tab, not Held, the app keeps running", async () => {
    const { w, l } = await plugin({ openInBrowser: true }, failing as never);
    await openApp(w, l);
    expect(Notice.messages.at(-1)).toBe("Could not open Live Captions in your browser: no default browser");
    expect(appTabs(l)).toEqual([]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.signals).toEqual([]);
  });

  const rejecting = {
    configure: (p: { instanceDeps: { openExternal?: (u: string) => Promise<void> } }) =>
      (p.instanceDeps.openExternal = async () => {
        await Promise.resolve(); // the rejection arrives on a later turn, not while the opener is being called
        throw new Error("no default browser");
      }),
  };

  it("a browser opener whose promise rejects later (Electron's real failure mode): a notice, the tab stays open, Held is not set", async () => {
    const { w, l } = await plugin({}, rejecting as never);
    await openApp(w, l);
    const view = await mountTab(l);
    Notice.reset();

    expect(await view.popOut()).toBe(false);
    expect(Notice.messages).toEqual(["Could not open Live Captions in your browser: no default browser"]);
    expect(appTabs(l)).toHaveLength(1);
    expect(l.leaves[0].detached).toBe(false);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.signals).toEqual([]);
    expect(w.registry.entries.get(SLUG)?.held).toBeUndefined();
  });

  it("Open in browser with an opener that rejects later: a notice, no tab, not Held, the app keeps running", async () => {
    const { w, l } = await plugin({ openInBrowser: true }, rejecting as never);
    await openApp(w, l);
    expect(Notice.messages.at(-1)).toBe("Could not open Live Captions in your browser: no default browser");
    expect(appTabs(l)).toEqual([]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.signals).toEqual([]);
    expect(w.registry.entries.get(SLUG)?.held).toBeUndefined();
  });

  it("no URL can be built yet (an adopted app whose port is not known): a notice, the tab stays, not Held, not stopped", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    const view = await mountTab(l);
    // The instance has no address (the app stopped answering and was never rediscovered): Pop out looks once more and finds nothing.
    (l.plugin.instances as unknown as { instances: Map<string, { url: string | null }> }).instances.get(SLUG)!.url = null;
    w.answers.delete(8957);
    Notice.reset();

    expect(await view.popOut()).toBe(false);
    expect(Notice.messages).toEqual(["Live Captions has no address to open yet. Try again in a moment."]);
    expect(w.external).toEqual([]);
    expect(l.leaves[0].detached).toBe(false);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
  });

  it("F6: a non-loopback instance URL is rejected before any browser open, with a notice", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    const view = await mountTab(l);
    (l.plugin.instances as unknown as { instances: Map<string, { url: string | null }> }).instances.get(SLUG)!.url = "http://192.168.1.20:8957/";
    Notice.reset();

    expect(await view.popOut()).toBe(false);
    expect(w.external).toEqual([]);
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toMatch(/only opens loopback addresses/);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(l.leaves[0].detached).toBe(false);
  });
});

describe("the URL opened is the instance's, exactly (F7)", () => {
  it("an override with a path is opened exactly as written", async () => {
    const { w, l } = await plugin({ slug: SLUG, urlOverride: "http://127.0.0.1:4317/dashboard" });
    await openApp(w, l, 4317);
    const view = await mountTab(l);
    await view.popOut();
    expect(w.external).toEqual(["http://127.0.0.1:4317/dashboard"]);
  });

  it("with no override it is the discovered port's page, read at click time", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    const view = await mountTab(l);
    // The app moved to another port since the tab opened (E19); the instance follows it, and so does the click.
    const inst = (l.plugin.instances as unknown as { instances: Map<string, { url: string | null; port: number | null }> }).instances.get(SLUG)!;
    inst.url = "http://127.0.0.1:9001/";
    inst.port = 9001;
    await view.popOut();
    expect(w.external).toEqual(["http://127.0.0.1:9001/"]);
  });
});

describe("E18 webview unavailable: the page opens in the default browser as Held, with a notice", () => {
  it("a tab that cannot embed the page uses the Pop out hand-off", async () => {
    setWebviewAvailable(false);
    const { w, l } = await plugin({});
    await openApp(w, l); // Open creates the leaf; its view cannot embed
    const [leaf] = appTabs(l);
    Notice.reset();
    await mountTab(l, leaf);

    expect(w.external).toEqual([URL]);
    expect(leaf.detached).toBe(true);
    expect(Notice.messages).toEqual(["This Obsidian window cannot embed web pages (webview is unavailable), so Live Captions opened in your default browser instead."]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.registry.entries.get(SLUG)).toMatchObject({ held: true, heldReason: HELD_OPENED_IN_BROWSER });
  });

  it("when the browser cannot be opened the tab stays, says so, and nothing is Held", async () => {
    setWebviewAvailable(false);
    const { w, l } = await plugin({}, { configure: (p) => ((p.instanceDeps as { openExternal: (u: string) => void }).openExternal = () => { throw new Error("nope"); }) });
    await openApp(w, l);
    const [leaf] = appTabs(l);
    const view = await mountTab(l, leaf);
    expect(leaf.detached).toBe(false);
    expect((view.contentEl as unknown as FakeNode).textContent()).toMatch(/cannot be shown in this tab/);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
  });
});

describe("a Held app that exits on its own", () => {
  it("loses its Held flag with its entry and leaves the list", async () => {
    const { w, l } = await plugin({ openInBrowser: true });
    l.tab.display();
    await openApp(w, l);
    expect(l.rows()).toHaveLength(1);

    w.procs = [];
    w.children.get(w.leaderPid())!.exit(1);
    await w.clock.settle();
    expect(l.plugin.instances.stateOf(SLUG)).toBe("none");
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(w.registry.entries.has(SLUG)).toBe(false);
    expect(l.rows()).toEqual([]);
  });

  it("opening it again starts a fresh instance that is not Held until it is handed to the browser", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    await (await mountTab(l)).popOut();
    w.procs = [];
    w.children.get(w.leaderPid())!.exit(1);
    await w.clock.settle();

    await openApp(w, l, 8957);
    expect(w.spawns).toHaveLength(2);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(appTabs(l)).toHaveLength(1);
  });
});

describe("the global command and the view type", () => {
  it("the tab it pops out is the App Runner view type", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    expect(appTabs(l)[0].viewState?.type).toBe(VIEW_TYPE_APP);
  });
});
