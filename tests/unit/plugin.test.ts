import { beforeEach, describe, expect, it } from "vitest";
import AppRunnerPlugin, { UNSUPPORTED_PLATFORM_NOTICE } from "../../src/main";
import { POP_OUT_COMMAND_ID } from "../../src/commands";
import { AppRunnerView, VIEW_TYPE_APP } from "../../src/webview-view";
import { Notice, Platform, WorkspaceLeaf, type Plugin as MockPlugin } from "../obsidian-mock";
import { FakeWorld } from "../process-fakes";

/** The real plugin class, seen with the mock base class's recording fields. */
type Mocked = AppRunnerPlugin & Pick<MockPlugin, "commands" | "views" | "settingTabs" | "forbiddenCalls" | "stored">;

function makePlugin() {
  const leaves: WorkspaceLeaf[] = [];
  const workspace = {
    activeView: null as unknown,
    getLeaf: () => {
      const l = new WorkspaceLeaf();
      leaves.push(l);
      return l;
    },
    revealLeaf: async () => {},
    getActiveViewOfType: (cls: new (...a: never[]) => unknown) => (workspace.activeView instanceof cls ? workspace.activeView : null),
    getLeavesOfType: () => leaves,
    on: () => ({}),
    onLayoutReady: () => {},
  };
  // The vault adapter as the plugin's data.json sees it: the file is there once the mock has stored something.
  const copies: Array<[string, string]> = [];
  const adapter = {
    exists: async (path: string) => path === "plugins/app-runner/data.json" && plugin.stored !== null,
    copy: async (from: string, to: string) => {
      copies.push([from, to]);
    },
  };
  const plugin = new AppRunnerPlugin(
    { workspace, commands: { commands: {} }, vault: { adapter } } as never,
    { id: "app-runner", dir: "plugins/app-runner" } as never,
  ) as Mocked;
  return { plugin, workspace, leaves, copies };
}

beforeEach(() => {
  Notice.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
});

describe("T1 an unreadable data.json at load", () => {
  it("loadData() answering undefined while data.json exists is backed up through the vault adapter, not overwritten", async () => {
    const { plugin, copies } = makePlugin();
    const original = { stored: "truncated" };
    plugin.stored = original; // the file is on disk...
    plugin.loadData = async () => undefined; // ...but Obsidian 1.15 read it as nothing
    await plugin.onload();
    expect(copies).toHaveLength(1);
    expect(copies[0][0]).toBe("plugins/app-runner/data.json");
    expect(copies[0][1]).toMatch(/^plugins\/app-runner\/data\.json\.corrupt-/);
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain(copies[0][1]);
  });

  it("no data.json at all: defaults saved, nothing copied, no notice", async () => {
    const { plugin, copies } = makePlugin();
    await plugin.onload();
    expect(copies).toEqual([]);
    expect(Notice.messages).toEqual([]);
    expect(plugin.stored).not.toBeNull();
  });
});

describe("F2 platform", () => {
  it.each([
    ["non-mac desktop", { isDesktopApp: true, isMacOS: false }],
    ["mobile", { isDesktopApp: false, isMacOS: false }],
    ["mac but not desktop", { isDesktopApp: false, isMacOS: true }],
  ])("%s: loads, registers nothing, one notice", async (_l, flags) => {
    Object.assign(Platform, flags);
    const { plugin } = makePlugin();
    await plugin.onload();
    expect(Notice.messages).toEqual([UNSUPPORTED_PLATFORM_NOTICE]);
    expect(plugin.commands.size).toBe(0);
    expect(plugin.views.size).toBe(0);
    expect(plugin.settingTabs).toEqual([]);
    expect(plugin.stored).toBeNull();
  });

  it("on macOS desktop it registers the view, the settings tab and the global command, with no notice", async () => {
    const { plugin } = makePlugin();
    await plugin.onload();
    expect(Notice.messages).toEqual([]);
    expect([...plugin.views.keys()]).toEqual([VIEW_TYPE_APP]);
    expect(plugin.settingTabs).toHaveLength(1);
    expect([...plugin.commands.keys()]).toEqual([POP_OUT_COMMAND_ID]);
  });
});

describe("fence F1 at runtime", () => {
  it("loading and adding projects never touches ribbon, status bar or URI handler APIs", async () => {
    const { plugin } = makePlugin();
    await plugin.onload();
    expect(plugin.forbiddenCalls).toEqual([]);
  });
});

describe("GP2 commands survive a reload", () => {
  it("stored projects get their commands at load", async () => {
    const made = makePlugin();
    // data.json as a previous session saved it
    made.plugin.stored = {
      version: 1,
      vaultKey: "k",
      settings: {},
      projects: [{ name: "Live Captions", slug: "live-captions", folder: "/x", command: "npm run start", urlOverride: "", killOnClose: true, openInBrowser: false }],
    };
    await made.plugin.onload();
    expect([...made.plugin.commands.values()].map((c) => `${c.id}|${c.name}`).sort()).toEqual(
      [`${POP_OUT_COMMAND_ID}|Pop out current App Runner tab to browser`, "open-live-captions|Open Live Captions", "stop-live-captions|Stop Live Captions"].sort(),
    );
  });
});

