import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Adoption } from "../../src/adopt";
import { realClock } from "../../src/clock";
import { InstanceManager, type InstanceDeps } from "../../src/instance";
import { loopbackGet } from "../../src/loopback-http";
import type { LsofRunner } from "../../src/port-discovery";
import { realKill, realProcessTable } from "../../src/process-group";
import { Registry } from "../../src/registry";
import { realRuntimeFs } from "../../src/runtime-fs";
import { logPath, registryPath } from "../../src/runtime-paths";
import { project } from "../process-fakes";

/**
 * GP7 and E5 with real processes. A real throwaway group (a server, its worker child and a `sleep`) is started through
 * the same spawn module the plugin uses; the plugin instance is dropped as Obsidian quitting would drop it (nothing is
 * signalled); a new one is built on the same runtime directory and has to adopt the group by pid and start time. Stop
 * then has to end the whole group. Ports are chosen by the OS, never a product port; lsof is faked (it reads the port the
 * fixture printed) because it is not on every CI machine. Only groups this test started are ever signalled.
 */

const SLUG = "build-dashboard";
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "app-runner-survive-"));
const started = new Set<number>();
const managers: InstanceManager[] = [];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SERVER = `
const http = require("http");
const { spawn } = require("child_process");
const s = http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end("<h1>ok</h1>"); });
s.listen(0, "127.0.0.1", () => console.log("listening", s.address().port));
spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
`;

