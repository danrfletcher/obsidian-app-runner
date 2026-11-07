import { afterAll, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { InstanceManager, type InstanceDeps } from "../../src/instance";
import { loopbackGet } from "../../src/loopback-http";
import { realLsof, type LsofRunner } from "../../src/port-discovery";
import { realKill, realProcessTable } from "../../src/process-group";
import { Registry } from "../../src/registry";
import { realRuntimeFs } from "../../src/runtime-fs";
import { logPath, registryPath } from "../../src/runtime-paths";
import { realClock } from "../../src/clock";
import { project } from "../process-fakes";

/**
 * Real `sh` child groups in a temp folder: real ps, real signals, a real loopback HTTP probe and a real registry file.
 * lsof is faked (it is not on every CI machine): it reports the port the fixture printed to its log, as listening on the
 * group's leader. Everything listens on a port the OS picks (port 0), never a product port. Only the shell flags differ
 * from production (`/bin/sh -c`, not the user's login zsh) so the test does not run Dan's dotfiles.
 */

const SLUG = "live-captions";
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "app-runner-real-"));
const started: number[] = [];
const managers: InstanceManager[] = [];
let foreign: http.Server | undefined;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A listener script in a file: it prints nothing, binds an OS-chosen port and keeps a worker child in the same group. */
function writeApp(name: string, body: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body);
  return file;
}

/** lsof as the fixtures need it: the port is read back from the "listening <port>" line the fixture printed. */
function fakeLsofFor(logFile: () => string): LsofRunner {
  return async (pids) => {
    let text = "";
    try {
      text = fs.readFileSync(logFile(), "utf8");
    } catch {
      return "";
    }
    const lines = [...text.matchAll(/^listening (\d+)$/gm)].map(
      (m) => `node ${pids[0]} dan 12u IPv4 0x1 0t0 TCP 127.0.0.1:${m[1]} (LISTEN)`,
    );
    return lines.length ? ["COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME", ...lines].join("\n") : "";
  };
}

function setup(command: string, over: Partial<InstanceDeps> = {}, projectOver = {}) {
  const runtime = path.join(tmp, `rt-${Math.random().toString(36).slice(2)}`);
  const folder = path.join(tmp, "work");
  fs.mkdirSync(folder, { recursive: true });
  const notices: string[] = [];
  const registry = new Registry(registryPath(runtime));
  const p = project({ command, folder, ...projectOver });
  const m = new InstanceManager({
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
    lsof: fakeLsofFor(() => logPath(runtime, SLUG)),
    kill: realKill,
    http: loopbackGet,
    clock: realClock,
    registry,
    graceMs: 1500,
    readyTimeoutMs: 15_000,
    ...over,
  });
  managers.push(m);
  return { m, runtime, notices, registry, folder };
}

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop(SLUG).catch(() => undefined);
  for (const pid of started.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL"); // only groups this test started
    } catch {
      /* gone */
    }
  }
  await new Promise<void>((resolve) => (foreign ? foreign.close(() => resolve()) : resolve()));
  foreign = undefined;
});

const SERVER = `
const http = require("http");
const { spawn } = require("child_process");
const s = http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end("<h1>ok</h1>"); });
s.listen(0, "127.0.0.1", () => console.log("listening", s.address().port));
spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
`;

describe("the real process path", () => {
  it("starts a shell command, finds its port with lsof, waits for HTTP, and Stop kills the leader and its child", async () => {
    const server = writeApp("server.js", SERVER);
    const { m, runtime, registry } = setup(`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)}`);
    const opening = m.open(SLUG);
    const outcome = await opening;
    expect(outcome.kind).toBe("tab");
    const url = (outcome as { url: string }).url;
    expect(url).toMatch(/^http:\/\/127\.0\.0.1:\d+\/$/);

    const entry = (await registry.read()).entries[SLUG];
    expect(entry.pid).toBe(entry.pgid);
    started.push(entry.pgid);
    expect(entry.port).toBe(Number(new URL(url).port));
    expect(entry.members.length).toBeGreaterThanOrEqual(2); // leader and the worker child
    expect(fs.readFileSync(logPath(runtime, SLUG), "utf8")).toContain("listening");

    const pids = entry.members.map((x) => x.pid);
    expect(pids.every(alive)).toBe(true);
    expect(await m.stop(SLUG)).toBe("stopped");
    expect(pids.some(alive)).toBe(false);
    expect((await registry.read()).entries).toEqual({});
  }, 30_000);

  it("a child that ignores SIGTERM is SIGKILLed after the grace period", async () => {
    const stubborn = writeApp("stubborn.js", `process.on("SIGTERM", () => {}); require("http").createServer((q, r) => r.end("x")).listen(0, "127.0.0.1", function () { console.log("listening", this.address().port); }); setInterval(() => {}, 1000);`);
    const { m, registry } = setup(`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(stubborn)}`);
    expect((await m.open(SLUG)).kind).toBe("tab");
    const entry = (await registry.read()).entries[SLUG];
    started.push(entry.pgid);
    const t0 = Date.now();
    expect(await m.stop(SLUG)).toBe("stopped");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    await new Promise((r) => setTimeout(r, 200)); // let the exited leader be reaped
    expect(alive(entry.pgid)).toBe(false);
  }, 30_000);

  it("E2: a command that does not exist fails at once, with the shell's message in the notice and nothing left", async () => {
    const { m, notices, registry } = setup("definitely-not-a-real-command-xyz");
    const t0 = Date.now();
    expect((await m.open(SLUG)).kind).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(notices.at(-1)).toContain("not found");
    expect((await registry.read()).entries).toEqual({});
    expect(m.stateOf(SLUG)).toBe("none");
  }, 30_000);

  it("E4: when a foreign program holds the URL-override port, it is not taken for the app and not signalled", async () => {
    foreign = http.createServer((_q, r) => r.end("mine"));
    await new Promise<void>((resolve) => foreign!.listen(0, "127.0.0.1", resolve));
    const port = (foreign.address() as { port: number }).port;
    const exits = writeApp("exits.js", `console.error("Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}"); process.exit(1);`);
    const { m, notices } = setup(`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(exits)}`, {}, { urlOverride: `http://127.0.0.1:${port}/` });
    expect((await m.open(SLUG)).kind).toBe("failed");
    expect(notices.at(-1)).toContain("already in use by another program");
    // the foreign server still answers
    const res = await loopbackGet(`http://127.0.0.1:${port}/`, { signal: new AbortController().signal });
    expect(res.status).toBe(200);
  }, 30_000);

  it("F11: a registry entry whose group is not ours (wrong start time) is never signalled by Stop", async () => {
    // A bystander process group the test starts itself; the registry claims it, but with a start time that does not match.
    const { spawn } = await import("node:child_process");
    const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    bystander.unref();
    const pid = bystander.pid!;
    started.push(pid);
    const { stopGroup } = await import("../../src/process-group");
    const { realKill: kill } = await import("../../src/process-group");
    const sent: number[] = [];
    const out = await stopGroup({
      pgid: pid,
      members: [{ pid, startTime: "Thu Jan  1 00:00:00 1970" }],
      table: realProcessTable,
      kill: (p, s) => (sent.push(p), kill(p, s)),
      clock: realClock,
    });
    expect(out).toBe("not-ours");
    expect(sent).toEqual([]);
    expect(alive(pid)).toBe(true);
  }, 30_000);
});

