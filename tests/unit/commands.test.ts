import { beforeEach, describe, expect, it, vi } from "vitest";
import { POP_OUT_COMMAND_ID, POP_OUT_COMMAND_NAME, ProjectCommands, type InternalCommands } from "../../src/commands";
import { ProjectManager } from "../../src/manager";
import type { RuntimeSeams } from "../../src/seams";
import { SettingsStore } from "../../src/settings-store";
import { fakeFs, input, memoryPersistence } from "../helpers";
import { Notice, Plugin } from "../obsidian-mock";

const PLUGIN_ID = "app-runner";

/** A fake `app.commands`: addCommand on the plugin puts the command here under `<plugin id>:<id>`, as Obsidian does. */
function fakeRegistry() {
  const registry: InternalCommands & { commands: Record<string, unknown>; removed: string[] } = {
    commands: {},
    removed: [],
    removeCommand(fullId: string) {
      registry.removed.push(fullId);
      delete registry.commands[fullId];
    },
  };
  return registry;
}

class FakePlugin extends Plugin {
  constructor(private readonly registry: ReturnType<typeof fakeRegistry>) {
    super({}, { id: PLUGIN_ID });
  }
  addCommand(c: { id: string; name: string; callback?: () => void }) {
    this.registry.commands[`${PLUGIN_ID}:${c.id}`] = c;
    return super.addCommand(c);
  }
}

function setup(seams: Partial<RuntimeSeams> = {}, registryOverride?: () => InternalCommands | undefined) {
  const registry = fakeRegistry();
  const plugin = new FakePlugin(registry);
  const actions = { open: vi.fn(), stop: vi.fn(), popOutCurrentTab: vi.fn() };
  const commands = new ProjectCommands(plugin, PLUGIN_ID, actions, registryOverride ?? (() => registry));
  const store = new SettingsStore(memoryPersistence(), { fs: fakeFs() });
  const notices: string[] = [];
  const changed = vi.fn();
  const full: RuntimeSeams = { isRunning: () => false, removeRuntime: async () => {}, ...seams };
  const manager = new ProjectManager(store, commands, full, (m) => notices.push(m), changed);
  return { registry, plugin, actions, commands, store, manager, notices, changed };
}

beforeEach(() => Notice.reset());

describe("registration", () => {
  it("adding a project registers exactly open-<slug> and stop-<slug>", async () => {
    const { manager, plugin, store } = setup();
    await store.load();
    manager.registerAll();
    expect([...plugin.commands.keys()]).toEqual([POP_OUT_COMMAND_ID]);
    await manager.add(input());
    expect([...plugin.commands.values()].map((c) => [c.id, c.name])).toEqual([
      [POP_OUT_COMMAND_ID, POP_OUT_COMMAND_NAME],
      ["open-live-captions", "Open Live Captions"],
      ["stop-live-captions", "Stop Live Captions"],
    ]);
  });

  it("registerAll registers two commands per stored project plus the one global command", async () => {
    const { manager, plugin, store } = setup();
    await store.load();
    await store.add(input());
    await store.add(input({ name: "Build Dashboard", folder: "/work/build-dashboard" }));
    manager.registerAll();
    expect([...plugin.commands.keys()].sort()).toEqual(
      ["open-build-dashboard", "open-live-captions", POP_OUT_COMMAND_ID, "stop-build-dashboard", "stop-live-captions"].sort(),
    );
  });

  it("a rejected add registers nothing", async () => {
    const { manager, plugin, store } = setup();
    await store.load();
    await manager.add(input({ command: "" }));
    expect(plugin.commands.size).toBe(0);
  });

  it("the commands call their actions with the slug", async () => {
    const { manager, plugin, actions, store } = setup();
    await store.load();
    manager.registerAll();
    await manager.add(input());
    plugin.commands.get("open-live-captions")!.callback!();
    plugin.commands.get("stop-live-captions")!.callback!();
    plugin.commands.get(POP_OUT_COMMAND_ID)!.callback!();
    expect(actions.open).toHaveBeenCalledWith("live-captions");
    expect(actions.stop).toHaveBeenCalledWith("live-captions");
    expect(actions.popOutCurrentTab).toHaveBeenCalledTimes(1);
  });
});

