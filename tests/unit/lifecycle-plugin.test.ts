import { beforeEach, describe, expect, it } from "vitest";
import AppRunnerPlugin from "../../src/main";
import type { AppRunnerSettingTab } from "../../src/settings-tab";
import { VIEW_TYPE_APP } from "../../src/webview-view";
import { FakeNode, Notice, Platform, Setting, WorkspaceLeaf, type Plugin as MockPlugin } from "../obsidian-mock";
import { FakeWorld } from "../process-fakes";

type Mocked = AppRunnerPlugin & Pick<MockPlugin, "commands" | "settingTabs" | "stored">;

const SLUG = "live-captions";
const SECOND = 1000;

/**
 * The real plugin class with the process side faked and the Obsidian workspace reduced to a list of leaves: the
 * session count, kill timer, instance events and running list are all the real code, wired as `onload` wires them.
 */
async function loaded(over: { killOnClose?: boolean; openInBrowser?: boolean } = {}) {
  const leaves: WorkspaceLeaf[] = [];
  const handlers = new Map<string, () => void>();
  let layoutReady: (() => void) | undefined;
  const workspace = {
    getLeaf: () => {
      const l = new WorkspaceLeaf();
      leaves.push(l);
      return l;
    },
    revealLeaf: async () => {},
    getActiveViewOfType: () => null,
    getLeavesOfType: (type: string) => leaves.filter((l) => l.viewState?.type === type),
    on: (name: string, cb: () => void) => {
      handlers.set(name, cb);
      return {};
    },
    onLayoutReady: (cb: () => void) => void (layoutReady = cb),
  };
  const plugin = new AppRunnerPlugin({ workspace, commands: { commands: {} }, vault: { adapter: {} } } as never, { id: "app-runner", dir: "plugins/app-runner" } as never) as Mocked;
  const world = new FakeWorld();
  world.dirs.add("/x");
  const { spawn, table, lsof, kill, http, clock, fs, registry, openExternal } = world.deps();
  plugin.instanceDeps = { spawn, table, lsof, kill, http, clock, fs, registry, openExternal, runtimeDir: "/runtime/k" };
  plugin.stored = {
    vaultKey: "k",
    projects: [
      {
        name: "Live Captions",
        slug: SLUG,
        folder: "/x",
        command: "c",
        urlOverride: "",
        killOnClose: over.killOnClose ?? true,
        openInBrowser: over.openInBrowser ?? false,
      },
    ],
  };
  await plugin.onload();
  const tab = plugin.settingTabs[0] as AppRunnerSettingTab;

  const layoutChange = () => handlers.get("layout-change")!();
  const t = {
    plugin,
    world,
    leaves,
    tab,
    layoutChange,
    layoutReady: () => layoutReady!(),
    /** Run Open and wait until the tab is open. */
    async open() {
      const opening = plugin.openProject(SLUG);
      await world.clock.settle();
      if (world.listening.size === 0 || ![...world.answers.keys()].includes(8957)) world.serve(8957);
      await world.clock.run(opening);
    },
    /** Duplicate a tab: another leaf with the same saved state. */
    duplicate() {
      const l = new WorkspaceLeaf();
      l.viewState = { type: VIEW_TYPE_APP, state: { slug: SLUG } };
      leaves.push(l);
      layoutChange();
      return l;
    },
    close(l: WorkspaceLeaf) {
      leaves.splice(leaves.indexOf(l), 1);
      layoutChange();
    },
    /** What the open settings tab shows in the running section. */
    rows() {
      const section = (tab.containerEl as unknown as FakeNode).children[0];
      return section.settings.map((s) => ({ name: s.name, desc: s.desc, buttons: s.buttons }));
    },
    state: () => plugin.instances.stateOf(SLUG),
  };
  return t;
}

beforeEach(() => {
  Notice.reset();
  Setting.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
});

