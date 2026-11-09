import { describe, expect, it, vi } from "vitest";
import type { InstanceEvent, InstanceState } from "../../src/instance";
import type { Project } from "../../src/project";
import { stoppedPanelModel } from "../../src/stopped-panel";
import { AppRunnerView, type ViewHost } from "../../src/webview-view";
import { FakeNode, WorkspaceLeaf } from "../obsidian-mock";

const SLUG = "live-captions";
const RESULT = { history: false };

const project = (): Project => ({
  name: "Live Captions",
  slug: SLUG,
  folder: "/work/live-captions",
  command: "npm run start",
  urlOverride: "",
  killOnClose: true,
  openInBrowser: false,
});

/** What the plugin gives a tab; the instance side is driven by the test. */
function world(over: Partial<ViewHost> = {}) {
  const projects = new Map<string, Project>([[SLUG, project()]]);
  const state = { url: undefined as string | undefined, instance: "none" as InstanceState | "none", adopting: false, openedInBrowser: false, webview: true };
  const listeners = new Set<(e: InstanceEvent) => void>();
  const notices: string[] = [];
  const popOut = vi.fn(async () => ({ kind: "opened", url: "http://127.0.0.1:8957/" }) as const);
  const host: ViewHost = {
    getProject: (s) => projects.get(s),
    isWebviewAvailable: () => state.webview,
    openExternal: async () => {},
    notify: (m) => void notices.push(m),
    instanceUrl: () => state.url,
    instanceState: () => state.instance,
    isAdopting: () => state.adopting,
    isOpenedInBrowser: () => state.openedInBrowser,
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    start: async () => {},
    logTail: async () => [],
    popOut,
    ...over,
  };
  return {
    host,
    projects,
    state,
    notices,
    popOut,
    emit: (e: InstanceEvent) => Promise.all([...listeners].map((l) => l(e))),
  };
}

async function openTab(w: ReturnType<typeof world>) {
  const leaf = new WorkspaceLeaf();
  const view = new AppRunnerView(leaf as never, w.host);
  await view.onOpen();
  await view.setState({ slug: SLUG }, RESULT);
  return { view, leaf };
}

const dom = (v: AppRunnerView) => v.contentEl as unknown as FakeNode;
const text = (v: AppRunnerView) => dom(v).textContent();
const hasButton = (v: AppRunnerView) => dom(v).all().some((n) => n.tag === "button");
const hasWebview = (v: AppRunnerView) => dom(v).all().some((n) => n.tag === "webview");

describe("the stopped panel keeps the cause it showed when the project list changes", () => {
  it.each([
    ["crashed", "Live Captions stopped on its own."],
    ["requested", "Live Captions was stopped."],
  ] as const)("%s", async (cause, message) => {
    const w = world();
    w.state.url = "http://127.0.0.1:8957/";
    const { view } = await openTab(w);
    expect(hasWebview(view)).toBe(true);
    w.state.url = undefined;
    await w.emit({ type: "ended", slug: SLUG, cause });
    expect(text(view)).toContain(message);

    w.projects.set(SLUG, { ...project(), name: "Captions" }); // a rename: the plugin calls refresh on every tab
    const renamed = message.replace("Live Captions", "Captions");
    await view.refresh();
    expect(text(view)).toContain(renamed);
    expect(text(view)).not.toContain("is not running");
    expect(hasButton(view)).toBe(true);
  });

  it("a panel first drawn as not running stays not running", async () => {
    const w = world();
    const { view } = await openTab(w);
    expect(text(view)).toContain("Live Captions is not running.");
    await view.refresh();
    expect(text(view)).toContain("Live Captions is not running.");
  });

  it("a deleted project still gets the plain message with no Start", async () => {
    const w = world();
    const { view } = await openTab(w);
    w.projects.delete(SLUG);
    await view.refresh();
    expect(text(view)).toContain("no longer exists");
    expect(hasButton(view)).toBe(false);
  });
});

describe("an app that is running but has no web port yet reads as waiting, not stopped", () => {
  it("a restored tab says Waiting, has no Start, and loads the page when the port is found", async () => {
    const w = world();
    w.state.instance = "running"; // adopted mid-start: running, url unknown
    const { view } = await openTab(w);
    expect(text(view)).toContain("Waiting for Live Captions");
    expect(text(view)).toContain("has not opened a web port yet");
    expect(text(view)).not.toContain("App stopped");
    expect(hasButton(view)).toBe(false);

    w.state.url = "http://127.0.0.1:8957/";
    await w.emit({ type: "changed", slug: SLUG });
    expect(hasWebview(view)).toBe(true);
  });

  it("if the app then goes away the tab shows the stopped panel", async () => {
    const w = world();
    w.state.instance = "running";
    const { view } = await openTab(w);
    w.state.instance = "none";
    await w.emit({ type: "ended", slug: SLUG, cause: "crashed" });
    expect(text(view)).toContain("Live Captions stopped on its own.");
    expect(hasButton(view)).toBe(true);
  });

  it("a waiting tab whose app was stopped without an ended event is redrawn by the next change", async () => {
    const w = world();
    w.state.instance = "running";
    const { view } = await openTab(w);
    w.state.instance = "none";
    await w.emit({ type: "changed", slug: SLUG });
    expect(text(view)).toContain("Live Captions is not running.");
    expect(hasButton(view)).toBe(true);
  });
});

describe("a tab restored while the launch check is still running", () => {
  it("says Checking with no Start; refresh() after the check draws the real state", async () => {
    const w = world();
    w.state.adopting = true;
    const { view } = await openTab(w);
    expect(text(view)).toContain("Checking Live Captions");
    expect(hasButton(view)).toBe(false);

    w.state.adopting = false;
    await view.refresh();
    expect(text(view)).toContain("Live Captions is not running.");
    expect(hasButton(view)).toBe(true);
  });

  it("refresh() after the check loads the page when the check adopted the app", async () => {
    const w = world();
    w.state.adopting = true;
    const { view } = await openTab(w);
    w.state.adopting = false;
    w.state.instance = "running";
    w.state.url = "http://127.0.0.1:8957/";
    await view.refresh();
    expect(hasWebview(view)).toBe(true);
  });

  it("the waiting and checking panels have wording and no Start", () => {
    const waiting = stoppedPanelModel("Live Captions", "waiting", ["a log line"]);
    expect(waiting).toMatchObject({ heading: "Waiting for Live Captions", canStart: false, logLines: ["a log line"] });
    const checking = stoppedPanelModel("Live Captions", "checking", ["a log line"]);
    expect(checking).toMatchObject({ heading: "Checking Live Captions", canStart: false, logLines: [] });
    expect(stoppedPanelModel(undefined, "waiting", [])).toMatchObject({ canStart: false, message: expect.stringContaining("no longer exists") });
  });
});

describe("E18 with several restored tabs of one app", () => {
  it("the first tab hands the app to the browser; a tab that finds it already held for the browser just closes", async () => {
    const w = world();
    w.state.url = "http://127.0.0.1:8957/";
    w.state.webview = false;
    const first = await openTab(w);
    expect(w.popOut).toHaveBeenCalledTimes(1);
    expect(first.leaf.detached).toBe(true);

    w.state.openedInBrowser = true; // the hand-off set Held for the browser
    w.notices.length = 0;
    const second = await openTab(w);
    expect(w.popOut).toHaveBeenCalledTimes(1); // not again
    expect(second.leaf.detached).toBe(true);
    expect(w.notices).toEqual(["Live Captions is already open in your default browser, so this tab was closed."]);
    expect(hasWebview(second.view)).toBe(false);
  });
});
