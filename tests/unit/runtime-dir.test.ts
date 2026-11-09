import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertOutsideVault, isInside, logPath, registryPath, runtimeDir } from "../../src/runtime-paths";
import { SettingsStore } from "../../src/settings-store";
import { fakeFs, memoryPersistence } from "../helpers";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "app-runner-rtdir-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const UUID = "3f2b6c1e-8a47-4d0b-9c55-1e0d2a7f6b90";

describe("where the runtime directory is (E24, F16)", () => {
  it("is ~/Library/Application Support/Obsidian App Runner/<uuid>", () => {
    expect(runtimeDir(UUID, "/Users/dan")).toBe(`/Users/dan/Library/Application Support/Obsidian App Runner/${UUID}`);
  });

  it("holds running.json and logs/<slug>.log", () => {
    const rt = runtimeDir(UUID, "/Users/dan");
    expect(registryPath(rt)).toBe(`${rt}/running.json`);
    expect(logPath(rt, "build-dashboard")).toBe(`${rt}/logs/build-dashboard.log`);
  });

  it("two vault keys with the same slug get separate registries and logs (F10)", () => {
    const a = runtimeDir("key-a", "/Users/dan");
    const b = runtimeDir("key-b", "/Users/dan");
    expect(registryPath(a)).not.toBe(registryPath(b));
    expect(logPath(a, "live-captions")).not.toBe(logPath(b, "live-captions"));
  });

  it.each(["", "..", ".", "a/b", "../x", "a b", "/etc"])("refuses %j as a vault key", (key) => {
    expect(() => runtimeDir(key, "/Users/dan")).toThrow(/vault key/);
  });
});

describe("the vault key is a UUID kept in data.json (E24)", () => {
  it("is generated once when data.json has none, and persisted at once", async () => {
    const persistence = memoryPersistence();
    const first = new SettingsStore(persistence, { fs: fakeFs() });
    await first.load();
    expect(first.vaultKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(persistence.saves).toBe(1);
    expect((persistence.current as { vaultKey: string }).vaultKey).toBe(first.vaultKey);

    const second = new SettingsStore(persistence, { fs: fakeFs() });
    await second.load();
    expect(second.vaultKey).toBe(first.vaultKey);
    expect(persistence.saves).toBe(1); // nothing generated, nothing rewritten
  });

  it("an existing key is kept as it is", async () => {
    const persistence = memoryPersistence({ version: 1, vaultKey: UUID, settings: {}, projects: [] });
    const store = new SettingsStore(persistence, { fs: fakeFs() });
    await store.load();
    expect(store.vaultKey).toBe(UUID);
    expect(persistence.saves).toBe(0);
  });

  it("renaming or moving the vault keeps the runtime directory, because the path is built from the key and not from the vault", async () => {
    // data.json travels with the vault folder; only the vault's own path changes.
    const persistence = memoryPersistence({ version: 1, vaultKey: UUID, settings: {}, projects: [] });
    const before = new SettingsStore(persistence, { fs: fakeFs() });
    await before.load();
    const dirBefore = runtimeDir(before.vaultKey, "/Users/dan");

    const after = new SettingsStore(persistence, { fs: fakeFs() }); // same data.json, vault now at another path
    await after.load();
    expect(runtimeDir(after.vaultKey, "/Users/dan")).toBe(dirBefore);
  });

  it("the registry written before the move is found again after it", async () => {
    const { Registry } = await import("../../src/registry");
    const home = path.join(tmp, "home");
    const rt = runtimeDir(UUID, home);
    await new Registry(registryPath(rt)).set({
      slug: "build-dashboard",
      pid: 4100,
      pgid: 4100,
      members: [{ pid: 4100, startTime: "t" }],
      port: 4317,
      startedAt: 1,
      browserSessionExpected: false,
    });
    // "Moved vault": another vault path, the same key from data.json.
    const found = await new Registry(registryPath(runtimeDir(UUID, home))).read();
    expect(Object.keys(found.entries)).toEqual(["build-dashboard"]);
  });
});

describe("never inside the vault (F16)", () => {
  const vault = path.join(tmp, "Vault");
  fs.mkdirSync(path.join(vault, ".obsidian", "plugins"), { recursive: true });

  it("the normal runtime directory is outside the vault", () => {
    expect(() => assertOutsideVault(runtimeDir(UUID, path.join(tmp, "home")), vault)).not.toThrow();
  });

  it.each([
    ["the vault itself", vault],
    ["a folder in the vault", path.join(vault, "runtime")],
    ["the plugin's own folder", path.join(vault, ".obsidian", "plugins", "app-runner")],
    ["a folder that does not exist yet, deep in the vault", path.join(vault, "a", "b", "c")],
    ["a path that climbs out and back in", path.join(vault, "x", "..", "..", "Vault", "y")],
  ])("the guard throws for %s", (_label, runtime) => {
    expect(() => assertOutsideVault(runtime, vault)).toThrow(/inside the vault/);
  });

  it("a sibling whose name starts with the vault's name is not inside it", () => {
    expect(isInside(path.join(tmp, "Vault-backup", "rt"), vault)).toBe(false);
    expect(() => assertOutsideVault(path.join(tmp, "Vault-backup", "rt"), vault)).not.toThrow();
  });

  it("a symlink that points into the vault does not hide the runtime directory inside it", () => {
    const link = path.join(tmp, "innocent-link");
    fs.symlinkSync(vault, link);
    expect(() => assertOutsideVault(path.join(link, "rt"), vault)).toThrow(/inside the vault/);
  });

  it("a vault reached through a symlink is still recognised", () => {
    const link = path.join(tmp, "vault-link");
    fs.symlinkSync(vault, link);
    expect(() => assertOutsideVault(path.join(vault, "rt"), link)).toThrow(/inside the vault/);
  });
});
