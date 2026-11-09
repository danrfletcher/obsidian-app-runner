import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HELD_OPENED_IN_BROWSER } from "../../src/held";
import { Registry } from "../../src/registry";
import { registryPath } from "../../src/runtime-paths";
import { Notice, Platform, Setting } from "../obsidian-mock";
import { launch } from "../plugin-harness";
import { mountTab, openAppRealIo, setWebviewAvailable, SLUG } from "../popout-rig";
import { FakeWorld, project } from "../process-fakes";

/**
 * The Held flag and its reason through a real registry file in a temp runtime directory: written by one Obsidian
 * session, read back by the next, adopted still Held, and dropped without a signal when the process is gone.
 * Processes are the fake table; the registry file is real.
 */

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "app-runner-held-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const freshRuntime = () => {
  const dir = path.join(tmp, `rt${n++}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};
const readFile = (runtime: string) => JSON.parse(fs.readFileSync(registryPath(runtime), "utf8")) as { version: number; entries: Record<string, Record<string, unknown>> };

beforeEach(() => {
  Notice.reset();
  Setting.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
  setWebviewAvailable(true);
});
afterEach(() => setWebviewAvailable(false));

/** Session one: the app is opened in the browser (or popped out) and Obsidian quits. */
async function firstSession(runtime: string, how: "setting" | "popout") {
  const w = new FakeWorld(project({ openInBrowser: how === "setting" }));
  const registry = new Registry(registryPath(runtime));
  const l = await launch(w, { registry, runtimeDir: runtime });
  await openAppRealIo(w, l);
  if (how === "popout") await (await mountTab(l)).popOut();
  await w.clock.settle();
  await registry.read(); // reads are queued behind writes: when it answers, the file is on disk
  const pid = w.leaderPid();
  l.plugin.onunload();
  Notice.reset();
  return { w, pid };
}

describe("the Held entry is written, adopted and still Held", () => {
  for (const how of ["setting", "popout"] as const) {
    it(`opened in the browser by ${how}: the file holds held and its reason, nothing else new`, async () => {
      const runtime = freshRuntime();
      await firstSession(runtime, how);
      const file = readFile(runtime);
      expect(file.version).toBe(1);
      expect(file.entries[SLUG]).toMatchObject({ slug: SLUG, held: true, heldReason: HELD_OPENED_IN_BROWSER, browserSessionExpected: true });
      expect(Object.keys(file.entries[SLUG]).sort()).toEqual(["browserSessionExpected", "held", "heldReason", "members", "pgid", "pid", "port", "slug", "startedAt"]);
    });

    it(`opened in the browser by ${how}: relaunch adopts it still Held with its reason, lists it, and creates no auto-stop timer`, async () => {
      const runtime = freshRuntime();
      const { w, pid } = await firstSession(runtime, how);
      const bytes = fs.readFileSync(registryPath(runtime));

      const l = await launch(w, { registry: new Registry(registryPath(runtime)), runtimeDir: runtime });
      l.layoutReady();
      await w.clock.settle();

      expect(w.spawns).toHaveLength(1); // nothing was started again
      expect(l.plugin.instances.isAdopted(SLUG)).toBe(true);
      expect(l.plugin.instances.isHeld(SLUG)).toBe(true);
      expect(l.plugin.instances.snapshots()[0]).toMatchObject({ slug: SLUG, state: "running", held: true, heldReason: HELD_OPENED_IN_BROWSER, adopted: true });
      expect(l.plugin.instances.browserSessionExpected(SLUG)).toBe(true);
      expect(l.plugin.killTimer.pendingCount).toBe(0);
      expect(fs.readFileSync(registryPath(runtime)).equals(bytes)).toBe(true); // adoption wrote nothing different

      // The list says why; no timer ever runs; the app is untouched ten minutes later.
      l.tab.display();
      expect(l.rows()[0].desc).toMatch(/Held: opened in browser, waiting to read its tabs/);
      await w.clock.advance(10 * 60_000);
      expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
      expect(w.signals).toEqual([]);
      expect(w.procs.some((p) => p.pid === pid)).toBe(true);
      expect(Notice.messages.filter((m) => /stopped/i.test(m))).toEqual([]);
    });
  }

  it("a Held app adopted at relaunch with zero tabs and Kill on is named as still running, never stopped, and Stop ends it", async () => {
    const runtime = freshRuntime();
    const { w } = await firstSession(runtime, "setting");
    const l = await launch(w, { registry: new Registry(registryPath(runtime)), runtimeDir: runtime });
    l.layoutReady();
    await w.clock.advance(60_000);
    expect(l.plugin.instances.stateOf(SLUG)).toBe("running");
    expect(w.signals).toEqual([]);
    expect(Notice.messages.join("\n")).toMatch(/Live Captions/);
    expect(Notice.messages.join("\n")).not.toMatch(/Stopped Live Captions/);

    await w.clock.run(l.plugin.stopProject(SLUG));
    expect(l.plugin.instances.stateOf(SLUG)).toBe("none");
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(readFile(runtime).entries).toEqual({});
    expect(w.procs).toEqual([]);
  });

  it("after Stop the file has no Held entry, and an unrelated app's entry keeps no Held fields", async () => {
    const runtime = freshRuntime();
    const reg = new Registry(registryPath(runtime));
    await reg.set({ slug: "other", pid: 4100, pgid: 4100, members: [{ pid: 4100, startTime: "x" }], port: 4317, startedAt: 1, browserSessionExpected: false });
    const file = readFile(runtime);
    expect(file.entries.other).not.toHaveProperty("held");
    expect(file.entries.other).not.toHaveProperty("heldReason");
  });
});

describe("a stale Held entry is dropped with no signal sent", () => {
  it("the processes are gone (reboot): the entry is dropped, nothing is signalled, the list is empty, Held is not carried over", async () => {
    const runtime = freshRuntime();
    const { w } = await firstSession(runtime, "setting");
    w.procs = []; // the machine rebooted: no such process
    w.signals.length = 0;

    const l = await launch(w, { registry: new Registry(registryPath(runtime)), runtimeDir: runtime });
    l.layoutReady();
    await w.clock.advance(60_000);

    expect(w.signals).toEqual([]);
    expect(l.plugin.instances.snapshots()).toEqual([]);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
    expect(readFile(runtime).entries).toEqual({});
  });

  it("the pid was reused by another process (different start time): not adopted, not signalled", async () => {
    const runtime = freshRuntime();
    const { w, pid } = await firstSession(runtime, "setting");
    w.procs = [];
    w.procs.push({ pid, pgid: pid, startTime: "Sat Nov  7 09:00:00 2026", ignoresTerm: false }); // a stranger now has the pid
    w.signals.length = 0;

    const l = await launch(w, { registry: new Registry(registryPath(runtime)), runtimeDir: runtime });
    l.layoutReady();
    await w.clock.advance(60_000);

    expect(w.signals).toEqual([]);
    expect(l.plugin.instances.snapshots()).toEqual([]);
    expect(w.procs).toHaveLength(1); // the stranger is untouched
    expect(readFile(runtime).entries).toEqual({});
  });
});

describe("older and damaged files stay readable", () => {
  it("an entry written before this update (no held fields) is read as not Held", async () => {
    const runtime = freshRuntime();
    const w = new FakeWorld(project());
    const registry = new Registry(registryPath(runtime));
    const l0 = await launch(w, { registry, runtimeDir: runtime });
    await openAppRealIo(w, l0);
    await registry.read();
    l0.plugin.onunload();
    const file = readFile(runtime);
    delete file.entries[SLUG].held;
    delete file.entries[SLUG].heldReason;
    fs.writeFileSync(registryPath(runtime), JSON.stringify(file));

    const l = await launch(w, { registry: new Registry(registryPath(runtime)), runtimeDir: runtime });
    l.layoutReady();
    await w.clock.settle();
    expect(l.plugin.instances.isAdopted(SLUG)).toBe(true);
    expect(l.plugin.instances.isHeld(SLUG)).toBe(false);
  });

  it("a hand-edited held: \"yes\" (not true) is not Held, and an over-long reason is cut", async () => {
    const runtime = freshRuntime();
    const reg = new Registry(registryPath(runtime));
    const base = { slug: "a", pid: 4100, pgid: 4100, members: [{ pid: 4100, startTime: "x" }], port: 4317, startedAt: 1, browserSessionExpected: false };
    fs.writeFileSync(
      registryPath(runtime),
      JSON.stringify({ version: 1, entries: { a: { ...base, held: "yes", heldReason: "r" }, b: { ...base, slug: "b", held: true, heldReason: "x".repeat(5000) } } }),
    );
    const { entries } = await reg.read();
    expect(entries.a.held).toBeUndefined();
    expect(entries.b.held).toBe(true);
    expect(entries.b.heldReason).toHaveLength(200);
  });
});
