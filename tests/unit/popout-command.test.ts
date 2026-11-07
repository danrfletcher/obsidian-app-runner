import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POP_OUT_COMMAND_ID, POP_OUT_COMMAND_NAME } from "../../src/commands";
import { AppRunnerView } from "../../src/webview-view";
import { Notice, Platform, Setting, WorkspaceLeaf } from "../obsidian-mock";
import { appTabs, mountTab, openApp, plugin, setWebviewAvailable, SLUG } from "../popout-rig";

/** The global "Pop out current App Runner tab to browser" command, through the real plugin. */

beforeEach(() => {
  Notice.reset();
  Setting.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
  setWebviewAvailable(true);
});
afterEach(() => setWebviewAvailable(false));

describe("the command is registered", () => {
  it("one global command, with the documented id and name, and no default hotkey (F1)", async () => {
    const { l } = await plugin({});
    const cmd = l.plugin.commands.get(POP_OUT_COMMAND_ID)!;
    expect(cmd).toBeDefined();
    expect(POP_OUT_COMMAND_NAME).toBe("Pop out current App Runner tab to browser");
    expect(cmd.name).toBe(POP_OUT_COMMAND_NAME);
    expect(cmd).not.toHaveProperty("hotkeys");
  });
});

describe("active-tab type detection", () => {
  it("a note (not an App Runner view): a notice, nothing opened, nothing Held, no tab closed", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    l.workspace.activeView = { getViewType: () => "markdown" };
    Notice.reset();

    l.plugin.commands.get(POP_OUT_COMMAND_ID)!.callback!();
    await w.clock.settle();
    expect(Notice.messages).toEqual(["The active tab is not an App Runner tab."]);
    expect(w.external).toEqual([]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(appTabs(l)).toHaveLength(1);
  });

  it("no active view at all: the same notice", async () => {
    const { w, l } = await plugin({});
    l.workspace.activeView = null;
    l.plugin.commands.get(POP_OUT_COMMAND_ID)!.callback!();
    await w.clock.settle();
    expect(Notice.messages).toEqual(["The active tab is not an App Runner tab."]);
    expect(w.external).toEqual([]);
  });

  it("an App Runner tab: no notice about the tab type, the browser opens the loopback URL once, the tab closes, the app is Held", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    const view = await mountTab(l);
    expect(view).toBeInstanceOf(AppRunnerView);
    l.workspace.activeView = view;
    Notice.reset();

    l.plugin.commands.get(POP_OUT_COMMAND_ID)!.callback!();
    await w.clock.settle();
    expect(Notice.messages).toEqual([]);
    expect(w.external).toEqual(["http://127.0.0.1:8957/"]);
    expect(appTabs(l)).toEqual([]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
  });

  it("running the command twice quickly opens one page", async () => {
    const { w, l } = await plugin({});
    await openApp(w, l);
    l.workspace.activeView = await mountTab(l);
    const run = l.plugin.commands.get(POP_OUT_COMMAND_ID)!.callback!;
    run();
    run();
    await w.clock.settle();
    expect(w.external).toEqual(["http://127.0.0.1:8957/"]);
  });

  it("an App Runner tab whose app is not running (a restored App stopped panel): a notice that nothing is running, no browser, no Held", async () => {
    const { w, l } = await plugin({}, { restoredTabs: [SLUG] });
    l.layoutReady();
    const view = await mountTab(l, l.leaves[0] as WorkspaceLeaf);
    l.workspace.activeView = view;
    Notice.reset();

    l.plugin.commands.get(POP_OUT_COMMAND_ID)!.callback!();
    await w.clock.settle();
    expect(Notice.messages).toEqual(["Live Captions is not running, so there is nothing to open in the browser."]);
    expect(w.external).toEqual([]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(l.leaves[0].detached).toBe(false);
  });
});
