import { beforeEach, describe, expect, it } from "vitest";
import { ProjectCommands } from "../../src/commands";
import { ProjectManager } from "../../src/manager";
import { stubSeams, type RuntimeSeams } from "../../src/seams";
import { AppRunnerSettingTab } from "../../src/settings-tab";
import { SettingsStore } from "../../src/settings-store";
import { fakeFs, input, memoryPersistence } from "../helpers";
import { Modal, Plugin, Setting } from "../obsidian-mock";

async function setup(seams: RuntimeSeams = stubSeams) {
  const plugin = new Plugin({}, { id: "app-runner" });
  const store = new SettingsStore(memoryPersistence(), { fs: fakeFs() });
  await store.load();
  const commands = new ProjectCommands(plugin, "app-runner", { open() {}, stop() {}, popOutCurrentTab() {} }, () => undefined);
  const manager = new ProjectManager(store, commands, seams, () => {});
  const tab = new AppRunnerSettingTab({} as never, plugin as never, store, manager);
  const show = () => {
    Setting.reset();
    tab.display();
    return Setting.all;
  };
  /** Display re-renders append to Setting.all, so the latest render is the one that counts. */
  const field = (name: string) => Setting.all.findLast((s) => s.name === name)!;
  return { plugin, store, manager, tab, show, field };
}

beforeEach(() => {
  Setting.reset();
  Modal.reset();
});

describe("Add project form (G1, GP1)", () => {
  it("has name, folder, command, URL override, Kill and Open-in-browser, and nothing else (F9)", async () => {
    const { show } = await setup();
    const names = show().map((s) => s.name).filter(Boolean);
    expect(names).toEqual([
      "Projects",
      "Add project",
      "Name",
      "Folder",
      "Command",
      "URL override (optional)",
      "Kill when all tabs closed",
      "Open in browser",
    ]);
    const controls = Setting.all.flatMap((s) => [...s.texts.map(() => "text"), ...s.toggles.map(() => "toggle")]);
    expect(controls).toEqual(["text", "text", "text", "text", "toggle", "toggle"]); // one command field
  });

  it("starts with Kill on and Open in browser off", async () => {
    const { show, field } = await setup();
    show();
    expect(field("Kill when all tabs closed").toggles[0].value).toBe(true);
    expect(field("Open in browser").toggles[0].value).toBe(false);
  });

  it("GP1: filling the form and clicking Add project saves a row with the toggles as stated", async () => {
    const { show, field, store, plugin } = await setup();
    show();
    field("Name").texts[0].handler!("Live Captions");
    field("Folder").texts[0].handler!("/work/live-captions");
    field("Command").texts[0].handler!("npm run start");
    const addButton = Setting.all.findLast((s) => s.buttons.some((b) => b.text === "Add project"))!.buttons[0];
    await addButton.handler!();

    expect(store.projects).toHaveLength(1);
    expect(store.projects[0]).toMatchObject({ name: "Live Captions", slug: "live-captions", killOnClose: true, openInBrowser: false });
    expect([...plugin.commands.keys()].sort()).toEqual(["open-live-captions", "stop-live-captions"]);

    // The re-rendered tab shows the row, with Kill on and Open in browser off, and an empty form again.
    const row = Setting.all.findLast((s) => s.name === "Live Captions")!;
    expect(row.desc).toContain("/work/live-captions");
    expect(row.desc).toContain("npm run start");
    expect(row.toggles.map((t) => t.value)).toEqual([true, false]);
    expect(Setting.all.findLast((s) => s.name === "Name")!.texts[0].value).toBe("");
  });

  it("shows errors inline and keeps what was typed", async () => {
    const { show, field, store, tab } = await setup();
    show();
    field("Name").texts[0].handler!("Live Captions");
    field("Folder").texts[0].handler!("/work/missing");
    field("Command").texts[0].handler!("  ");
    field("URL override (optional)").texts[0].handler!("http://example.com");
    await Setting.all.findLast((s) => s.buttons.some((b) => b.text === "Add project"))!.buttons[0].handler!();

    expect(store.projects).toEqual([]);
    const errorText = (tab.containerEl as unknown as { textContent(): string }).textContent();
    expect(errorText).toContain("This folder does not exist");
    expect(errorText).toContain("Enter the start command");
    expect(errorText).toContain("Only loopback addresses are allowed");
    expect(Setting.all.findLast((s) => s.name === "Name")!.texts[0].value).toBe("Live Captions");
  });

  it("two quick clicks on Add create one project", async () => {
    const { show, field, store } = await setup();
    show();
    field("Name").texts[0].handler!("Live Captions");
    field("Folder").texts[0].handler!("/work/live-captions");
    field("Command").texts[0].handler!("npm run start");
    const button = Setting.all.findLast((s) => s.buttons.some((b) => b.text === "Add project"))!.buttons[0];
    await Promise.all([button.handler!(), button.handler!()]);
    expect(store.projects).toHaveLength(1);
  });
});

