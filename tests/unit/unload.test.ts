import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Registry } from "../../src/registry";
import { Notice, Platform, Setting } from "../obsidian-mock";
import { launch } from "../plugin-harness";
import { FakeWorld, project } from "../process-fakes";

const SLUG = "live-captions";
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "app-runner-unload-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  Notice.reset();
  Setting.reset();
  Platform.isDesktopApp = true;
  Platform.isMacOS = true;
});

let n = 0;
/** A world whose registry is a real file, so "byte-identical" means bytes. */
function fileWorld(over: Parameters<typeof project>[0] = {}) {
  const w = new FakeWorld(project(over));
  const file = path.join(tmp, `r${n++}`, "running.json");
  const registry = new Registry(file);
  return { w, registry, file, bytes: () => (fs.existsSync(file) ? fs.readFileSync(file) : null) };
}

async function openApp(l: Awaited<ReturnType<typeof launch>>, w: FakeWorld) {
  const opening = l.plugin.openProject(SLUG);
  await w.clock.settle();
  w.serve(8957);
  // Not clock.run: that would also run the 15 s kill timer of a project with no tab open. The registry is a real file, so
  // wait in real time for its writes between small steps of fake time.
  let done = false;
  void opening.then(() => (done = true));
  for (let i = 0; i < 400 && !done; i++) {
    await w.clock.advance(100);
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(done).toBe(true);
}

describe("G15 disabling or unloading the plugin leaves apps running", () => {
  it("signals nothing, leaves the processes alive and the registry file byte-identical", async () => {
    const { w, registry, bytes } = fileWorld();
    const l = await launch(w, { registry });
    await openApp(l, w);
    const before = bytes();
    expect(before).not.toBeNull();
    const procsBefore = JSON.stringify(w.procs);
    const spawnsBefore = w.spawns.length;

    l.plugin.onunload();
    await w.clock.advance(5 * 60_000);

    expect(w.signals).toEqual([]);
    expect(JSON.stringify(w.procs)).toBe(procsBefore);
    expect(w.spawns).toHaveLength(spawnsBefore);
    expect(bytes()!.equals(before!)).toBe(true);
  });

  it("clears the 15 s kill timer: closing the last tab, then unloading, never stops the app", async () => {
    const { w, registry, bytes } = fileWorld();
    const l = await launch(w, { registry });
    await openApp(l, w);
    l.leaves.splice(0); // the user closed the last tab
    l.layoutChange();
    expect(l.plugin.killTimer.isPending(SLUG)).toBe(true);
    const before = bytes()!;

    l.plugin.onunload();
    expect(l.plugin.killTimer.pendingCount).toBe(0);
    Notice.reset();
    await w.clock.advance(10 * 60_000);

    expect(w.signals).toEqual([]);
    expect(w.procs.length).toBeGreaterThan(0);
    expect(Notice.messages).toEqual([]);
    expect(bytes()!.equals(before)).toBe(true);
  });

  it("an unload while the app is still starting leaves the group running and its entry in the registry for the next launch (E5)", async () => {
    const { w, registry, bytes } = fileWorld();
    const l = await launch(w, { registry });
    const opening = l.plugin.openProject(SLUG);
    await w.clock.settle(); // spawned, still waiting for a port
    for (let i = 0; i < 200 && bytes() === null; i++) await new Promise((r) => setTimeout(r, 5)); // the entry is a real file write
    const leader = w.leaderPid();
    const before = bytes();
    expect(before).not.toBeNull();
    expect(Object.keys(JSON.parse(before!.toString()).entries)).toEqual([SLUG]);

    l.plugin.onunload();
    await w.clock.run(opening); // the open ends; it must not hang, fail or stop anything
    await w.clock.advance(5 * 60_000);

    expect(w.signals).toEqual([]);
    expect(w.procs.some((p) => p.pid === leader)).toBe(true);
    expect(bytes()!.equals(before!)).toBe(true);
    expect(Notice.messages.filter((m) => /stopped|could not start/i.test(m))).toEqual([]);
  });

  it("a stop decision that adoption is still waiting on is dropped at unload: nothing is stopped and nothing is said", async () => {
    const { w, registry, bytes } = fileWorld();
    const first = await launch(w, { registry });
    await openApp(first, w);
    first.plugin.onunload();

    const second = await launch(w, { registry }); // Obsidian restarted: no tab was restored, Kill is on
    const before = bytes()!;
    Notice.reset();
    second.layoutReady();
    await w.clock.advance(14_000);
    second.plugin.onunload(); // disabled inside the 15 s
    await w.clock.advance(5 * 60_000);

    expect(w.signals).toEqual([]);
    expect(Notice.messages).toEqual([]);
    expect(bytes()!.equals(before)).toBe(true);
  });

  it("nothing is written after unload even when the app dies later (the poll is gone)", async () => {
    const { w, registry, bytes } = fileWorld({ killOnClose: false });
    const first = await launch(w, { registry });
    await openApp(first, w);
    first.plugin.onunload();
    const second = await launch(w, { registry });
    second.layoutReady();
    await w.clock.advance(1000);
    const before = bytes()!;
    second.plugin.onunload();
    w.procs = [];
    await w.clock.advance(60_000);
    expect(bytes()!.equals(before)).toBe(true);
    expect(w.signals).toEqual([]);
  });

  it("unloading twice is harmless", async () => {
    const { w, registry } = fileWorld();
    const l = await launch(w, { registry });
    await openApp(l, w);
    l.plugin.onunload();
    l.plugin.onunload();
    expect(w.signals).toEqual([]);
  });

  it("listeners are dropped: no redraw or event reaches the old instance after unload", async () => {
    const { w, registry } = fileWorld();
    const l = await launch(w, { registry });
    await openApp(l, w);
    l.plugin.onunload();
    expect(l.plugin.instances.listenerCount).toBe(0);
    expect(l.plugin.sessions.listenerCount).toBe(0);
  });
});

describe("the stop-at-unload code is removed, not flagged off", () => {
  const root = path.resolve(__dirname, "../..");
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
  const sources = files(path.join(root, "src")).map((f) => ({ file: path.relative(root, f), text: fs.readFileSync(f, "utf8") }));

  it.each(["stopAllNow", "immediate", "unload-stop", "stopOnUnload", "stopAllOnUnload"])("%s appears nowhere in src", (token) => {
    expect(sources.filter((s) => s.text.includes(token)).map((s) => s.file)).toEqual([]);
  });

  it("onunload does not call any stop method", () => {
    const main = sources.find((s) => s.file === "src/main.ts")!.text;
    const body = main.slice(main.indexOf("onunload(): void {"), main.indexOf("private dataFilePath"));
    expect(body.length).toBeGreaterThan(50);
    expect(body).not.toMatch(/\.stop\w*\(|kill\(|SIGTERM|SIGKILL/);
  });
});