function fakeLsofFor(logFile: string): LsofRunner {
  return async (pids) => {
    let text = "";
    try {
      text = fs.readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
    const lines = [...text.matchAll(/^listening (\d+)$/gm)].map((m) => `node ${pids[0]} dan 12u IPv4 0x1 0t0 TCP 127.0.0.1:${m[1]} (LISTEN)`);
    return lines.length ? ["COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME", ...lines].join("\n") : "";
  };
}

/** One "Obsidian session" on a runtime directory: everything in memory is new, the directory is shared. */
function session(runtime: string, killOnClose: boolean) {
  const folder = path.join(tmp, "work");
  fs.mkdirSync(folder, { recursive: true });
  const server = path.join(tmp, "server.js");
  fs.writeFileSync(server, SERVER);
  const notices: string[] = [];
  const p = project({ slug: SLUG, name: "Build Dashboard", folder, killOnClose, command: `sleep 300 & exec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)}` });
  const registry = new Registry(registryPath(runtime));
  const deps: InstanceDeps = {
    getProject: () => p,
    runtimeDir: runtime,
    notify: (n) => void notices.push(n),
    openExternal: () => {},
    pickPort: async (_p, ports) => ports[0],
    rememberUrl: async () => {},
    fs: realRuntimeFs,
    shell: "/bin/sh",
    shellFlags: "-c",
    table: realProcessTable,
    lsof: fakeLsofFor(logPath(runtime, SLUG)),
    kill: realKill,
    http: loopbackGet,
    clock: realClock,
    registry,
    graceMs: 1500,
    readyTimeoutMs: 15_000,
    livenessMs: 200,
  };
  const m = new InstanceManager(deps);
  managers.push(m);
  const tabs = { count: 0 };
  const adoption = new Adoption({
    registry,
    table: realProcessTable,
    target: m,
    getProject: () => p,
    sessionCount: () => tabs.count,
    killOnClose: () => p.killOnClose,
    clock: realClock,
    notify: (n) => void notices.push(n),
    graceMs: 300,
  });
  return { m, registry, notices, adoption, tabs };
}

afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
  for (const pgid of started) {
    try {
      process.kill(-pgid, "SIGKILL"); // only groups this test started
    } catch {
      /* gone */
    }
  }
  started.clear();
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("GP7 and E5: the app outlives the plugin and is adopted by pid and start time", () => {
  it("quit with the tab open: the group keeps running, a new session adopts the same pid and pgid and Stop ends the whole group", async () => {
    const runtime = path.join(tmp, "rt-survive");
    const one = session(runtime, true);
    const outcome = await one.m.open(SLUG);
    expect(outcome.kind).toBe("tab");
    const url = (outcome as { url: string }).url;
    const before = (await one.registry.read()).entries[SLUG];
    started.add(before.pgid);
    expect(before.pid).toBe(before.pgid);
    expect(before.members.length).toBeGreaterThanOrEqual(3); // server, worker child and sleep
    expect(before.members.every((m) => m.startTime.length > 10)).toBe(true);
    const pids = before.members.map((m) => m.pid);
    const bytesBefore = fs.readFileSync(registryPath(runtime));

    // Obsidian quits or the plugin is disabled: nothing is signalled, nothing is written.
    one.m.dispose();
    await sleep(500);
    expect(pids.every(alive)).toBe(true);
    expect(fs.readFileSync(registryPath(runtime)).equals(bytesBefore)).toBe(true);

    // Obsidian starts again, with the restored tab counted.
    const two = session(runtime, true);
    two.tabs.count = 1;
    const report = await two.adoption.adoptAll();
    expect(report).toEqual({ adopted: [SLUG], dropped: [], refused: [] });
    const [row] = two.m.snapshots();
    expect(row).toMatchObject({ slug: SLUG, state: "running", adopted: true, url });
    const after = (await two.registry.read()).entries[SLUG];
    expect([after.pid, after.pgid]).toEqual([before.pid, before.pgid]); // the same instance
    expect(after.members.map((m) => [m.pid, m.startTime])).toEqual(expect.arrayContaining(before.members.map((m) => [m.pid, m.startTime])));

    await two.adoption.layoutReady();
    await sleep(600);
    expect(two.m.stateOf(SLUG)).toBe("running"); // the restored tab keeps it
    expect(pids.every(alive)).toBe(true);

    expect(await two.m.stop(SLUG)).toBe("stopped");
    expect(pids.some(alive)).toBe(false); // the whole group, not just the leader
    expect((await two.registry.read()).entries).toEqual({});
  }, 40_000);

  it("E5: the plugin quits while the app is still starting: the entry exists from spawn and the next launch adopts the group", async () => {
    const runtime = path.join(tmp, "rt-starting");
    const one = session(runtime, false);
    // A server that is slow to listen: the plugin goes away in the middle of the start.
    const slow = path.join(tmp, "slow.js");
    fs.writeFileSync(slow, `setTimeout(() => { ${SERVER} }, 1500); setInterval(() => {}, 1000);`);
    const p = project({ slug: SLUG, folder: path.join(tmp, "work"), killOnClose: false, command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(slow)}` });
    one.m["deps"].getProject = () => p;
    const opening = one.m.open(SLUG);
    let entry;
    for (let i = 0; i < 200 && !entry; i++) {
      await sleep(10);
      entry = (await one.registry.read()).entries[SLUG];
    }
    expect(entry).toBeDefined();
    started.add(entry!.pgid);
    expect(entry!.port).toBeNull(); // not ready yet
    one.m.dispose();
    expect(await opening).toEqual({ kind: "cancelled" });
    expect(alive(entry!.pid)).toBe(true);

    const two = session(runtime, false);
    two.m["deps"].getProject = () => p;
    const report = await two.adoption.adoptAll();
    expect(report.adopted).toEqual([SLUG]);
    expect(two.m.snapshots()[0]).toMatchObject({ slug: SLUG, state: "running", adopted: true });
    // The port is found once the app listens: the liveness poll keeps looking while it is unknown.
    for (let i = 0; i < 150 && two.m.snapshots()[0].port === null; i++) await sleep(100);
    expect(two.m.snapshots()[0].port).not.toBeNull();
    expect(two.m.snapshots()[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await two.m.stop(SLUG)).toBe("stopped");
    expect(alive(entry!.pid)).toBe(false);
  }, 40_000);

  it("E21: an adopted app that dies is noticed by the liveness poll with no exit event, and its entry is dropped", async () => {
    const runtime = path.join(tmp, "rt-dies");
    const one = session(runtime, false);
    await one.m.open(SLUG);
    const entry = (await one.registry.read()).entries[SLUG];
    started.add(entry.pgid);
    one.m.dispose();

    const two = session(runtime, false);
    await two.adoption.adoptAll();
    expect(two.m.stateOf(SLUG)).toBe("running");
    const ended: string[] = [];
    two.m.subscribe((e) => e.type === "ended" && ended.push(e.cause));
    process.kill(-entry.pgid, "SIGKILL"); // dies while nobody is watching
    for (let i = 0; i < 100 && two.m.stateOf(SLUG) !== "none"; i++) await sleep(50);
    expect(two.m.stateOf(SLUG)).toBe("none");
    expect(ended).toEqual(["crashed"]);
    expect((await two.registry.read()).entries).toEqual({});
  }, 40_000);

  it("E6/E7 with real ps: a registry written before a reboot (other start times) is dropped and the live process with that pid is not signalled", async () => {
    const runtime = path.join(tmp, "rt-reboot");
    fs.mkdirSync(runtime, { recursive: true });
    // A real, unrelated process whose pid is written into the registry with the wrong start time.
    const { spawn } = await import("node:child_process");
    const bystander = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    bystander.unref();
    started.add(bystander.pid!);
    fs.writeFileSync(
      registryPath(runtime),
      JSON.stringify({
        version: 1,
        entries: { [SLUG]: { slug: SLUG, pid: bystander.pid, pgid: bystander.pid, members: [{ pid: bystander.pid, startTime: "Mon Jan  1 00:00:00 2001" }], port: 4317, startedAt: 1, browserSessionExpected: false } },
      }),
    );
    const killed: Array<[number, string]> = [];
    const s = session(runtime, true);
    (s.m["deps"] as { kill: InstanceDeps["kill"] }).kill = (pid, sig) => {
      killed.push([pid, sig]);
      realKill(pid, sig);
    };
    const report = await s.adoption.adoptAll();
    await s.adoption.layoutReady();
    expect(report.dropped).toEqual([SLUG]);
    expect(killed).toEqual([]);
    expect(alive(bystander.pid!)).toBe(true);
    expect((await s.registry.read()).entries).toEqual({});
  }, 20_000);
});