describe("rows (G2, G3)", () => {
  async function withRow(seams?: RuntimeSeams) {
    const s = await setup(seams);
    await s.manager.add(input());
    s.show();
    const row = Setting.all.findLast((x) => x.name === "Live Captions")!;
    return { ...s, row };
  }

  it("the row toggles are stored immediately", async () => {
    const { row, store } = await withRow();
    row.toggles[0].handler!(false);
    row.toggles[1].handler!(true);
    await Promise.resolve();
    expect(store.get("live-captions")).toMatchObject({ killOnClose: false, openInBrowser: true });
  });

  it("Edit fills the form, and Save changes the name but not the command ids", async () => {
    const { row, show, field, store, plugin } = await withRow();
    await row.buttons.find((b) => b.text === "Edit")!.handler!();
    expect(field("Name").texts[0].value).toBe("Live Captions");
    expect(field("Edit project")).toBeDefined();
    field("Name").texts[0].handler!("Captions");
    await Setting.all.findLast((s) => s.buttons.some((b) => b.text === "Save"))!.buttons[0].handler!();
    expect(store.get("live-captions")?.name).toBe("Captions");
    expect(plugin.commands.has("open-live-captions")).toBe(true);
    expect(plugin.commands.get("open-live-captions")!.name).toBe("Open Captions");
    show();
  });

  it("a row toggle flipped before Edit is not reverted by Save", async () => {
    const { row, field, store } = await withRow();
    row.toggles[0].handler!(false); // Kill off
    row.toggles[1].handler!(true); // Open in browser on
    await row.buttons.find((b) => b.text === "Edit")!.handler!(); // the same, stale, row as drawn before the toggles
    expect(field("Kill when all tabs closed").toggles[0].value).toBe(false);
    expect(field("Open in browser").toggles[0].value).toBe(true);
    field("Name").texts[0].handler!("Captions");
    await Setting.all.findLast((s) => s.buttons.some((b) => b.text === "Save"))!.buttons[0].handler!();
    expect(store.get("live-captions")).toMatchObject({ name: "Captions", killOnClose: false, openInBrowser: true });
  });

  it("a row toggle flipped while the Edit form is open is not overwritten by Save", async () => {
    const { row, field, store } = await withRow();
    await row.buttons.find((b) => b.text === "Edit")!.handler!();
    row.toggles[0].handler!(false);
    row.toggles[1].handler!(true);
    expect(field("Kill when all tabs closed").toggles[0].value).toBe(false); // the form shows it too
    expect(field("Open in browser").toggles[0].value).toBe(true);
    await Setting.all.findLast((s) => s.buttons.some((b) => b.text === "Save"))!.buttons[0].handler!();
    expect(store.get("live-captions")).toMatchObject({ killOnClose: false, openInBrowser: true });
  });

  it("a row toggle of another project leaves the open Edit form alone", async () => {
    const { row, field, store, manager, show } = await withRow();
    await manager.add(input({ name: "Second", folder: "/work/other" }));
    show();
    await row.buttons.find((b) => b.text === "Edit")!.handler!();
    field("Name").texts[0].handler!("Typed but unsaved");
    Setting.all.findLast((x) => x.name === "Second")!.toggles[0].handler!(false);
    expect(store.get("second")?.killOnClose).toBe(false);
    expect(field("Name").texts[0].value).toBe("Live Captions"); // no redraw
  });

  it("Delete on a project that is not running deletes with no modal", async () => {
    const { row, store, plugin } = await withRow();
    await row.buttons.find((b) => b.text === "Delete")!.handler!();
    expect(Modal.opened).toEqual([]);
    expect(store.projects).toEqual([]);
    expect(plugin.commands.size).toBe(0);
  });

  it("deleting the project that is open in the Edit form puts the form back to Add, so Save cannot target a project that is gone", async () => {
    const { row, store, field } = await withRow();
    await row.buttons.find((b) => b.text === "Edit")!.handler!();
    expect(field("Edit project")).toBeDefined();
    await row.buttons.find((b) => b.text === "Delete")!.handler!();
    expect(store.projects).toEqual([]);
    // The redraw after the delete is the last render: its form heading is Add, not Edit.
    const headings = Setting.all.filter((x) => x.name === "Edit project" || x.name === "Add project").map((x) => x.name);
    expect(headings.at(-1)).toBe("Add project");
  });

  it("Delete on a running project asks first; Cancel keeps it, Stop and delete removes it", async () => {
    const { row, store } = await withRow({ isRunning: () => true, removeRuntime: async () => {} });
    const pending = row.buttons.find((b) => b.text === "Delete")!.handler!();
    expect(Modal.opened).toHaveLength(1);
    const modal = Modal.opened[0];
    expect(modal.contentEl.textContent()).toContain("Stop and delete Live Captions?");
    const cancel = modal.contentEl.all().find((n) => n.text === "Cancel")!;
    cancel.click();
    await pending;
    expect(store.projects).toHaveLength(1);

    Modal.reset();
    const again = row.buttons.find((b) => b.text === "Delete")!.handler!();
    Modal.opened[0].contentEl.all().find((n) => n.text === "Stop and delete")!.click();
    await again;
    expect(store.projects).toEqual([]);
  });

  it("closing the confirm modal any other way (Escape) counts as Cancel", async () => {
    const { row, store } = await withRow({ isRunning: () => true, removeRuntime: async () => {} });
    const pending = row.buttons.find((b) => b.text === "Delete")!.handler!();
    Modal.opened[0].close();
    await pending;
    expect(store.projects).toHaveLength(1);
  });
});

