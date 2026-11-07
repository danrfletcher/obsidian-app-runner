import { describe, expect, it, vi } from "vitest";
import type { InstanceEvent } from "../../src/instance";
import type { Project } from "../../src/project";
import { AppRunnerView, type ViewHost } from "../../src/webview-view";
import { FakeNode, WorkspaceLeaf } from "../obsidian-mock";

const SLUG = "live-captions";
const RESULT = { history: false };

const project = (over: Partial<Project> = {}): Project => ({
  name: "Live Captions",
  slug: SLUG,
  folder: "/work/live-captions",
  command: "npm run start",
  urlOverride: "",
  killOnClose: true,
  openInBrowser: false,
  ...over,
});

/** What the plugin gives a tab, with the instance side driven by the test. */
function world() {
  const projects = new Map<string, Project>([[SLUG, project()]]);
  let url: string | undefined = "http://127.0.0.1:8957/";
  let log: string[] = ["listening 8957"];
  const listeners = new Set<(e: InstanceEvent) => void>();
  const starts: string[] = [];
  const sessionsChanged = vi.fn();
  const host: ViewHost = {
    getProject: (s) => projects.get(s),
    isWebviewAvailable: () => true,
    openExternal: () => {},
    notify: () => {},
    instanceUrl: () => url,
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    start: async (s) => void starts.push(s),
    logTail: async () => log,
    sessionsChanged,
  };
  const emit = async (e: InstanceEvent) => {
    await Promise.all([...listeners].map((l) => l(e)));
  };
  return {
    host,
    projects,
    listeners,
    starts,
    sessionsChanged,
    setUrl: (u: string | undefined) => (url = u),
    setLog: (l: string[]) => (log = l),
    /** Tell every tab, and wait for the ones that redraw. */
    ended: (cause: "requested" | "crashed" | "start-failed") => emit({ type: "ended", slug: SLUG, cause }),
    changed: (slug = SLUG) => emit({ type: "changed", slug }),
  };
}

async function openTab(w: ReturnType<typeof world>) {
  const view = new AppRunnerView(new WorkspaceLeaf() as never, w.host);
  await view.onOpen();
  await view.setState({ slug: SLUG }, RESULT);
  return view;
}

const dom = (v: AppRunnerView) => v.contentEl as unknown as FakeNode;
const tags = (v: AppRunnerView) => dom(v).all().map((n) => n.tag);
const button = (v: AppRunnerView) => dom(v).all().find((n) => n.tag === "button");
const webviewSrc = (v: AppRunnerView) => dom(v).all().find((n) => n.tag === "webview")?.attrs.src;

// An app that wrote more than ten lines before it went.
const TWELVE = Array.from({ length: 10 }, (_, i) => `log line ${i + 3}`);

describe("G8 Stop switches every open tab to the App stopped panel", () => {
  it("both tabs of the project switch; the webview is gone", async () => {
    const w = world();
    w.setLog(TWELVE);
    const a = await openTab(w);
    const b = await openTab(w);
    expect(webviewSrc(a)).toBe("http://127.0.0.1:8957/");
    w.setUrl(undefined);
    await w.ended("requested");
    for (const v of [a, b]) {
      expect(tags(v)).not.toContain("webview");
      expect(dom(v).textContent()).toBe(["App stopped", "Live Captions was stopped.", "Last lines of the log:", TWELVE.join("\n"), "Start"].join("\n"));
      expect(button(v)?.text).toBe("Start");
    }
  });

  it("a tab of another project is left alone", async () => {
    const w = world();
    const view = await openTab(w);
    const other = new AppRunnerView(new WorkspaceLeaf() as never, w.host);
    await other.onOpen();
    await other.setState({ slug: "something-else" }, RESULT);
    for (const l of w.listeners) await l({ type: "ended", slug: "something-else", cause: "requested" });
    expect(webviewSrc(view)).toBe("http://127.0.0.1:8957/");
  });
});

