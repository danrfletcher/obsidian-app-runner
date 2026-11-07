import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../src/project";
import { AppRunnerView, isWebviewAvailable, VIEW_TYPE_APP, webviewUrl, type ViewHost } from "../../src/webview-view";
import { FakeNode, Notice, WorkspaceLeaf } from "../obsidian-mock";

const project = (over: Partial<Project> = {}): Project => ({
  name: "Live Captions",
  slug: "live-captions",
  folder: "/work/live-captions",
  command: "npm run start",
  urlOverride: "http://127.0.0.1:8957",
  killOnClose: true,
  openInBrowser: false,
  ...over,
});

function setup(projects: Project[], webview = true) {
  const byslug = new Map(projects.map((p) => [p.slug, p]));
  const opened: string[] = [];
  const notices: string[] = [];
  const host: ViewHost = {
    getProject: (s) => byslug.get(s),
    isWebviewAvailable: () => webview,
    openExternal: (u) => opened.push(u),
    notify: (m) => notices.push(m),
  };
  const leaf = new WorkspaceLeaf();
  const view = new AppRunnerView(leaf as never, host);
  return { view, leaf, host, byslug, opened, notices };
}

const RESULT = { history: false };
/** The mock's content element, typed as the fake node it is. */
const dom = (v: AppRunnerView) => v.contentEl as unknown as FakeNode;

beforeEach(() => Notice.reset());

describe("view identity (G11)", () => {
  it("has its own view type and the project name as title", async () => {
    const { view } = setup([project()]);
    await view.setState({ slug: "live-captions" }, RESULT);
    expect(view.getViewType()).toBe(VIEW_TYPE_APP);
    expect(view.getViewType()).toBe("app-runner-view");
    expect(view.getDisplayText()).toBe("Live Captions");
  });

  it("the title follows a rename", async () => {
    const { view, byslug } = setup([project()]);
    await view.setState({ slug: "live-captions" }, RESULT);
    byslug.set("live-captions", project({ name: "Captions" }));
    expect(view.getDisplayText()).toBe("Captions");
  });

  it("getState returns only the slug, never the URL", async () => {
    const { view } = setup([project()]);
    await view.setState({ slug: "live-captions", url: "http://evil.example", other: 1 }, RESULT);
    expect(view.getState()).toEqual({ slug: "live-captions" });
    expect(Object.keys(view.getState())).toEqual(["slug"]);
  });

  it("setState with junk gives an empty slug and a message, not a crash", async () => {
    for (const state of [null, undefined, {}, { slug: 5 }, "x"]) {
      const { view } = setup([project()]);
      await view.setState(state, RESULT);
      expect(view.getState()).toEqual({ slug: "" });
      expect(dom(view).textContent()).toMatch(/no longer exists/);
    }
  });
});

describe("the tab is a webview, not an iframe (G11)", () => {
  it("renders one <webview> whose src is the override", async () => {
    const { view } = setup([project({ urlOverride: "http://127.0.0.1:8957/live?a=1" })]);
    await view.setState({ slug: "live-captions" }, RESULT);
    const els = dom(view).all();
    expect(els.map((e) => e.tag)).toEqual(["webview"]);
    expect(els[0].getAttribute("src")).toBe("http://127.0.0.1:8957/live?a=1");
    expect(els.some((e) => e.tag === "iframe")).toBe(false);
  });

  it("reads the URL from settings at load: a restored or duplicated tab follows a changed override", async () => {
    const { view, byslug } = setup([project()]);
    await view.setState({ slug: "live-captions" }, RESULT);
    expect(dom(view).all()[0].getAttribute("src")).toBe("http://127.0.0.1:8957");

    byslug.set("live-captions", project({ urlOverride: "http://localhost:9000/x" }));
    // A duplicate of the tab is built from the saved state ({slug}) alone:
    const state = view.getState();
    const dup = setup([project({ urlOverride: "http://localhost:9000/x" })]);
    await dup.view.setState(state, RESULT);
    expect(dom(dup.view).all()[0].getAttribute("src")).toBe("http://localhost:9000/x");
    // and the same tab reloaded picks it up too:
    await view.setState(state, RESULT);
    expect(dom(view).all().map((e) => e.getAttribute("src"))).toEqual(["http://localhost:9000/x"]);
  });

  it("never sets a src that is not a loopback URL, even from a hand-edited data.json", async () => {
    for (const urlOverride of ["http://example.com", "javascript:alert(1)", "file:///etc/passwd", "http://127.0.0.1.evil.com"]) {
      const { view, host } = setup([project({ urlOverride })]);
      const open = vi.spyOn(host, "openExternal");
      await view.setState({ slug: "live-captions" }, RESULT);
      expect(dom(view).all().filter((e) => e.tag === "webview")).toEqual([]);
      expect(open).not.toHaveBeenCalled();
    }
  });

  it("with no running app and no override it shows the App stopped panel (it replaced the old plain message) and renders no webview", async () => {
    const { view } = setup([project({ urlOverride: "" })]);
    await view.setState({ slug: "live-captions" }, RESULT);
    expect(dom(view).all().some((e) => e.tag === "webview")).toBe(false);
    expect(dom(view).textContent()).toBe("App stopped\nLive Captions is not running.");
  });

  it("a deleted project shows a message", async () => {
    const { view } = setup([]);
    await view.setState({ slug: "gone" }, RESULT);
    expect(dom(view).textContent()).toMatch(/no longer exists/);
    expect(view.getDisplayText()).toBe("App Runner");
  });

  it("reloading the state replaces the webview instead of stacking another", async () => {
    const { view } = setup([project()]);
    await view.setState({ slug: "live-captions" }, RESULT);
    await view.setState({ slug: "live-captions" }, RESULT);
    expect(dom(view).all().filter((e) => e.tag === "webview")).toHaveLength(1);
  });
});

