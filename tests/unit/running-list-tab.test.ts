import { beforeEach, describe, expect, it } from "vitest";
import { ProjectCommands } from "../../src/commands";
import { ProjectManager } from "../../src/manager";
import { buildRunningRows, type RunningRow } from "../../src/running-list-model";
import { stubSeams } from "../../src/seams";
import { AppRunnerSettingTab, NO_RUNNING_APPS_TEXT, type RunningListHost } from "../../src/settings-tab";
import { SettingsStore } from "../../src/settings-store";
import type { InstanceInfo } from "../../src/instance";
import { fakeFs, memoryPersistence } from "../helpers";
import { FakeNode, Plugin, Setting } from "../obsidian-mock";

const info = (over: Partial<InstanceInfo> = {}): InstanceInfo => ({
  slug: "live-captions",
  name: "Live Captions",
  state: "running",
  port: 8957,
  url: "http://127.0.0.1:8957/",
  startedAt: new Date(2026, 10, 7, 9, 0, 0).getTime(),
  held: false,
  heldReason: "",
  adopted: false,
  ...over,
});

/** A running-list host the test drives by hand: change `infos` or `sessions`, then `fire()` as the plugin's events would. */
function listHost() {
  const state = { infos: [] as InstanceInfo[], sessions: {} as Record<string, number>, logs: new Set<string>() };
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const host: RunningListHost = {
    rows: (): RunningRow[] => buildRunningRows(state.infos, { sessions: (s) => state.sessions[s] ?? 0, logExists: (s) => state.logs.has(s) }),
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    open: (s) => void calls.push(`open ${s}`),
    stop: (s) => void calls.push(`stop ${s}`),
    showLog: (s) => void calls.push(`log ${s}`),
  };
  return { state, host, listeners, calls, fire: () => [...listeners].forEach((l) => l()) };
}

async function setup(running?: RunningListHost) {
  const plugin = new Plugin({}, { id: "app-runner" });
  const store = new SettingsStore(memoryPersistence(), { fs: fakeFs() });
  await store.load();
  const commands = new ProjectCommands(plugin, "app-runner", { open() {}, stop() {}, popOutCurrentTab() {} }, () => undefined);
  const manager = new ProjectManager(store, commands, stubSeams, () => {});
  const tab = new AppRunnerSettingTab({} as never, plugin as never, store, manager, undefined, running);
  return { tab };
}

/** The Settings drawn into the running section, newest render only. */
function runningSettings(tab: AppRunnerSettingTab): Setting[] {
  const section = (tab.containerEl as unknown as FakeNode).children[0];
  return Setting.all.filter((s) => s.containerEl === section);
}
const runningSection = (tab: AppRunnerSettingTab) => (tab.containerEl as unknown as FakeNode).children[0];

beforeEach(() => Setting.reset());