describe("the commands in this PR", () => {
  /** The plugin with the process side faked: the folder exists, no real process or port is touched. */
  async function loaded(urlOverride = "", openInBrowser = false) {
    const made = makePlugin();
    const world = new FakeWorld();
    world.dirs.add("/x");
    const { spawn, table, lsof, kill, http, clock, fs, registry, openExternal } = world.deps();
    made.plugin.instanceDeps = { spawn, table, lsof, kill, http, clock, fs, registry, openExternal, runtimeDir: "/runtime/k" };
    made.plugin.stored = {
      vaultKey: "k",
      projects: [{ name: "Live Captions", slug: "live-captions", folder: "/x", command: "c", urlOverride, killOnClose: true, openInBrowser }],
    };
    await made.plugin.onload();
    return { ...made, world };
  }

  it("Stop shows nothing running", async () => {
    const { plugin } = await loaded();
    plugin.commands.get("stop-live-captions")!.callback!();
    await Promise.resolve();
    expect(Notice.messages).toEqual(["Nothing running for Live Captions."]);
  });

  it("Open starts the app, and opens one tab with the slug as its only state once it answers", async () => {
    const { plugin, leaves, world } = await loaded();
    const opening = plugin.openProject("live-captions");
    await world.clock.settle();
    expect(Notice.messages).toEqual(["Starting Live Captions"]);
    expect(leaves).toEqual([]); // no tab until the app answers
    world.serve(8957);
    await world.clock.run(opening);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].viewState).toMatchObject({ type: VIEW_TYPE_APP, state: { slug: "live-captions" } });
    expect(world.spawns).toHaveLength(1);
  });

  it("two Open commands at once make one process and one tab", async () => {
    const { plugin, leaves, world } = await loaded();
    const a = plugin.openProject("live-captions");
    const b = plugin.openProject("live-captions");
    await world.clock.settle();
    world.serve(8957);
    await world.clock.run(Promise.all([a, b]));
    expect(world.spawns).toHaveLength(1);
    expect(leaves).toHaveLength(1);
  });

  it("Open with Open-in-browser on opens no tab (the URL goes to the browser seam)", async () => {
    const { plugin, leaves, world } = await loaded("", true);
    const opening = plugin.openProject("live-captions");
    await world.clock.settle();
    world.serve(8957);
    await world.clock.run(opening);
    expect(leaves).toEqual([]);
    expect(world.external).toEqual(["http://127.0.0.1:8957/"]);
  });

  it("a failed start opens no tab and shows the failure notice", async () => {
    const { plugin, leaves, world } = await loaded();
    world.nextLeader = { exitsWith: 127 };
    await world.clock.run(plugin.openProject("live-captions"));
    expect(leaves).toEqual([]);
    expect(Notice.messages.at(-1)).toContain("stopped before it was ready");
  });

  it("Stop command stops the running app", async () => {
    const { plugin, world } = await loaded();
    const opening = plugin.openProject("live-captions");
    await world.clock.settle();
    world.serve(8957);
    await world.clock.run(opening);
    const leader = world.leaderPid();
    const stopping = plugin.stopProject("live-captions");
    await world.clock.run(stopping);
    expect(world.signals[0]).toEqual([-leader, "SIGTERM"]);
    expect(world.procs).toEqual([]);
    expect(Notice.messages.at(-1)).toBe("Stopped Live Captions.");
  });

  it("unloading the plugin leaves the app running and sends no signal at all (G15)", async () => {
    const { plugin, world } = await loaded();
    world.addProc(4242, 4242); // Dan's own process
    const opening = plugin.openProject("live-captions");
    await world.clock.settle();
    world.serve(8957);
    await world.clock.run(opening);
    const leader = world.leaderPid();
    plugin.onunload();
    await world.clock.advance(60_000);
    expect(world.signals).toEqual([]);
    expect(world.procs.map((p) => p.pid).sort()).toEqual([4242, leader].sort());
  });

  it("unloading with nothing running signals nothing", async () => {
    const { plugin, world } = await loaded();
    plugin.onunload();
    expect(world.signals).toEqual([]);
  });

  it("Open for a deleted project says so", async () => {
    const { plugin, leaves } = await loaded();
    await plugin.openProject("gone");
    expect(Notice.messages).toEqual(["This project no longer exists."]);
    expect(leaves).toEqual([]);
  });

  it("the global pop-out command shows a notice when the active tab is not an App Runner tab", async () => {
    const { plugin, workspace } = await loaded();
    workspace.activeView = {};
    plugin.commands.get(POP_OUT_COMMAND_ID)!.callback!();
    expect(Notice.messages).toEqual(["The active tab is not an App Runner tab."]);
  });

  it("on an App Runner tab the global command does not claim it is not one", async () => {
    const { plugin, workspace } = await loaded("http://127.0.0.1:8957");
    workspace.activeView = new AppRunnerView(new WorkspaceLeaf() as never, {
      getProject: () => undefined,
      isWebviewAvailable: () => true,
      async openExternal() {},
      notify() {},
    });
    plugin.commands.get(POP_OUT_COMMAND_ID)!.callback!();
    // Pop out is real now (tests/unit/popout-command.test.ts); this tab has no project, so it does nothing, and says nothing wrong.
    expect(Notice.messages.filter((m) => /not an App Runner tab/.test(m))).toEqual([]);
  });
});
