import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Registry } from "../../src/registry";
import { realRuntimeFs } from "../../src/runtime-fs";
import { registryPath, runtimeDir } from "../../src/runtime-paths";
import { Notice, Platform } from "../obsidian-mock";
import { launch, type LaunchOptions } from "../plugin-harness";
import { FakeWorld, project } from "../process-fakes";

/**
 * E22 and F16. A full lifecycle (start, quit, adopt, stop, and a crash) runs in a temporary vault that is a git
 * repository, as it is when Obsidian Git manages it. Nothing may appear in the vault (the plugin's data.json is
 * only written when a setting changes, which this lifecycle does not do). The registry and the logs are real files, so "not in the vault" is checked against a real directory.
 */

const SLUG = "live-captions";
const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "app-runner-vault-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  Notice.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
});

const git = (vault: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: vault, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

function makeVault(name: string) {
  const vault = path.join(root, name, "Vault");
  fs.mkdirSync(path.join(vault, ".obsidian", "plugins", "app-runner"), { recursive: true });
  fs.writeFileSync(path.join(vault, "Note.md"), "# A note\n");
  git(vault, "init", "-q");
  git(vault, "add", "-A");
  git(vault, "commit", "-q", "-m", "initial");
  return vault;
}

const filesUnder = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== ".git")
    .flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)).map((f) => path.join(e.name, f)) : [e.name]))
    .sort();

/** The plugin as Obsidian runs it: data.json lives in the vault's plugin folder. */
function inVault(vault: string, runtime: string): LaunchOptions {
  const dataFile = path.join(vault, ".obsidian", "plugins", "app-runner", "data.json");
  return {
    vaultBasePath: vault,
    runtimeDir: runtime,
    vaultKey: "3f2b6c1e-8a47-4d0b-9c55-1e0d2a7f6b90",
    registry: new Registry(registryPath(runtime)),
    configure: (plugin) => {
      plugin.loadData = async () => (fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, "utf8")) : plugin.stored);
      plugin.saveData = async (data) => void fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
    },
  };
}

function worldWithRealFiles() {
  const w = new FakeWorld(project({ killOnClose: false })); // quit with the app running; only a hand Stop ends it
  const runtimeFs = { ...realRuntimeFs, isDirectory: (p: string) => w.dirs.has(p) };
  return { w, runtimeFs };
}

describe("E22 and F16: nothing lands in the vault", () => {
  it("a full start, quit, adopt and stop cycle leaves git status showing no pid, log or registry file", async () => {
    const vault = makeVault("cycle");
    const runtime = runtimeDir("3f2b6c1e-8a47-4d0b-9c55-1e0d2a7f6b90", path.join(root, "cycle", "home"));
    const { w, runtimeFs } = worldWithRealFiles();
    const opts = (): LaunchOptions => ({ ...inVault(vault, runtime), runtimeFs });

    // Session one: start the app and open a tab, then quit.
    const one = await launch(w, opts());
    const opening = one.plugin.openProject(SLUG);
    await w.clock.settle();
    w.serve(8957);
    await w.clock.run(opening);
    one.plugin.onunload();

    // Session two: adopted, then stopped by hand.
    const two = await launch(w, { ...opts(), restoredTabs: [SLUG] });
    two.layoutReady();
    expect(two.plugin.instances.isAdopted(SLUG)).toBe(true);
    await w.clock.run(two.plugin.stopProject(SLUG));
    two.plugin.onunload();

    // Session three: start again and let the app crash while the plugin is closed.
    const three = await launch(w, opts());
    const again = three.plugin.openProject(SLUG);
    await w.clock.settle();
    w.serve(8957);
    await w.clock.run(again);
    three.plugin.onunload();
    w.procs = [];
    const four = await launch(w, opts());
    four.layoutReady();
    await w.clock.advance(60_000);
    four.plugin.onunload();

    const status = git(vault, "status", "--porcelain", "--untracked-files=all")
      .split("\n")
      .filter(Boolean);
    expect(status).toEqual([]); // the lifecycle changes no setting, so not even data.json is rewritten
    expect(filesUnder(vault)).toEqual(["Note.md"]);
    expect(git(vault, "diff", "--stat")).toBe(""); // tracked files are untouched

    // The state is where it belongs.
    expect(fs.existsSync(path.join(runtime, "logs", `${SLUG}.log`))).toBe(true);
    expect(fs.existsSync(registryPath(runtime))).toBe(true);
    expect(JSON.parse(fs.readFileSync(registryPath(runtime), "utf8"))).toEqual({ version: 1, entries: {} });
    expect(runtime.startsWith(vault)).toBe(false);
  }, 30_000);

});

describe("F16 the plugin refuses to keep runtime state inside the vault", () => {
  it("a runtime directory that resolves inside the vault stops onload before anything is registered or spawned", async () => {
    const vault = makeVault("guard");
    const insideVault = path.join(vault, ".obsidian", "plugins", "app-runner", "runtime");
    const { w, runtimeFs } = worldWithRealFiles();
    const l = await launch(w, { ...inVault(vault, insideVault), runtimeFs });
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain("inside the vault");
    expect(l.plugin.views.size).toBe(0);
    expect(l.plugin.commands.size).toBe(0);
    expect(l.plugin.settingTabs).toHaveLength(0);
    expect(w.spawns).toEqual([]);
    expect(fs.existsSync(insideVault)).toBe(false);
    expect(git(vault, "status", "--porcelain", "--untracked-files=all")).toBe("");
    l.plugin.onunload(); // unloading a plugin that never finished loading must not throw
  });

  it("the same guard lets a runtime directory outside the vault through", async () => {
    const vault = makeVault("guard-ok");
    const runtime = runtimeDir("key-ok", path.join(root, "guard-ok", "home"));
    const { w, runtimeFs } = worldWithRealFiles();
    const l = await launch(w, { ...inVault(vault, runtime), runtimeFs });
    expect(Notice.messages).toEqual([]);
    expect(l.plugin.views.size).toBe(1);
    l.plugin.onunload();
  });
});