describe("G7 the running list in settings", () => {
  it("an empty list shows the empty-state line and no rows", async () => {
    const h = listHost();
    const { tab } = await setup(h.host);
    tab.display();
    expect(Setting.all[0]).toMatchObject({ name: "Running apps", heading: true });
    expect(runningSettings(tab)).toEqual([]);
    expect(runningSection(tab).children.map((c) => c.text)).toEqual([NO_RUNNING_APPS_TEXT]);
  });

  it("shows one row per instance: name, state, port, started time, tabs, and Open, Stop, Show log", async () => {
    const h = listHost();
    h.state.infos = [info(), info({ slug: "build-dashboard", name: "Build Dashboard", port: 4317, state: "starting", startedAt: new Date(2026, 10, 7, 9, 30, 0).getTime() })];
    h.state.sessions = { "live-captions": 2 };
    h.state.logs.add("live-captions");
    const { tab } = await setup(h.host);
    tab.display();
    const rows = runningSettings(tab);
    expect(rows.map((r) => [r.name, r.desc])).toEqual([
      ["Live Captions", "running  ·  port 8957  ·  started 09:00:00  ·  2 tabs"],
      ["Build Dashboard", "starting  ·  port 4317  ·  started 09:30:00  ·  0 tabs"],
    ]);
    expect(rows[0].buttons.map((b) => b.text)).toEqual(["Open", "Stop", "Show log"]);
    expect(rows[0].buttons.map((b) => b.disabled)).toEqual([false, false, false]);
    // Starting: Open needs a running app; no log file yet for it.
    expect(rows[1].buttons.map((b) => b.disabled)).toEqual([true, false, true]);
    expect(runningSection(tab).children).toEqual([]); // the empty-state line is gone
  });

  it("a Held instance reads Held with its reason", async () => {
    const h = listHost();
    h.state.infos = [info({ held: true, heldReason: "popped out to the browser" })];
    const { tab } = await setup(h.host);
    tab.display();
    expect(runningSettings(tab)[0].desc).toContain("Held: popped out to the browser");
  });

  it("Show log is disabled when no log file exists", async () => {
    const h = listHost();
    h.state.infos = [info()];
    const { tab } = await setup(h.host);
    tab.display();
    expect(runningSettings(tab)[0].buttons[2]).toMatchObject({ text: "Show log", disabled: true });
  });

  it("Open, Stop and Show log call the host with the row's slug", async () => {
    const h = listHost();
    h.state.infos = [info()];
    h.state.logs.add("live-captions");
    const { tab } = await setup(h.host);
    tab.display();
    const [open, stop, log] = runningSettings(tab)[0].buttons;
    open.handler!();
    stop.handler!();
    log.handler!();
    expect(h.calls).toEqual(["open live-captions", "stop live-captions", "log live-captions"]);
    expect(stop.warning).toBe(true);
  });

  it("without a running-list host the section is not drawn", async () => {
    const { tab } = await setup();
    tab.display();
    expect(Setting.all.map((s) => s.name)).not.toContain("Running apps");
  });
});

describe("G7 the row refreshes without reopening settings", () => {
  it("a state, port or session change redraws the running section only", async () => {
    const h = listHost();
    h.state.infos = [info({ state: "starting", port: null })];
    const { tab } = await setup(h.host);
    tab.display();
    expect(runningSettings(tab)[0].desc).toContain("starting  ·  port –");

    Setting.reset();
    h.state.infos = [info({ state: "running", port: 8957 })];
    h.fire();
    expect(runningSettings(tab).map((r) => r.desc)).toEqual(["running  ·  port 8957  ·  started 09:00:00  ·  0 tabs"]);

    Setting.reset();
    h.state.sessions = { "live-captions": 2 };
    h.fire();
    expect(runningSettings(tab)[0].desc).toContain("2 tabs");

    Setting.reset();
    h.state.infos = [info({ port: 9100 })];
    h.fire();
    expect(runningSettings(tab)[0].desc).toContain("port 9100");

    Setting.reset();
    h.state.infos = [];
    h.fire();
    expect(runningSettings(tab)).toEqual([]);
    expect(runningSection(tab).children.map((c) => c.text)).toEqual([NO_RUNNING_APPS_TEXT]);

    // None of those redraws rebuilt the form, so what is typed in it is kept.
    expect(Setting.all).toEqual([]);
  });

  it("subscribes when the tab is shown, and unsubscribes when it hides", async () => {
    const h = listHost();
    const { tab } = await setup(h.host);
    expect(h.listeners.size).toBe(0);
    tab.display();
    expect(h.listeners.size).toBe(1);
    tab.display(); // a re-render (add project, delete) must not stack a second listener
    expect(h.listeners.size).toBe(1);
    tab.hide();
    expect(h.listeners.size).toBe(0);

    Setting.reset();
    h.state.infos = [info()];
    h.fire();
    expect(Setting.all).toEqual([]); // nothing draws into a hidden tab
    tab.hide(); // hiding twice is harmless
  });

  it("showing the tab again after a hide picks the current rows up and listens again", async () => {
    const h = listHost();
    const { tab } = await setup(h.host);
    tab.display();
    tab.hide();
    h.state.infos = [info()];
    Setting.reset();
    tab.display();
    expect(runningSettings(tab).map((r) => r.name)).toEqual(["Live Captions"]);
    expect(h.listeners.size).toBe(1);
  });
});
