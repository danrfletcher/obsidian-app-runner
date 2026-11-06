import { beforeEach, describe, expect, it } from "vitest";
import AppRunnerPlugin, { UNSUPPORTED_PLATFORM_NOTICE } from "../../src/main";
import { POP_OUT_COMMAND_ID } from "../../src/commands";
import { AppRunnerView, VIEW_TYPE_APP } from "../../src/webview-view";
import { Notice, Platform, WorkspaceLeaf, type Plugin as MockPlugin } from "../obsidian-mock";

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
    getLeavesOfType: () => [] as unknown[],
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
  async function loaded(urlOverride = "") {
    const made = makePlugin();
    made.plugin.stored = {
      vaultKey: "k",
      projects: [{ name: "Live Captions", slug: "live-captions", folder: "/x", command: "c", urlOverride, killOnClose: true, openInBrowser: false }],
    };
    await made.plugin.onload();
    return made;
  }

  it("Stop shows nothing running", async () => {
    const { plugin } = await loaded();
    plugin.commands.get("stop-live-captions")!.callback!();
    expect(Notice.messages).toEqual(["Nothing running for Live Captions."]);
  });

  it("Open without an override shows a notice that starting comes later, and opens no tab", async () => {
    const { plugin, leaves } = await loaded();
    await plugin.openProject("live-captions");
    expect(Notice.messages[0]).toMatch(/Starting Live Captions arrives with the next App Runner update/);
    expect(leaves).toEqual([]);
  });

  it("Open with an override opens a tab with the slug as its only state", async () => {
    const { plugin, leaves } = await loaded("http://127.0.0.1:8957");
    await plugin.openProject("live-captions");
    expect(leaves).toHaveLength(1);
    expect(leaves[0].viewState).toMatchObject({ type: VIEW_TYPE_APP, state: { slug: "live-captions" } });
    expect(Notice.messages).toEqual([]);
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
      openExternal() {},
      notify() {},
    });
    plugin.commands.get(POP_OUT_COMMAND_ID)!.callback!();
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).not.toMatch(/not an App Runner tab/);
  });
});