describe("F13 a child that daemonises", () => {
  it("survives the group kill; the plugin signals only the group and does not hunt it", async () => {
    const pidFile = path.join(tmp, "daemon.pid");
    const daemoniser = writeApp(
      "daemoniser.js",
      `
      const { spawn } = require("child_process");
      const fs = require("fs");
      // detached: true makes the child a new session and group leader: it leaves our process group.
      const d = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
      d.unref();
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(d.pid));
      require("http").createServer((q, r) => r.end("x")).listen(0, "127.0.0.1", function () { console.log("listening", this.address().port); });
      `,
    );
    const sent: Array<[number, string]> = [];
    const { m, registry } = setup(`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(daemoniser)}`, {
      kill: (pid, sig) => (sent.push([pid, sig]), realKill(pid, sig)),
    });
    expect((await m.open(SLUG)).kind).toBe("tab");
    const entry = (await registry.read()).entries[SLUG];
    started.push(entry.pgid);
    const daemon = Number(fs.readFileSync(pidFile, "utf8"));
    started.push(daemon);
    expect(daemon).not.toBe(entry.pgid);
    expect(entry.members.map((x) => x.pid)).not.toContain(daemon); // it left the group, so it is not a member

    expect(await m.stop(SLUG)).toBe("stopped");
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(entry.pgid)).toBe(false);
    expect(alive(daemon)).toBe(true); // survives, as documented in the README
    expect(sent.every(([pid]) => pid === -entry.pgid)).toBe(true); // nothing aimed at the daemon
    expect(m.stateOf(SLUG)).toBe("none");
  }, 30_000);
});

describe("F5 the project folder is left alone", () => {
  const listing = (dir: string) =>
    fs
      .readdirSync(dir, { recursive: true })
      .map(String)
      .sort()
      .map((f) => `${f} ${fs.statSync(path.join(dir, f)).mtimeMs}`);

  it("file list and mtimes are identical after start and stop", async () => {
    const server = writeApp("server2.js", SERVER);
    const { m, folder } = setup(`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)}`);
    fs.writeFileSync(path.join(folder, "package.json"), "{}");
    fs.mkdirSync(path.join(folder, "sub"), { recursive: true });
    fs.writeFileSync(path.join(folder, "sub", "a.txt"), "a");
    const before = listing(folder);
    expect((await m.open(SLUG)).kind).toBe("tab");
    expect(await m.stop(SLUG)).toBe("stopped");
    expect(listing(folder)).toEqual(before);
  }, 30_000);
});

describe.skipIf(!hasLsof())("with the real lsof", () => {
  it("finds the port of a real listener in the group", async () => {
    const server = writeApp("server3.js", SERVER);
    const { m, registry } = setup(`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)}`, { lsof: realLsof });
    const out = await m.open(SLUG);
    expect(out.kind).toBe("tab");
    started.push((await registry.read()).entries[SLUG].pgid);
    expect(await m.stop(SLUG)).toBe("stopped");
  }, 30_000);
});

function hasLsof(): boolean {
  try {
    execFileSync("lsof", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    // `lsof -v` exits non-zero on some versions even though it is installed
    try {
      return execFileSync("sh", ["-c", "command -v lsof"], { encoding: "utf8" }).trim() !== "";
    } catch {
      return false;
    }
  }
}