describe("GP4 and GP5 through the plugin", () => {
  it("duplicating the tab gives two sessions on one instance, and the list shows port 8957 with 2 tabs", async () => {
    const t = await loaded();
    t.tab.display();
    await t.open();
    expect(t.leaves).toHaveLength(1);
    t.duplicate();
    expect(t.world.spawns).toHaveLength(1);
    expect(t.plugin.sessions.count(SLUG)).toBe(2);
    expect(t.rows()[0].name).toBe("Live Captions");
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0].desc).toMatch(/^running {2}· {2}port 8957 {2}· {2}started \d\d:\d\d:\d\d {2}· {2}2 tabs$/);
  });

  it("closing one of two tabs keeps the app; closing both stops it 15 s later and empties the list", async () => {
    const t = await loaded();
    t.tab.display();
    await t.open();
    const second = t.duplicate();
    t.close(second);
    expect(t.plugin.sessions.count(SLUG)).toBe(1);
    await t.world.clock.advance(60 * SECOND);
    expect(t.state()).toBe("running");

    t.close(t.leaves[0]);
    await t.world.clock.advance(14 * SECOND);
    expect(t.state()).toBe("running");
    await t.world.clock.advance(SECOND);
    await t.world.clock.advance(2 * SECOND); // the group kill itself takes a moment
    expect(t.state()).toBe("none");
    expect(t.world.procs).toEqual([]);
    expect(t.world.signals.map(([, s]) => s)).toEqual(["SIGTERM"]);
    expect(t.rows()).toEqual([]);
    expect((t.tab.containerEl as unknown as FakeNode).children[0].children.map((c) => c.text)).toEqual(["No apps are running."]);
  });

  it("the open flow does not stop the app: the tab arrives well inside the 15 s", async () => {
    const t = await loaded();
    await t.open();
    await t.world.clock.advance(120 * SECOND);
    expect(t.state()).toBe("running");
    expect(t.plugin.sessions.count(SLUG)).toBe(1);
  });
});

describe("restored tabs (G11)", () => {
  it("a tab restored with the layout counts at layout ready, though no view was ever created for it", async () => {
    const t = await loaded();
    const restored = new WorkspaceLeaf();
    restored.viewState = { type: VIEW_TYPE_APP, state: { slug: SLUG } };
    t.leaves.push(restored);
    t.layoutReady();
    expect(t.plugin.sessions.count(SLUG)).toBe(1);
  });
});

describe("the list follows the instance and the sessions without reopening settings (G7)", () => {
  it("starting, running, a tab opening and a stop each redraw the row", async () => {
    const t = await loaded();
    t.tab.display();
    expect(t.rows()).toEqual([]);

    Setting.reset();
    const opening = t.plugin.openProject(SLUG);
    await t.world.clock.settle();
    expect(t.rows()[0].desc).toMatch(/^starting {2}· {2}port –/);

    Setting.reset();
    t.world.serve(8957);
    await t.world.clock.run(opening);
    expect(t.rows()[0].desc).toMatch(/^running {2}· {2}port 8957 .* 1 tab$/);
    expect(t.rows()[0].buttons[2].disabled).toBe(false); // the log file exists once the app has started

    Setting.reset();
    t.close(t.leaves[0]);
    expect(t.rows()[0].desc).toMatch(/0 tabs$/);

    Setting.reset();
    await t.world.clock.run(t.plugin.stopProject(SLUG));
    expect(t.rows()).toEqual([]);
  });

  it("a hidden settings tab hears nothing", async () => {
    const t = await loaded();
    t.tab.display();
    t.tab.hide();
    Setting.reset();
    await t.open();
    expect(Setting.all).toEqual([]);
  });

  it("the Stop button in the list stops the app whatever tabs are open (G8)", async () => {
    const t = await loaded();
    t.tab.display();
    await t.open();
    t.duplicate();
    t.rows()[0].buttons[1].handler!();
    await t.world.clock.advance(2 * SECOND);
    expect(t.state()).toBe("none");
    expect(t.plugin.sessions.count(SLUG)).toBe(2); // the tabs are still there, showing App stopped
    expect(Notice.messages.at(-1)).toBe("Stopped Live Captions.");
  });

  it("Stop when nothing runs shows a notice and does nothing else (G8)", async () => {
    const t = await loaded();
    t.plugin.commands.get("stop-live-captions")!.callback!();
    await t.world.clock.settle();
    expect(Notice.messages).toEqual(["Nothing running for Live Captions."]);
    expect(t.world.signals).toEqual([]);
    expect(t.world.spawns).toEqual([]);
  });

  it("Stop while starting cancels the start: no tab opens and nothing is left waiting", async () => {
    const t = await loaded();
    const opening = t.plugin.openProject(SLUG);
    await t.world.clock.settle();
    expect(t.state()).toBe("starting");
    await t.world.clock.run(t.plugin.stopProject(SLUG));
    await t.world.clock.run(opening);
    expect(t.leaves).toEqual([]);
    expect(t.state()).toBe("none");
    t.world.serve(8957); // the port opens after the cancel: nothing is probing it
    const probes = t.world.probes.length;
    await t.world.clock.advance(120 * SECOND);
    expect(t.world.probes).toHaveLength(probes);
    expect(t.leaves).toEqual([]);
  });
});

