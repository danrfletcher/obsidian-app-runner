import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "../../src/instance";
import { buildRunningRows, clockTime, rowSummary, sessionsText, tabsText } from "../../src/running-list-model";

const info = (over: Partial<InstanceInfo> = {}): InstanceInfo => ({
  slug: "live-captions",
  name: "Live Captions",
  state: "running",
  port: 8957,
  url: "http://127.0.0.1:8957/",
  startedAt: new Date(2026, 10, 7, 9, 5, 7).getTime(),
  held: false,
  heldReason: "",
  adopted: false,
  ...over,
});

const inputs = (sessions: Record<string, number> = {}, logs: string[] = ["live-captions"]) => ({
  sessions: (slug: string) => sessions[slug] ?? 0,
  logExists: (slug: string) => logs.includes(slug),
});

describe("the row for each state (G7)", () => {
  it.each([
    ["starting", { port: null, url: null }, { canOpen: false, canStop: true, portText: "–" }],
    ["running", {}, { canOpen: true, canStop: true, portText: "8957" }],
    ["stopping", {}, { canOpen: false, canStop: false, portText: "8957" }],
  ] as const)("%s", (state, over, expected) => {
    const [row] = buildRunningRows([info({ state, ...over })], inputs({ "live-captions": 2 }));
    expect(row).toMatchObject({ slug: "live-captions", name: "Live Captions", state, ...expected });
    expect(row.sessionsText).toBe("2 tabs");
    expect(row.startedText).toBe("09:05:07");
  });

  it("the summary line carries state, port, started time and the session cell", () => {
    const [row] = buildRunningRows([info()], inputs({ "live-captions": 2 }));
    expect(rowSummary(row)).toBe("running  ·  port 8957  ·  started 09:05:07  ·  2 tabs");
  });

  it("an empty list has no rows", () => {
    expect(buildRunningRows([], inputs())).toEqual([]);
  });
});

describe("the port", () => {
  it("is whatever the instance reports now, so a restart on a new port shows the new one (E19)", () => {
    expect(buildRunningRows([info({ port: 8957 })], inputs())[0].portText).toBe("8957");
    expect(buildRunningRows([info({ port: 9100 })], inputs())[0].portText).toBe("9100");
  });
});

describe("the sessions cell", () => {
  it("reads N tabs for Obsidian tabs, with the singular for one and zero tabs shown as 0", () => {
    expect([0, 1, 2, 12].map(tabsText)).toEqual(["0 tabs", "1 tab", "2 tabs", "12 tabs"]);
    expect(sessionsText(info(), 3)).toBe("3 tabs");
  });

  it("reads Held with its reason when the instance is Held, whatever the tab count", () => {
    expect(sessionsText(info({ held: true, heldReason: "popped out to the browser" }), 0)).toBe("Held: popped out to the browser");
    expect(sessionsText(info({ held: true, heldReason: "popped out to the browser" }), 4)).toBe("Held: popped out to the browser");
    expect(buildRunningRows([info({ held: true, heldReason: "Automation permission denied" })], inputs({ "live-captions": 1 }))[0].sessionsText).toBe(
      "Held: Automation permission denied",
    );
  });

  it("a Held instance with no reason says just Held", () => {
    expect(sessionsText(info({ held: true, heldReason: "  " }), 0)).toBe("Held");
  });
});

describe("Show log", () => {
  it("is available when the project has a log file, and disabled when it has none", () => {
    const rows = buildRunningRows([info(), info({ slug: "build-dashboard", name: "Build Dashboard" })], inputs({}, ["live-captions"]));
    expect(rows.map((r) => [r.slug, r.canShowLog])).toEqual([
      ["live-captions", true],
      ["build-dashboard", false],
    ]);
  });
});

describe("order", () => {
  it("sorts by started time, oldest first, whatever order the instances arrive in", () => {
    const rows = buildRunningRows(
      [info({ slug: "c", startedAt: 3000 }), info({ slug: "a", startedAt: 1000 }), info({ slug: "b", startedAt: 2000 })],
      inputs(),
    );
    expect(rows.map((r) => r.slug)).toEqual(["a", "b", "c"]);
  });

  it("is stable: instances that started at the same time keep the order they came in, on every call", () => {
    const infos = ["d", "a", "c", "b"].map((slug) => info({ slug, name: slug, startedAt: 5000 }));
    const first = buildRunningRows(infos, inputs()).map((r) => r.slug);
    expect(first).toEqual(["d", "a", "c", "b"]);
    expect(buildRunningRows(infos, inputs()).map((r) => r.slug)).toEqual(first);
    expect(buildRunningRows([...infos].reverse(), inputs()).map((r) => r.slug)).toEqual(["b", "c", "a", "d"]);
  });

  it("does not change the input array", () => {
    const infos = [info({ slug: "b", startedAt: 2 }), info({ slug: "a", startedAt: 1 })];
    buildRunningRows(infos, inputs());
    expect(infos.map((i) => i.slug)).toEqual(["b", "a"]);
  });
});

describe("time", () => {
  it("clockTime is local HH:MM:SS with leading zeros", () => {
    expect(clockTime(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe("03:04:05");
    expect(clockTime(new Date(2026, 0, 2, 23, 59, 59).getTime())).toBe("23:59:59");
  });

  it("a caller can supply its own formatter", () => {
    expect(buildRunningRows([info()], { ...inputs(), formatTime: (ms) => `t${ms}` })[0].startedText).toMatch(/^t\d+$/);
  });
});