describe("edit (E12)", () => {
  it("renaming Live Captions to Captions keeps open-live-captions and relabels it", async () => {
    const { manager, plugin, store } = setup();
    await store.load();
    await manager.add(input());
    const r = await manager.edit("live-captions", input({ name: "Captions" }));
    expect(r.ok).toBe(true);
    expect(plugin.commands.has("open-live-captions")).toBe(true);
    expect(plugin.commands.has("stop-live-captions")).toBe(true);
    expect(plugin.commands.has("open-captions")).toBe(false);
    expect(plugin.commands.get("open-live-captions")!.name).toBe("Open Captions");
    expect(plugin.commands.get("stop-live-captions")!.name).toBe("Stop Captions");
    expect(plugin.commands.size).toBe(2);
  });

  it("the relabelled command still acts on the original slug", async () => {
    const { manager, plugin, actions, store } = setup();
    await store.load();
    await manager.add(input());
    await manager.edit("live-captions", input({ name: "Captions" }));
    plugin.commands.get("open-live-captions")!.callback!();
    expect(actions.open).toHaveBeenCalledWith("live-captions");
  });

  it("tells the user when a running project's folder, command or URL changed", async () => {
    const { manager, store, notices } = setup({ isRunning: () => true });
    await store.load();
    await manager.add(input());
    await manager.edit("live-captions", input({ command: "npm start" }));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/applies the next time it starts/);
    await manager.edit("live-captions", input({ command: "npm start", name: "Renamed" }));
    expect(notices).toHaveLength(1); // a rename alone says nothing
  });

  it("says nothing for a project that is not running", async () => {
    const { manager, store, notices } = setup();
    await store.load();
    await manager.add(input());
    await manager.edit("live-captions", input({ command: "npm start" }));
    expect(notices).toEqual([]);
  });

  it("refreshes open tabs after an edit", async () => {
    const { manager, store, changed } = setup();
    await store.load();
    await manager.add(input());
    await manager.edit("live-captions", input({ name: "Captions" }));
    expect(changed).toHaveBeenCalled();
  });

  it("toggles are stored without touching the commands", async () => {
    const { manager, store, plugin } = setup();
    await store.load();
    await manager.add(input());
    await manager.setToggle("live-captions", "killOnClose", false);
    expect(store.get("live-captions")?.killOnClose).toBe(false);
    expect(plugin.commands.size).toBe(2);
  });
});

describe("delete (G3)", () => {
  it("removes the commands through the internal registry, and the settings row", async () => {
    const { manager, store, registry, plugin } = setup();
    await store.load();
    await manager.add(input());
    const confirm = vi.fn(async () => true);
    expect(await manager.delete("live-captions", confirm)).toBe("deleted");
    expect(confirm).not.toHaveBeenCalled(); // not running: no confirm step
    expect(registry.removed.sort()).toEqual(["app-runner:open-live-captions", "app-runner:stop-live-captions"]);
    expect(Object.keys(registry.commands)).toEqual([]);
    expect(store.projects).toEqual([]);
    // the plugin's own removeCommand was not needed
    expect(plugin.commands.size).toBe(2);
  });

  it("a running project is only deleted after the confirm step says yes", async () => {
    const removeRuntime = vi.fn(async () => {});
    const { manager, store, registry } = setup({ isRunning: (s) => s === "live-captions", removeRuntime });
    await store.load();
    await manager.add(input());

    const no = vi.fn(async () => false);
    expect(await manager.delete("live-captions", no)).toBe("cancelled");
    expect(no).toHaveBeenCalledTimes(1);
    expect(store.projects).toHaveLength(1);
    expect(registry.removed).toEqual([]);
    expect(removeRuntime).not.toHaveBeenCalled();

    const yes = vi.fn(async () => true);
    expect(await manager.delete("live-captions", yes)).toBe("deleted");
    expect(removeRuntime).toHaveBeenCalledWith(expect.objectContaining({ slug: "live-captions" }));
    expect(store.projects).toEqual([]);
  });

  it("deleting an unknown slug is reported, not thrown", async () => {
    const { manager, store } = setup();
    await store.load();
    expect(await manager.delete("nope", async () => true)).toBe("missing");
  });
});

describe("best-effort removal", () => {
  it("falls back to deleting from app.commands.commands when the registry has no removeCommand", async () => {
    const registry = { commands: { "app-runner:open-x": {}, "app-runner:stop-x": {}, "other:keep": {} } } as InternalCommands;
    const { commands } = setup({}, () => registry);
    expect(commands.unregister("x")).toBe(2);
    expect(Object.keys(registry.commands!)).toEqual(["other:keep"]);
  });

  it("falls back to the plugin's removeCommand when the internal registry is missing", async () => {
    const { commands, plugin, manager, store } = setup({}, () => undefined);
    await store.load();
    await manager.add(input());
    expect(plugin.commands.size).toBe(2);
    expect(commands.unregister("live-captions")).toBe(2);
    expect(plugin.commands.size).toBe(0);
  });

  it("never throws when the registry misbehaves: the commands are just gone after a reload", () => {
    const hostile: InternalCommands = {
      removeCommand() {
        throw new Error("internal API changed");
      },
    };
    const { commands } = setup({}, () => hostile);
    expect(() => commands.unregister("x")).not.toThrow();
    expect(commands.unregister("x")).toBe(0);
  });

  it("returns 0 when nothing can be removed", () => {
    const plugin = new Plugin({}, { id: PLUGIN_ID });
    (plugin as { removeCommand?: unknown }).removeCommand = undefined;
    const commands = new ProjectCommands(plugin, PLUGIN_ID, { open() {}, stop() {}, popOutCurrentTab() {} }, () => ({}));
    expect(commands.unregister("x")).toBe(0);
  });
});