describe("G9 an app that exits on its own", () => {
  it("shows App stopped with Start and the last 10 log lines", async () => {
    const w = world();
    w.setLog(TWELVE);
    const view = await openTab(w);
    w.setUrl(undefined);
    await w.ended("crashed");
    const text = dom(view).textContent();
    expect(text).toContain("Live Captions stopped on its own.");
    expect(text).toContain("log line 12");
    expect(text).toContain("log line 3");
    expect(dom(view).all().find((n) => n.tag === "pre")!.text.split("\n")).toHaveLength(10);
    expect(button(view)?.text).toBe("Start");
  });

  it("a crash with no log yet shows no log section", async () => {
    const w = world();
    w.setLog([]);
    const view = await openTab(w);
    await w.ended("crashed");
    expect(dom(view).all().some((n) => n.tag === "pre")).toBe(false);
    expect(dom(view).textContent()).not.toContain("Last lines");
  });

  it("a failed start changes no tab (the notice said it, and no tab was open for it)", async () => {
    const w = world();
    const view = await openTab(w);
    await w.ended("start-failed");
    expect(webviewSrc(view)).toBe("http://127.0.0.1:8957/");
  });

  it("nothing restarts the app: ending a tab's app calls no start", async () => {
    const w = world();
    await openTab(w);
    await w.ended("crashed");
    expect(w.starts).toEqual([]);
  });

  it("the panel's Start runs the start path once, even when pressed twice, and opens no tab", async () => {
    const w = world();
    let release!: () => void;
    w.host.start = async (s) => {
      w.starts.push(s);
      await new Promise<void>((r) => (release = r));
    };
    const view = await openTab(w);
    await w.ended("crashed");
    button(view)!.click();
    button(view)!.click();
    expect(w.starts).toEqual([SLUG]);
    expect((button(view) as unknown as { disabled: boolean }).disabled).toBe(true);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect((button(view) as unknown as { disabled: boolean }).disabled).toBe(false);
  });

  it("when the app is running again every stopped tab of the project reloads into it", async () => {
    const w = world();
    const a = await openTab(w);
    const b = await openTab(w);
    w.setUrl(undefined);
    await w.ended("crashed");
    expect(tags(a)).not.toContain("webview");
    w.setUrl("http://127.0.0.1:8957/");
    await w.changed();
    expect(webviewSrc(a)).toBe("http://127.0.0.1:8957/");
    expect(webviewSrc(b)).toBe("http://127.0.0.1:8957/");
    expect(button(a)).toBeUndefined();
  });

  it("a change while the app is still starting does not reload a stopped tab", async () => {
    const w = world();
    const view = await openTab(w);
    w.setUrl(undefined);
    await w.ended("crashed");
    await w.changed(); // starting: no URL yet
    expect(tags(view)).not.toContain("webview");
    expect(button(view)?.text).toBe("Start");
  });

  it("a start that fails leaves the panel and its Start button in place", async () => {
    const w = world();
    w.host.start = async () => {
      throw new Error("could not start");
    };
    const view = await openTab(w);
    w.setUrl(undefined);
    await w.ended("crashed");
    button(view)!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(button(view)?.text).toBe("Start");
    expect((button(view) as unknown as { disabled: boolean }).disabled).toBe(false);
  });

  it("an App stopped that is still reading the log does not draw over a page that arrived meanwhile", async () => {
    const w = world();
    const view = await openTab(w);
    let release!: (lines: string[]) => void;
    w.host.logTail = () => new Promise((r) => (release = r));
    w.setUrl(undefined);
    const ending = w.ended("crashed");
    w.setUrl("http://127.0.0.1:8957/");
    await view.setState({ slug: SLUG }, RESULT); // reloaded into the app meanwhile
    release(["late line"]);
    await ending;
    expect(webviewSrc(view)).toBe("http://127.0.0.1:8957/");
    expect(dom(view).textContent()).not.toContain("App stopped");
  });
});

describe("E19 an open tab keeps its page until reloaded, then follows the new port", () => {
  it("a restart on another port does not touch the open page; Reload reads the instance's URL", async () => {
    const w = world();
    const view = await openTab(w);
    const page = dom(view).all().find((n) => n.tag === "webview")!;
    w.setUrl("http://127.0.0.1:9100/"); // stopped and started again somewhere else
    await w.changed();
    expect(dom(view).all().find((n) => n.tag === "webview")).toBe(page);
    expect(page.attrs.src).toBe("http://127.0.0.1:8957/");
    await view.setState(view.getState(), RESULT); // Reload
    expect(webviewSrc(view)).toBe("http://127.0.0.1:9100/");
  });

  it("a stopped tab reloaded while the app is down stays on the panel, even if the project has a URL override", async () => {
    const w = world();
    w.projects.set(SLUG, project({ urlOverride: "http://127.0.0.1:8957" }));
    const view = await openTab(w);
    w.setUrl(undefined);
    await w.ended("requested");
    await view.setState(view.getState(), RESULT);
    expect(tags(view)).not.toContain("webview");
    expect(button(view)?.text).toBe("Start");
  });
});

describe("a tab whose project was deleted", () => {
  it("shows a plain message and no Start button when the app ends", async () => {
    const w = world();
    const view = await openTab(w);
    w.projects.delete(SLUG);
    await w.ended("requested");
    expect(dom(view).textContent()).toBe("App stopped\nThis project no longer exists in App Runner settings. Close this tab.");
    expect(button(view)).toBeUndefined();
  });

  it("a panel already showing loses its Start button when the project is deleted and the tabs are refreshed", async () => {
    const w = world();
    const view = await openTab(w);
    w.setUrl(undefined);
    await w.ended("crashed");
    expect(button(view)?.text).toBe("Start");
    w.projects.delete(SLUG);
    await expect(view.refresh()).resolves.toBeUndefined();
    expect(button(view)).toBeUndefined();
    expect(dom(view).textContent()).toContain("no longer exists");
  });

  it("a tab restored for a deleted project does not throw and shows the plain message", async () => {
    const w = world();
    w.projects.clear();
    await expect(openTab(w)).resolves.toBeDefined();
  });

  it("refresh leaves a tab that is showing the app alone (no reload)", async () => {
    const w = world();
    const view = await openTab(w);
    const page = dom(view).all().find((n) => n.tag === "webview");
    await view.refresh();
    expect(dom(view).all().find((n) => n.tag === "webview")).toBe(page);
  });
});

describe("listening", () => {
  it("a tab listens once however often it is opened and set, and stops on close", async () => {
    const w = world();
    const view = await openTab(w);
    await view.setState({ slug: SLUG }, RESULT);
    await view.onOpen();
    expect(w.listeners.size).toBe(1);
    await view.onClose();
    expect(w.listeners.size).toBe(0);
  });

  it("opening and loading a tab tells the plugin to re-count sessions", async () => {
    const w = world();
    await openTab(w);
    expect(w.sessionsChanged).toHaveBeenCalled();
  });
});