describe("Show log (G17)", () => {
  async function withLogs(existing: boolean) {
    const plugin = new Plugin({}, { id: "app-runner" });
    const store = new SettingsStore(memoryPersistence(), { fs: fakeFs() });
    await store.load();
    const commands = new ProjectCommands(plugin, "app-runner", { open() {}, stop() {}, popOutCurrentTab() {} }, () => undefined);
    const manager = new ProjectManager(store, commands, stubSeams, () => {});
    const shown: string[] = [];
    const tab = new AppRunnerSettingTab({} as never, plugin as never, store, manager, { exists: () => existing, show: async (slug) => void shown.push(slug) });
    await manager.add(input());
    Setting.reset();
    tab.display();
    const row = Setting.all.findLast((x) => x.name === "Live Captions")!;
    return { row, shown, button: row.buttons.find((b) => b.text === "Show log")! };
  }

  it("a row has a Show log button that opens that project's log", async () => {
    const { button, shown } = await withLogs(true);
    expect(button.disabled).toBe(false);
    button.handler!();
    expect(shown).toEqual(["live-captions"]);
  });

  it("the button is disabled while the project has no log", async () => {
    const { button } = await withLogs(false);
    expect(button.disabled).toBe(true);
  });

  it("without log actions the button is disabled", async () => {
    const { row } = await (async () => {
      const s = await setup();
      await s.manager.add(input());
      s.show();
      return { row: Setting.all.findLast((x) => x.name === "Live Captions")! };
    })();
    expect(row.buttons.find((b) => b.text === "Show log")!.disabled).toBe(true);
  });
});
