import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STILL_RUNNING_TEXT } from "../../src/running-list-model";
import { logPath } from "../../src/runtime-paths";
import { AppRunnerView, VIEW_TYPE_APP } from "../../src/webview-view";
import { FakeNode, Notice, Platform, Setting } from "../obsidian-mock";
import { launch, type Launched } from "../plugin-harness";
import { FakeWorld, project } from "../process-fakes";

const SLUG = "live-captions";
const RESULT = { history: false };

beforeEach(() => {
  Notice.reset();
  Setting.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
  // Electron's window can embed <webview>: the custom element exists. Without it the tab would open the browser instead.
  (globalThis as { customElements?: unknown }).customElements = { get: () => class {} };
});

afterEach(() => {
  delete (globalThis as { customElements?: unknown }).customElements;
});

/** Session one: the app is started and a tab is open; then Obsidian quits (SIGKILL or menu: the app is not touched). */
async function firstSession(over: Parameters<typeof project>[0] = {}) {
  const w = new FakeWorld(project(over));
  const l = await launch(w);
  const opening = l.plugin.openProject(SLUG);
  await w.clock.settle();
  w.serve(8957);
  await w.clock.run(opening);
  const entry = { ...w.registry.entries.get(SLUG)! };
  l.plugin.onunload();
  Notice.reset(); // only what the second session says
  return { w, entry, spawned: w.spawns.length };
}

/** A tab as Obsidian builds it from the saved state when the layout is restored. */
async function restoredView(l: Launched) {
  const create = l.plugin.views.get(VIEW_TYPE_APP) as (leaf: unknown) => AppRunnerView;
  const leaf = l.leaves.find((x) => x.viewState?.type === VIEW_TYPE_APP)!;
  const view = create(leaf);
  await view.onOpen();
  await view.setState({ slug: SLUG }, RESULT);
  return view;
}

const dom = (v: AppRunnerView) => v.contentEl as unknown as FakeNode;
const webviewSrc = (v: AppRunnerView) => dom(v).all().find((n) => n.tag === "webview")?.attrs.src;
const buttons = (v: AppRunnerView) => dom(v).all().filter((n) => n.tag === "button");

describe("GP7 a restored tab reconnects to the instance that kept running (G16)", () => {
  it("counts as a session from its saved state before the webview has loaded, so the app is kept", async () => {
    const { w } = await firstSession();
    const l = await launch(w, { restoredTabs: [SLUG] });
    expect(l.plugin.instances.isAdopted(SLUG)).toBe(true);
    l.layoutReady();
    expect(l.plugin.sessions.count(SLUG)).toBe(1); // no view exists yet: the count comes from the leaf's view state
    expect(l.leaves[0].view).toBeNull();

    await w.clock.advance(5 * 60_000);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.signals).toEqual([]);
    expect(Notice.messages).toEqual([]);
  });

  it("the tab loads the same instance: same pid, same pgid, no new spawn", async () => {
    const { w, entry, spawned } = await firstSession();
    const l = await launch(w, { restoredTabs: [SLUG] });
    l.layoutReady();
    const view = await restoredView(l);

    expect(webviewSrc(view)).toBe("http://127.0.0.1:8957/");
    expect(w.spawns).toHaveLength(spawned);
    const after = w.registry.entries.get(SLUG)!;
    expect([after.pid, after.pgid]).toEqual([entry.pid, entry.pgid]);
    expect(w.procs.some((p) => p.pid === entry.pid && p.pgid === entry.pgid)).toBe(true);
  });

  it("the URL is read from the instance at tab load, so a port that changed while Obsidian was closed is followed", async () => {
    const { w } = await firstSession();
    // The app was restarted by hand on another port inside the same group while Obsidian was closed.
    w.answers.delete(8957);
    w.listening.set(w.leaderPid(), [["127.0.0.1", 8965]]);
    w.answers.set(8965, { html: true });
    const l = await launch(w, { restoredTabs: [SLUG] });
    l.layoutReady();
    const view = await restoredView(l);
    expect(webviewSrc(view)).toBe("http://127.0.0.1:8965/");
    expect(l.plugin.instances.snapshots()[0].port).toBe(8965);
  });

  it("the running list counts the restored tab: 1 tab, same port", async () => {
    const { w } = await firstSession();
    const l = await launch(w, { restoredTabs: [SLUG] });
    l.layoutReady();
    l.tab.display();
    expect(l.rows()).toHaveLength(1);
    expect(l.rows()[0].desc).toMatch(/port 8957 {2}· {2}started \d\d:\d\d:\d\d {2}· {2}1 tab/);
  });

  it("closing the restored tab later stops the app 15 s afterwards, as for any other tab", async () => {
    const { w } = await firstSession();
    const l = await launch(w, { restoredTabs: [SLUG] });
    l.layoutReady();
    await w.clock.advance(60_000);
    l.leaves.splice(0);
    l.layoutChange();
    await w.clock.advance(14_000);
    expect(w.signals).toEqual([]);
    await w.clock.advance(1_000);
    expect(w.signals[0]?.[1]).toBe("SIGTERM");
    await w.clock.advance(6_000);
    expect(l.plugin.instances.isRunning(SLUG)).toBe(false);
  });
});

