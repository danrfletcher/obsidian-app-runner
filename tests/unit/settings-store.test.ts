import { beforeEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../../src/settings-store";
import { fakeFs, input, memoryPersistence } from "../helpers";

let persistence = memoryPersistence();
const make = () => new SettingsStore(persistence, { fs: fakeFs() });

beforeEach(() => {
  persistence = memoryPersistence();
});

describe("data.json round trip", () => {
  it("stores projects, settings and a vault key, and reads them back", async () => {
    const store = make();
    await store.load();
    const r = await store.add(input({ urlOverride: "http://127.0.0.1:8957", openInBrowser: true }));
    expect(r.ok).toBe(true);

    const reloaded = make();
    await reloaded.load();
    expect(reloaded.projects).toEqual([
      {
        name: "Live Captions",
        slug: "live-captions",
        folder: "/work/live-captions",
        command: "npm run start",
        urlOverride: "http://127.0.0.1:8957",
        killOnClose: true,
        openInBrowser: true,
      },
    ]);
    expect(persistence.current).toMatchObject({ version: 1, settings: {}, vaultKey: store.vaultKey });
  });

  it("generates the vault key once, as a UUID, and keeps it across loads and edits", async () => {
    const store = make();
    await store.load();
    const key = store.vaultKey;
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect((persistence.current as { vaultKey: string }).vaultKey).toBe(key); // saved at once

    await store.add(input());
    const again = make();
    await again.load();
    await again.load();
    expect(again.vaultKey).toBe(key);
    await again.add(input({ name: "Other", folder: "/work/other" }));
    expect((persistence.current as { vaultKey: string }).vaultKey).toBe(key);
  });

  it("holds no pid, port or log path", async () => {
    const store = make();
    await store.load();
    await store.add(input());
    const text = JSON.stringify(persistence.current);
    expect(text).not.toMatch(/pid|pgid|port"|logFile|startTime/i);
    expect(Object.keys(persistence.current as object).sort()).toEqual(["projects", "settings", "vaultKey", "version"]);
  });
});

describe("corrupt, missing and odd data.json", () => {
  it.each([
    ["missing (null)", null],
    ["a string", "not json"],
    ["an array", [1, 2]],
    ["a number", 42],
    ["projects of the wrong type", { projects: "nope", settings: 3 }],
  ])("loads defaults for %s", async (_l, raw) => {
    persistence = memoryPersistence(raw);
    const store = make();
    await store.load();
    expect(store.projects).toEqual([]);
    expect(store.vaultKey).not.toBe("");
  });

  it("loads defaults when reading the file throws (corrupt JSON)", async () => {
    const store = new SettingsStore(
      { load: async () => { throw new SyntaxError("Unexpected token"); }, save: persistence.save },
      { fs: fakeFs() },
    );
    await store.load();
    expect(store.projects).toEqual([]);
    expect(store.vaultKey).not.toBe("");
    await store.add(input()); // and it can be saved over
    expect((persistence.current as { projects: unknown[] }).projects).toHaveLength(1);
  });
});

/** A data.json on "disk" as text, so a corrupt file can be unreadable while its bytes are still there. */
function diskPersistence(text: string | null, opts: { backupFails?: boolean } = {}) {
  const d = {
    files: new Map<string, string>(text === null ? [] : [["data.json", text]]),
    log: [] as string[],
    async load(): Promise<unknown> {
      const t = d.files.get("data.json");
      return t === undefined ? null : JSON.parse(t);
    },
    async save(data: unknown) {
      d.log.push("save");
      d.files.set("data.json", JSON.stringify(data));
    },
    async backup(): Promise<string | null> {
      d.log.push("backup");
      if (opts.backupFails) throw new Error("disk full");
      const t = d.files.get("data.json");
      if (t === undefined) return null;
      d.files.set("data.json.corrupt-1", t);
      return "data.json.corrupt-1";
    },
  };
  return d;
}

describe("a corrupt data.json is never lost (R1)", () => {
  const CONFLICT = '<<<<<<< HEAD\n{"vaultKey":"k","projects":[{"name":"Mine"}]}\n=======\n{}\n>>>>>>> other\n';
  const WRONG_SHAPE = JSON.stringify({ vaultKey: "k", projects: [{ name: "Mine", slug: "mine", folder: "/work/other", command: "x" }], settings: 7 });

  it.each([
    ["merge conflict markers (JSON.parse throws)", CONFLICT],
    ["a JSON array", "[1,2]"],
    ["projects of the wrong type", JSON.stringify({ vaultKey: "k", projects: "nope" })],
    ["settings of the wrong type", WRONG_SHAPE],
  ])("%s: the original is copied aside before anything is written, and the user is told", async (_l, text) => {
    const disk = diskPersistence(text);
    const notices: string[] = [];
    const store = new SettingsStore(disk, { fs: fakeFs(), notify: (m) => notices.push(m) });
    await store.load();

    expect(store.projects).toEqual([]);
    expect(store.vaultKey).not.toBe("");
    expect(disk.files.get("data.json.corrupt-1")).toBe(text); // the user's bytes survive
    expect(disk.log.indexOf("backup")).toBeGreaterThanOrEqual(0);
    expect(disk.log.indexOf("backup")).toBeLessThan(disk.log.indexOf("save")); // backup first
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("data.json.corrupt-1");

    // The new key is saved, so it is the same on the next load.
    const again = new SettingsStore(disk, { fs: fakeFs() });
    await again.load();
    expect(again.vaultKey).toBe(store.vaultKey);
  });

  it("when the backup cannot be made, load writes nothing and says so; the first change retries it", async () => {
    const disk = diskPersistence(CONFLICT, { backupFails: true });
    const notices: string[] = [];
    const store = new SettingsStore(disk, { fs: fakeFs(), notify: (m) => notices.push(m) });
    await store.load();
    expect(disk.files.get("data.json")).toBe(CONFLICT); // untouched
    expect(disk.log).toEqual(["backup"]);
    expect(notices[0]).toMatch(/could not back it up/);

    await store.add(input());
    expect(disk.log).toEqual(["backup", "backup", "save"]); // retried before writing
  });

  /** Obsidian 1.15: loadData() answers undefined for a truncated data.json, and the file is still there. */
  function obsidianLikeDisk(text: string | null, opts: { existsThrows?: boolean } = {}) {
    const disk = diskPersistence(text);
    return Object.assign(disk, {
      async load(): Promise<unknown> {
        const t = disk.files.get("data.json");
        if (t === undefined) return null;
        try {
          return JSON.parse(t);
        } catch {
          return undefined;
        }
      },
      async exists(): Promise<boolean> {
        disk.log.push("exists");
        if (opts.existsThrows) throw new Error("adapter failed");
        return disk.files.has("data.json");
      },
    });
  }

  it.each([
    ["a truncated file", '{"version":1,"vaultKey":"k","projects":[{"name":"Mine","slug":"mi'],
    ["an empty file", ""],
  ])("T1: loadData() reads undefined for %s while it exists: copied aside before any save, user told", async (_l, text) => {
    const disk = obsidianLikeDisk(text);
    const notices: string[] = [];
    const store = new SettingsStore(disk, { fs: fakeFs(), notify: (m) => notices.push(m) });
    await store.load();

    expect(store.projects).toEqual([]);
    expect(disk.files.get("data.json.corrupt-1")).toBe(text); // the original text survives
    expect(disk.log.indexOf("backup")).toBeGreaterThanOrEqual(0);
    expect(disk.log.indexOf("backup")).toBeLessThan(disk.log.indexOf("save"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("data.json.corrupt-1");
  });

  it("T1: loadData() reads undefined and the file exists, but the backup fails: nothing is written at load", async () => {
    const text = '{"version":1,"vaultKey":"k","projects":[{"na';
    const disk = obsidianLikeDisk(text);
    disk.backup = async () => {
      disk.log.push("backup");
      throw new Error("disk full");
    };
    const notices: string[] = [];
    await new SettingsStore(disk, { fs: fakeFs(), notify: (m) => notices.push(m) }).load();
    expect(disk.files.get("data.json")).toBe(text);
    expect(disk.log).not.toContain("save");
    expect(notices[0]).toMatch(/could not back it up/);
  });

  it("T1: loadData() reads null and there is no file: a missing file, defaults saved, no backup, no notice", async () => {
    const disk = obsidianLikeDisk(null);
    const notices: string[] = [];
    const store = new SettingsStore(disk, { fs: fakeFs(), notify: (m) => notices.push(m) });
    await store.load();
    expect(disk.log).toEqual(["exists", "save"]);
    expect(notices).toEqual([]);
    expect(JSON.parse(disk.files.get("data.json")!).vaultKey).toBe(store.vaultKey);
  });

  it("T1: when it cannot be told whether the file exists, it is treated as unreadable: copied aside first", async () => {
    const text = '{"vaultKey":"k"';
    const disk = obsidianLikeDisk(text, { existsThrows: true });
    await new SettingsStore(disk, { fs: fakeFs() }).load();
    expect(disk.files.get("data.json.corrupt-1")).toBe(text);
    expect(disk.log.indexOf("backup")).toBeLessThan(disk.log.indexOf("save"));
  });

  it("a missing file (null) is not corrupt: no backup, no notice, defaults saved at once", async () => {
    const disk = diskPersistence(null);
    const notices: string[] = [];
    const store = new SettingsStore(disk, { fs: fakeFs(), notify: (m) => notices.push(m) });
    await store.load();
    expect(disk.log).toEqual(["save"]);
    expect(notices).toEqual([]);
    expect(JSON.parse(disk.files.get("data.json")!).vaultKey).toBe(store.vaultKey);
  });

  it("a good file is not backed up or rewritten on load", async () => {
    const text = JSON.stringify({ version: 1, vaultKey: "k", settings: {}, projects: [] });
    const disk = diskPersistence(text);
    await new SettingsStore(disk, { fs: fakeFs() }).load();
    expect(disk.log).toEqual([]);
  });
});

describe("odd data.json (continued)", () => {
  it("skips malformed project entries and duplicate slugs, fills defaults for missing toggles", async () => {
    persistence = memoryPersistence({
      vaultKey: "k",
      projects: [
        { name: "Good", slug: "good", folder: "/work/other", command: "x" },
        { name: "No slug", folder: "/f", command: "x" },
        "junk",
        null,
        { name: "Dup", slug: "good", folder: "/f", command: "x" },
      ],
    });
    const store = make();
    await store.load();
    expect(store.projects).toEqual([
      { name: "Good", slug: "good", folder: "/work/other", command: "x", urlOverride: "", killOnClose: true, openInBrowser: false },
    ]);
    expect(store.vaultKey).toBe("k");
  });

  it("keeps unknown fields, top level and per project, when saving", async () => {
    persistence = memoryPersistence({
      vaultKey: "k",
      futureThing: { a: 1 },
      settings: { theme: "x" },
      projects: [{ name: "Live Captions", slug: "live-captions", folder: "/work/live-captions", command: "c", extra: "keep me" }],
    });
    const store = make();
    await store.load();
    await store.update("live-captions", input({ command: "npm start" }));
    await store.setToggle("live-captions", "killOnClose", false);
    await store.add(input({ name: "Second", folder: "/work/other" }));
    const saved = persistence.current as Record<string, any>;
    expect(saved.futureThing).toEqual({ a: 1 });
    expect(saved.settings).toEqual({ theme: "x" });
    expect(saved.projects[0]).toMatchObject({ extra: "keep me", command: "npm start", killOnClose: false });
  });
});

describe("G2 edit semantics", () => {
  async function withProject() {
    const store = make();
    await store.load();
    await store.add(input());
    return store;
  }

  it("folder, command and URL changes are saved and flag that they apply at the next start", async () => {
    const store = await withProject();
    let current = input();
    for (const change of [{ folder: "/work/other" }, { command: "npm start" }, { urlOverride: "http://127.0.0.1:1" }]) {
      current = { ...current, ...change };
      const r = await store.update("live-captions", current);
      expect(r.ok && r.restartRequired).toBe(true);
    }
    expect(store.get("live-captions")).toMatchObject({ folder: "/work/other", command: "npm start", urlOverride: "http://127.0.0.1:1" });
    expect(persistence.current).toMatchObject({ projects: [{ folder: "/work/other", command: "npm start" }] });
  });

  it("a rename or a toggle change does not require a restart", async () => {
    const store = await withProject();
    const r = await store.update("live-captions", input({ name: "Captions", killOnClose: false }));
    expect(r.ok && r.restartRequired).toBe(false);
  });

  it("the Kill and Open-in-browser toggles are stored at once", async () => {
    const store = await withProject();
    await store.setToggle("live-captions", "killOnClose", false);
    await store.setToggle("live-captions", "openInBrowser", true);
    expect(store.get("live-captions")).toMatchObject({ killOnClose: false, openInBrowser: true });
    expect(persistence.current).toMatchObject({ projects: [{ killOnClose: false, openInBrowser: true }] });
  });

  it("rename changes the name and never the slug", async () => {
    const store = await withProject();
    await store.update("live-captions", input({ name: "Captions" }));
    expect(store.get("live-captions")?.name).toBe("Captions");
    expect(store.projects.map((p) => p.slug)).toEqual(["live-captions"]);
  });

  it("an invalid edit changes nothing", async () => {
    const store = await withProject();
    const saves = persistence.saves;
    const r = await store.update("live-captions", input({ command: " " }));
    expect(r.ok).toBe(false);
    expect(store.get("live-captions")?.command).toBe("npm run start");
    expect(persistence.saves).toBe(saves);
  });

  it("renaming onto another project's name is rejected; keeping its own name is fine", async () => {
    const store = await withProject();
    await store.add(input({ name: "Second", folder: "/work/other" }));
    const clash = await store.update("second", input({ name: "live captions", folder: "/work/other" }));
    expect(!clash.ok && clash.errors.name).toMatch(/already exists/);
    const same = await store.update("second", input({ name: "SECOND", folder: "/work/other" }));
    expect(same.ok).toBe(true);
  });

  it("editing an unknown slug fails", async () => {
    const store = await withProject();
    expect((await store.update("nope", input())).ok).toBe(false);
  });
});

describe("add and remove", () => {
  it("two quick Add calls create one project", async () => {
    const store = make();
    await store.load();
    const [a, b] = await Promise.all([store.add(input()), store.add(input())]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(store.projects).toHaveLength(1);
  });

  it("a duplicate name differing only in case is rejected", async () => {
    const store = make();
    await store.load();
    await store.add(input());
    const r = await store.add(input({ name: "LIVE CAPTIONS" }));
    expect(!r.ok && r.errors.name).toMatch(/already exists/);
    expect(store.projects).toHaveLength(1);
  });

  it("a name of only symbols gets slug app, and a clash app-2", async () => {
    const store = make();
    await store.load();
    const a = await store.add(input({ name: "***" }));
    const b = await store.add(input({ name: "???" }));
    expect([a, b].map((r) => r.ok && r.project.slug)).toEqual(["app", "app-2"]);
  });

  it("remove drops the row from memory and from data.json", async () => {
    const store = make();
    await store.load();
    await store.add(input());
    expect((await store.remove("live-captions"))?.name).toBe("Live Captions");
    expect(store.projects).toEqual([]);
    expect((persistence.current as { projects: unknown[] }).projects).toEqual([]);
    expect(await store.remove("live-captions")).toBeUndefined();
  });
});

describe("setUrlOverride (E3: remember the picked port)", () => {
  it("stores a loopback URL on the project and saves it", async () => {
    const store = make();
    await store.load();
    await store.add(input());
    const saves = persistence.saves;
    expect((await store.setUrlOverride("live-captions", "http://127.0.0.1:8957/"))?.urlOverride).toBe("http://127.0.0.1:8957/");
    expect(persistence.saves).toBe(saves + 1);
    const reloaded = make();
    await reloaded.load();
    expect(reloaded.get("live-captions")?.urlOverride).toBe("http://127.0.0.1:8957/");
  });

  it.each(["http://example.com:8957/", "javascript:alert(1)", "", "http://192.168.1.2:3000/"])("refuses %j and changes nothing", async (url) => {
    const store = make();
    await store.load();
    await store.add(input({ urlOverride: "http://127.0.0.1:1111" }));
    const saves = persistence.saves;
    expect(await store.setUrlOverride("live-captions", url)).toBeUndefined();
    expect(store.get("live-captions")?.urlOverride).toBe("http://127.0.0.1:1111");
    expect(persistence.saves).toBe(saves);
  });

  it("does nothing for a project that does not exist", async () => {
    const store = make();
    await store.load();
    expect(await store.setUrlOverride("gone", "http://127.0.0.1:8957/")).toBeUndefined();
  });
});
