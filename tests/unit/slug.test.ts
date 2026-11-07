import { describe, expect, it } from "vitest";
import { openCommandId, slugForNewProject, slugify, stopCommandId, uniqueSlug } from "../../src/slug";
import { SettingsStore } from "../../src/settings-store";
import { fakeFs, input, memoryPersistence } from "../helpers";

describe("slugify", () => {
  const cases: Array<[string, string, string]> = [
    ["lowercases", "Live Captions", "live-captions"],
    ["runs of non-alphanumerics become one hyphen", "a  --  b__c!!d", "a-b-c-d"],
    ["trims leading and trailing separators", "  --Build Dashboard!!  ", "build-dashboard"],
    ["keeps digits", "App 2000", "app-2000"],
    ["empty becomes app", "", "app"],
    ["whitespace only becomes app", "   ", "app"],
    ["only symbols becomes app", "!!! ???", "app"],
    ["non-Latin only becomes app", "日本語", "app"],
    ["accents are folded", "Café Résumé", "cafe-resume"],
    ["mixed unicode keeps the Latin part", "Zoë 日本 Tool", "zoe-tool"],
    ["a very long name is kept whole", "x".repeat(300), "x".repeat(300)],
  ];
  it.each(cases)("%s", (_label, name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});

describe("uniqueSlug", () => {
  it("returns the base when free", () => {
    expect(uniqueSlug("app", [])).toBe("app");
    expect(uniqueSlug("app", ["other"])).toBe("app");
  });
  it("suffixes -2, then -3 on repeated clashes", () => {
    expect(uniqueSlug("app", ["app"])).toBe("app-2");
    expect(uniqueSlug("app", ["app", "app-2"])).toBe("app-3");
    expect(uniqueSlug("app", ["app", "app-3"])).toBe("app-2");
  });
  it("two symbol-only names become app then app-2", () => {
    const first = slugForNewProject("!!!", []);
    const second = slugForNewProject("???", [first]);
    expect([first, second]).toEqual(["app", "app-2"]);
  });
});

describe("command ids", () => {
  it("derive from the slug", () => {
    expect(openCommandId("live-captions")).toBe("open-live-captions");
    expect(stopCommandId("live-captions")).toBe("stop-live-captions");
  });
});

describe("stable ids on rename", () => {
  it("a rename keeps the slug, and a later project with the old name's slug is suffixed", async () => {
    const store = new SettingsStore(memoryPersistence(), { fs: fakeFs() });
    await store.load();
    const added = await store.add(input({ name: "Live Captions" }));
    if (!added.ok) throw new Error("add failed");
    const renamed = await store.update(added.project.slug, input({ name: "Captions" }));
    expect(renamed.ok && renamed.project.slug).toBe("live-captions");
    expect(store.get("live-captions")?.name).toBe("Captions");

    // The old name's slug is still taken, so a new project called "Live Captions" gets -2.
    const again = await store.add(input({ name: "Live Captions", folder: "/work/other" }));
    expect(again.ok && again.project.slug).toBe("live-captions-2");
  });

  it("slug clashes from different names are suffixed, not rejected", async () => {
    const store = new SettingsStore(memoryPersistence(), { fs: fakeFs() });
    await store.load();
    const a = await store.add(input({ name: "Live Captions" }));
    const b = await store.add(input({ name: "Live-Captions" }));
    const c = await store.add(input({ name: "live  captions!" }));
    expect([a, b, c].map((r) => r.ok && r.project.slug)).toEqual(["live-captions", "live-captions-2", "live-captions-3"]);
  });
});