describe("E13 a tab restored after the app died shows App stopped and never starts anything (G16)", () => {
  async function diedWhileClosed() {
    const { w, spawned } = await firstSession();
    w.procs = []; // killed while Obsidian was closed
    const lines = Array.from({ length: 14 }, (_, i) => `log line ${i + 1}`);
    w.logs.set(logPath("/runtime/k", SLUG), lines.join("\n"));
    const l = await launch(w, { restoredTabs: [SLUG] });
    return { w, l, spawned };
  }

  it("the stale entry is dropped, the panel offers Start and shows the last 10 log lines", async () => {
    const { w, l } = await diedWhileClosed();
    l.layoutReady();
    expect(w.registry.entries.has(SLUG)).toBe(false);
    expect(l.plugin.instances.isRunning(SLUG)).toBe(false);
    expect(l.plugin.sessions.count(SLUG)).toBe(1);

    const view = await restoredView(l);
    const text = dom(view).textContent();
    expect(text).toContain("Live Captions");
    expect(buttons(view).map((b) => b.text)).toEqual(["Start"]);
    expect(webviewSrc(view)).toBeUndefined();
    const log = dom(view).all().find((n) => n.cls === "app-runner-log")!;
    expect(log.text.split("\n")).toEqual(Array.from({ length: 10 }, (_, i) => `log line ${i + 5}`));
  });

  it("never auto-starts: no spawn however long the tab sits there, however many layout changes", async () => {
    const { w, l, spawned } = await diedWhileClosed();
    l.layoutReady();
    await restoredView(l);
    l.layoutChange();
    await w.clock.advance(10 * 60_000);
    expect(w.spawns).toHaveLength(spawned);
    expect(l.plugin.instances.isRunning(SLUG)).toBe(false);
  });

  it("Start in the panel starts the app, and the tab reloads into it", async () => {
    const { w, l, spawned } = await diedWhileClosed();
    l.layoutReady();
    const view = await restoredView(l);
    const clicking = (async () => buttons(view)[0].click())();
    await clicking;
    await w.clock.settle();
    w.serve(8957);
    await w.clock.advance(5000);
    await w.clock.settle();
    expect(w.spawns).toHaveLength(spawned + 1);
    expect(webviewSrc(view)).toBe("http://127.0.0.1:8957/");
  });
});

describe("GP8 an app that kept running with Kill off and no tab (G7)", () => {
  async function forgotten() {
    const { w, entry } = await firstSession({ killOnClose: false });
    const l = await launch(w, { restoredTabs: [] });
    return { w, l, entry };
  }

  it("the notice says it is still running from the last session, and nothing is stopped", async () => {
    const { w, l } = await forgotten();
    Notice.reset();
    l.layoutReady();
    await w.clock.advance(60_000);
    expect(Notice.messages).toEqual(["Live Captions is still running from the last session."]);
    expect(w.signals).toEqual([]);
  });

  it("the settings list marks the row, shows the rediscovered port and offers Open and Stop; Stop ends the group", async () => {
    const { w, l, entry } = await forgotten();
    l.layoutReady();
    l.tab.display();
    const [row] = l.rows();
    expect(row.name).toBe("Live Captions");
    expect(row.desc).toContain("port 8957");
    expect(row.desc).toContain(STILL_RUNNING_TEXT);
    expect(row.buttons.map((b) => b.text)).toEqual(expect.arrayContaining(["Open", "Stop"]));

    const stop = row.buttons.find((b) => b.text === "Stop")!;
    const stopping = Promise.resolve(stop.handler?.());
    await w.clock.run(stopping);
    await w.clock.advance(6000);
    expect(w.procs).toEqual([]);
    expect(new Set(w.signals.map(([pid]) => pid))).toEqual(new Set([-entry.pgid])); // only the recorded group
    expect(w.registry.entries.size).toBe(0);
    l.tab.display();
    expect(l.rows().filter((r) => r.name === "Live Captions" && r.desc.includes("port"))).toEqual([]);
  });

  it("Open on the adopted row opens a tab on the same instance without spawning", async () => {
    const { w, l } = await forgotten();
    l.layoutReady();
    const spawned = w.spawns.length;
    const opening = l.plugin.openProject(SLUG);
    await w.clock.run(opening);
    expect(w.spawns).toHaveLength(spawned);
    expect(l.leaves.map((x) => x.viewState?.state)).toEqual([{ slug: SLUG }]);
  });

  it("an adopted row is no longer marked once it has been stopped and started again", async () => {
    const { w, l } = await forgotten();
    l.layoutReady();
    await w.clock.run(l.plugin.stopProject(SLUG));
    const opening = l.plugin.openProject(SLUG);
    await w.clock.settle();
    w.serve(8957);
    await w.clock.run(opening);
    expect(l.plugin.instances.isAdopted(SLUG)).toBe(false);
    l.tab.display();
    expect(l.rows()[0].desc).not.toContain(STILL_RUNNING_TEXT);
  });
});
