import { describe, expect, it } from "vitest";
import { countSessions, SessionCounter, sessionSlug, type SessionLeaf } from "../../src/session-counter";
import { VIEW_TYPE_APP } from "../../src/webview-view";

/** A leaf as the workspace holds it: its saved view state is all that is read, so a never-loaded tab looks the same. */
function leaf(slug: string | undefined, type: string = VIEW_TYPE_APP): SessionLeaf & { id: number } {
  return { id: leaf.next++, getViewState: () => ({ type, state: slug === undefined ? undefined : { slug } }) };
}
leaf.next = 1;

/** A workspace whose leaves the test adds and removes. */
function workspace() {
  const leaves: SessionLeaf[] = [];
  const counter = new SessionCounter(() => leaves);
  const heard: string[] = [];
  counter.subscribe((slug) => heard.push(slug));
  return {
    leaves,
    counter,
    heard,
    attach(l: SessionLeaf) {
      leaves.push(l);
      counter.refresh();
    },
    detach(l: SessionLeaf) {
      leaves.splice(leaves.indexOf(l), 1);
      counter.refresh();
    },
  };
}

describe("the counting rule (G14, G11)", () => {
  it("counts one session per App Runner tab, from the saved view state alone", () => {
    expect([...countSessions([leaf("a"), leaf("a"), leaf("b")])]).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });

  it("ignores other view types, and tabs with no usable slug", () => {
    const ws = workspace();
    ws.attach(leaf("a", "markdown"));
    ws.attach(leaf("a", "app-runner-view-lookalike"));
    ws.attach(leaf(undefined));
    ws.attach(leaf(""));
    ws.attach({ getViewState: () => ({ type: VIEW_TYPE_APP, state: { slug: 5 } }) });
    ws.attach({ getViewState: () => ({ type: VIEW_TYPE_APP, state: null }) });
    ws.attach({ getViewState: () => ({}) });
    ws.attach({
      getViewState: () => {
        throw new Error("leaf is closing");
      },
    });
    expect(ws.counter.count("a")).toBe(0);
    expect(ws.heard).toEqual([]);
    expect(sessionSlug(leaf("a", "markdown"))).toBeNull();
  });

  it("a restored tab whose webview never loaded still counts (no view object is needed)", () => {
    const ws = workspace();
    const restored: SessionLeaf = { getViewState: () => ({ type: VIEW_TYPE_APP, state: { slug: "live-captions" } }) };
    ws.attach(restored); // there is no AppRunnerView behind this leaf, as with a deferred tab
    expect(ws.counter.count("live-captions")).toBe(1);
  });

  it("two projects stay separate", () => {
    const ws = workspace();
    const a1 = leaf("a");
    ws.attach(a1);
    ws.attach(leaf("b"));
    ws.attach(leaf("b"));
    expect([ws.counter.count("a"), ws.counter.count("b"), ws.counter.count("c")]).toEqual([1, 2, 0]);
    ws.detach(a1);
    expect([ws.counter.count("a"), ws.counter.count("b")]).toEqual([0, 2]);
    expect(ws.heard).toEqual(["a", "b", "b", "a"]);
  });

  it("duplicate adds one, close removes one", () => {
    const ws = workspace();
    const first = leaf("a");
    const copy = leaf("a");
    ws.attach(first);
    ws.attach(copy); // duplicating the tab
    expect(ws.counter.count("a")).toBe(2);
    ws.detach(first);
    expect(ws.counter.count("a")).toBe(1);
    ws.detach(copy);
    expect(ws.counter.count("a")).toBe(0);
  });

  it("detach then re-attach of the same leaf (a drag between panes or to a pop-out) dips to zero and back", () => {
    const ws = workspace();
    const dragged = leaf("a");
    ws.attach(dragged);
    ws.heard.length = 0;
    ws.detach(dragged);
    expect(ws.counter.count("a")).toBe(0);
    ws.attach(dragged);
    expect(ws.counter.count("a")).toBe(1);
    expect(ws.heard).toEqual(["a", "a"]);
  });

  it("a refresh that changes nothing tells nobody", () => {
    const ws = workspace();
    ws.attach(leaf("a"));
    ws.heard.length = 0;
    ws.counter.refresh();
    ws.counter.refresh();
    expect(ws.heard).toEqual([]);
  });

  it("a tab that changes project moves the count and tells both projects", () => {
    const ws = workspace();
    let slug = "a";
    ws.attach({ getViewState: () => ({ type: VIEW_TYPE_APP, state: { slug } }) });
    ws.heard.length = 0;
    slug = "b";
    ws.counter.refresh();
    expect([ws.counter.count("a"), ws.counter.count("b")]).toEqual([0, 1]);
    expect(ws.heard.sort()).toEqual(["a", "b"]);
  });

  it("unsubscribe and clearListeners stop the calls; a throwing listener does not hide the change from the next", () => {
    const leaves: SessionLeaf[] = [];
    const counter = new SessionCounter(() => leaves);
    const heard: string[] = [];
    counter.subscribe(() => {
      throw new Error("boom");
    });
    const off = counter.subscribe((s) => heard.push(s));
    leaves.push(leaf("a"));
    counter.refresh();
    expect(heard).toEqual(["a"]);
    off();
    leaves.push(leaf("a"));
    counter.refresh();
    expect(heard).toEqual(["a"]);
    expect(counter.listenerCount).toBe(1);
    counter.clearListeners();
    expect(counter.listenerCount).toBe(0);
  });
});
