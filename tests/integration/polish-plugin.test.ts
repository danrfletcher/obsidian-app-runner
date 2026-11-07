import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VIEW_TYPE_APP, type AppRunnerView } from "../../src/webview-view";
import { Notice, Platform, Setting, type FakeNode } from "../obsidian-mock";
import { launch } from "../plugin-harness";
import { appTabs, mountTab, openApp, plugin, setWebviewAvailable, SLUG } from "../popout-rig";
import { FakeWorld, project } from "../process-fakes";

const URL = "http://127.0.0.1:8957/";

beforeEach(() => {
  Notice.reset();
  Setting.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
  setWebviewAvailable(true);
});
afterEach(() => setWebviewAvailable(false));

const dom = (v: AppRunnerView) => v.contentEl as unknown as FakeNode;
const text = (v: AppRunnerView) => dom(v).textContent();

describe("onload does not wait for the launch check (G10)", () => {
  it("with the registry read hanging, the commands, the view and the settings tab are registered and a restored tab says Checking; Open waits and then adopts instead of spawning a second app", async () => {
    const w = new FakeWorld(project());
    const first = await launch(w);
    const opening = first.plugin.openProject(SLUG);
    await w.clock.settle();
    w.serve(8957);
    await w.clock.run(opening);
    first.plugin.onunload();
    expect(w.spawns).toHaveLength(1);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realRead = w.registry.read.bind(w.registry);
    w.registry.read = async () => {
      await gate;
      return realRead();
    };

    const l = await launch(w, { restoredTabs: [SLUG], waitForAdoption: false }); // returns although the check is hanging
    expect(l.plugin.commands.has("open-live-captions")).toBe(true);
    expect(l.plugin.commands.has("stop-live-captions")).toBe(true);
    expect(l.plugin.views.has(VIEW_TYPE_APP)).toBe(true);
    expect(l.plugin.settingTabs).toHaveLength(1);
    expect(l.plugin.instances.isAdopted(SLUG)).toBe(false);

    const create = l.plugin.views.get(VIEW_TYPE_APP) as (leaf: unknown) => AppRunnerView;
    const view = create(l.leaves[0]);
    await view.onOpen();
    await view.setState({ slug: SLUG }, { history: false });
    expect(text(view)).toContain("Checking Live Captions");
    expect(dom(view).all().some((n) => n.tag === "button")).toBe(false);

    const openedMeanwhile = l.plugin.openProject(SLUG); // the Open command, before the check ends
    await w.clock.settle();
    expect(w.spawns).toHaveLength(1);

    release();
    await l.plugin.adopted;
    await openedMeanwhile;
    expect(l.plugin.instances.isAdopted(SLUG)).toBe(true);
    expect(w.spawns).toHaveLength(1); // adopted, not started again
    expect(text(view)).not.toContain("Checking");
    expect(dom(view).all().some((n) => n.tag === "webview")).toBe(true); // the tab redrew into the adopted app
    expect(appTabs(l).length).toBeGreaterThan(1); // the Open added its tab
  });

  it("a check that fails still lets the plugin work: one notice, then Open starts the app", async () => {
    const w = new FakeWorld(project());
    w.registry.failReads = true;
    const l = await launch(w, { waitForAdoption: false });
    await l.plugin.adopted;
    expect(l.plugin.commands.has("open-live-captions")).toBe(true);
    expect(Notice.messages.some((m) => m.includes("could not read its list of running apps"))).toBe(true);
    const opening = l.plugin.openProject(SLUG);
    await w.clock.settle();
    w.serve(8957);
    await w.clock.run(opening);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
  });
});

describe("the panel's Start never takes the Open-in-browser branch", () => {
  it("a stopped tab of a project with Open in browser on: Start brings the tab back and opens no browser page", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    const view = await mountTab(l);
    await w.clock.run(l.plugin.stopProject(SLUG));
    expect(text(view)).toContain("was stopped");

    await l.plugin.manager.setToggle(SLUG, "openInBrowser", true);
    const start = dom(view).all().find((n) => n.tag === "button")!;
    start.click();
    await w.clock.settle();
    w.serve(8957);
    await w.clock.advance(2000);
    for (let i = 0; i < 20 && l.plugin.instances.stateOf(SLUG) !== "running"; i++) await w.clock.advance(1000);

    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.external).toEqual([]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(dom(view).all().find((n) => n.tag === "webview")?.attrs.src).toBe(URL);
  });

  it("the Open command on the same project still goes to the browser, and Holds it (Kill on does not stop it)", async () => {
    const { w, l } = await plugin({ openInBrowser: true });
    await openApp(w, l);
    expect(w.external).toEqual([URL]);
    expect(appTabs(l)).toEqual([]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
    await w.clock.advance(60_000);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.signals).toEqual([]);
  });
});

describe("deleting a project (G3)", () => {
  it("closes its open App Runner tabs and leaves other projects' tabs alone", async () => {
    const w = new FakeWorld(project(), project({ name: "Build Dashboard", slug: "build-dashboard", folder: "/work/build-dashboard" }));
    const l = await launch(w);
    await openApp(w, l);
    const other = l.workspace.getLeaf();
    await other.setViewState({ type: VIEW_TYPE_APP, state: { slug: "build-dashboard" } });
    expect(appTabs(l)).toHaveLength(2);

    await w.clock.run(l.plugin.manager.delete(SLUG, async () => true));
    expect(appTabs(l)).toEqual([other]);
    expect(l.plugin.sessions.count(SLUG)).toBe(0);
  });
});