describe("the Kill toggle applies at once (G14)", () => {
  it("switching Kill off in settings cancels the pending timer; switching it on again with no tabs starts one", async () => {
    const t = await loaded();
    await t.open();
    t.close(t.leaves[0]);
    expect(t.plugin.killTimer.isPending(SLUG)).toBe(true);
    await t.plugin.manager.setToggle(SLUG, "killOnClose", false);
    expect(t.plugin.killTimer.isPending(SLUG)).toBe(false);
    await t.world.clock.advance(3600 * SECOND);
    expect(t.state()).toBe("running");

    await t.plugin.manager.setToggle(SLUG, "killOnClose", true);
    expect(t.plugin.killTimer.isPending(SLUG)).toBe(true);
    await t.world.clock.advance(15 * SECOND);
    await t.world.clock.advance(2 * SECOND);
    expect(t.state()).toBe("none");
  });

  it("a project saved with Kill off is never auto-stopped", async () => {
    const t = await loaded({ killOnClose: false });
    await t.open();
    t.close(t.leaves[0]);
    await t.world.clock.advance(3600 * SECOND);
    expect(t.state()).toBe("running");
    expect(t.plugin.killTimer.pendingCount).toBe(0);
  });
});

describe("G9 a crash through the plugin", () => {
  it("drops the row, and 60 s later nothing has restarted it (F4)", async () => {
    const t = await loaded();
    t.tab.display();
    await t.open();
    const spawned = t.world.spawns.length;
    Setting.reset();
    t.world.procs = [];
    t.world.children.get(t.world.leaderPid())!.exit(1);
    await t.world.clock.settle();
    expect(t.state()).toBe("none");
    expect(t.rows()).toEqual([]);
    await t.world.clock.advance(60 * SECOND);
    expect(t.world.spawns).toHaveLength(spawned);
    expect(Notice.messages.filter((m) => m.startsWith("Starting"))).toHaveLength(1);
  });

  it("a start that fails opens no tab and arms no timer", async () => {
    const t = await loaded();
    t.world.nextLeader = { exitsWith: 127 };
    await t.world.clock.run(t.plugin.openProject(SLUG));
    expect(t.leaves).toEqual([]);
    expect(t.plugin.killTimer.pendingCount).toBe(0);
    await t.world.clock.advance(60 * SECOND);
    expect(t.world.spawns).toHaveLength(1);
  });
});

describe("unload", () => {
  it("clears the timers and every listener, and no stop fires afterwards", async () => {
    const t = await loaded();
    t.tab.display();
    await t.open();
    t.close(t.leaves[0]);
    expect(t.plugin.killTimer.isPending(SLUG)).toBe(true);
    const stop = t.plugin.instances.stop.bind(t.plugin.instances);
    let stopCalls = 0;
    t.plugin.instances.stop = (slug) => (stopCalls++, stop(slug));

    t.plugin.onunload();
    expect(t.plugin.killTimer.pendingCount).toBe(0);
    expect(t.plugin.instances.listenerCount).toBe(0);
    expect(t.plugin.sessions.listenerCount).toBe(0);

    Notice.reset();
    await t.world.clock.advance(120 * SECOND);
    expect(stopCalls).toBe(0);
    expect(Notice.messages).toEqual([]); // the timer's Stop would have said "Stopped Live Captions."
  });

  it("unloading with no timer pending also leaves nothing subscribed", async () => {
    const t = await loaded();
    t.plugin.onunload();
    expect(t.plugin.instances.listenerCount).toBe(0);
    expect(t.plugin.sessions.listenerCount).toBe(0);
  });
});