describe("E18 webview unavailable", () => {
  it("does not render, opens the default browser, says why and closes the tab", async () => {
    const { view, leaf, opened, notices } = setup([project({ urlOverride: "http://localhost:8957/x" })], false);
    await view.setState({ slug: "live-captions" }, RESULT);
    expect(dom(view).all()).toEqual([]);
    expect(opened).toEqual(["http://localhost:8957/x"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/webview is unavailable/);
    expect(notices[0]).toMatch(/Live Captions/);
    expect(leaf.detached).toBe(true);
  });

  it("with the webview available nothing is opened externally and the tab stays", async () => {
    const { view, leaf, opened, notices } = setup([project()], true);
    await view.setState({ slug: "live-captions" }, RESULT);
    expect(opened).toEqual([]);
    expect(notices).toEqual([]);
    expect(leaf.detached).toBe(false);
  });
});

describe("isWebviewAvailable()", () => {
  it("is true when the webview custom element is defined", () => {
    expect(isWebviewAvailable({ customElements: { get: (n) => (n === "webview" ? class {} : undefined) }, createElement: () => ({}) })).toBe(true);
  });
  it("is true when no registry exists but the created element has the webview API", () => {
    expect(isWebviewAvailable({ createElement: () => ({ getWebContentsId() {} }) })).toBe(true);
  });
  it("is false when webviewTag is stripped: unknown element, no webview API", () => {
    expect(isWebviewAvailable({ customElements: { get: () => undefined }, createElement: () => ({}) })).toBe(false);
  });
  it("is false when probing throws", () => {
    expect(
      isWebviewAvailable({
        createElement: () => {
          throw new Error("no document");
        },
      }),
    ).toBe(false);
  });
  it("defaults to the real document, and is false where there is none (node)", () => {
    expect(isWebviewAvailable()).toBe(false);
  });
});

describe("webviewUrl", () => {
  it.each([
    ["http://127.0.0.1:8957", "http://127.0.0.1:8957"],
    ["  http://[::1]:8957  ", "http://[::1]:8957"],
    ["", null],
    ["http://example.com", null],
  ])("%s", (urlOverride, expected) => {
    expect(webviewUrl(project({ urlOverride }))).toBe(expected);
  });
});

describe("the running app's URL", () => {
  it("is used in preference to the override, and only when it is loopback", () => {
    expect(webviewUrl(project({ urlOverride: "http://127.0.0.1:1111" }), "http://127.0.0.1:2222/")).toBe("http://127.0.0.1:2222/");
    expect(webviewUrl(project({ urlOverride: "http://127.0.0.1:1111" }), "http://example.com/")).toBe("http://127.0.0.1:1111");
    expect(webviewUrl(project({ urlOverride: "" }), "http://example.com/")).toBeNull();
    expect(webviewUrl(project({ urlOverride: "" }), undefined)).toBeNull();
  });

  it("a tab loads the instance's URL, looked up when the tab loads", async () => {
    const { view, host } = setup([project({ urlOverride: "" })]);
    let url: string | undefined = "http://127.0.0.1:8957/";
    host.instanceUrl = () => url;
    await view.setState({ slug: "live-captions" }, RESULT);
    const webview = dom(view).all().find((e) => e.tag === "webview")!;
    expect(webview.attrs.src).toBe("http://127.0.0.1:8957/");
    url = undefined;
    await view.setState({ slug: "live-captions" }, RESULT);
    expect(dom(view).all().some((e) => e.tag === "webview")).toBe(false);
  });
});
