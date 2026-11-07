import { afterAll, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realClock } from "../../src/clock";
import { InstanceManager } from "../../src/instance";
import { loopbackGet } from "../../src/loopback-http";
import { realKill, realProcessTable } from "../../src/process-group";
import { Registry, type RegistryStore } from "../../src/registry";
import { realRuntimeFs } from "../../src/runtime-fs";
import { logPath, registryPath } from "../../src/runtime-paths";
import { project } from "../process-fakes";

/**
 * E15 with real processes and a registry write that really fails. The group that was just spawned must be dead when the
 * notice appears, and nothing may be left untracked. Only pids this test saw spawned are ever checked or signalled.
 */

const SLUG = "live-captions";
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "app-runner-regfail-"));
const spawnedPids = new Set<number>();

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Members of one process group, from a real ps. */
function groupMembers(pgid: number): number[] {
  try {
    return execFileSync("ps", ["-o", "pid=", "-g", String(pgid)], { encoding: "utf8" })
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

afterEach(() => {
  for (const pgid of spawnedPids) {
    try {
      process.kill(-pgid, "SIGKILL"); // only groups this test started
    } catch {
      /* gone */
    }
  }
  spawnedPids.clear();
});
afterAll(() => {
  for (const d of fs.readdirSync(tmp)) {
    try {
      fs.chmodSync(path.join(tmp, d), 0o700);
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function manager(runtime: string, registry: RegistryStore) {
  fs.mkdirSync(path.join(tmp, "work"), { recursive: true });
  const notices: string[] = [];
  const seen: number[] = [];
  const m = new InstanceManager({
    getProject: () => project({ folder: path.join(tmp, "work"), command: "sleep 300 & exec sleep 301" }),
    runtimeDir: runtime,
    notify: (n) => void notices.push(n),
    openExternal: () => {},
    pickPort: async (_p, ports) => ports[0],
    rememberUrl: async () => {},
    fs: realRuntimeFs,
    shell: "/bin/sh",
    shellFlags: "-c",
    table: realProcessTable,
    lsof: async () => "",
    kill: (pid, sig) => {
      if (pid < 0) seen.push(-pid);
      realKill(pid, sig);
    },
    http: loopbackGet,
    clock: realClock,
    registry,
    graceMs: 1500,
    readyTimeoutMs: 5000,
  });
  return { m, notices, seen };
}

describe("E15 a registry write that fails at spawn stops the app just started", () => {
  it("read-only runtime folder: the group is dead, the notice names the failure, no entry and no process is left", async () => {
    const runtime = path.join(tmp, "rt-readonly");
    fs.mkdirSync(path.join(runtime, "logs"), { recursive: true });
    fs.chmodSync(runtime, 0o500); // logs can still be written; running.json and its temporary file cannot
    const { m, notices, seen } = manager(runtime, new Registry(registryPath(runtime)));

    const out = await m.open(SLUG);
    expect(out).toEqual({ kind: "failed" });
    // The group that was just spawned: its pgid is what the instance tried to signal.
    expect(seen.length).toBeGreaterThan(0);
    const pgid = seen[0];
    spawnedPids.add(pgid);
    expect(groupMembers(pgid)).toEqual([]); // nothing of the group is left: leader and the sleep child are both gone
    expect(alive(pgid)).toBe(false);

    expect(notices.at(-1)).toContain("could not record it");
    expect(notices.at(-1)).toMatch(/EACCES|permission denied/i);
    expect(notices.at(-1)).toContain("must not keep running");
    expect(m.stateOf(SLUG)).toBe("none");
    expect(fs.existsSync(registryPath(runtime))).toBe(false);
    expect(fs.readdirSync(runtime)).toEqual(["logs"]); // no temporary file either
    expect(fs.existsSync(logPath(runtime, SLUG))).toBe(true); // the log stays for the user to read
  }, 30_000);

  it("disk full (ENOSPC) at the rename: the same outcome", async () => {
    const runtime = path.join(tmp, "rt-full");
    fs.mkdirSync(runtime, { recursive: true });
    const failing: RegistryStore = {
      read: async () => ({ version: 1, entries: {} }),
      remove: async () => undefined,
      set: async () => {
        throw Object.assign(new Error("ENOSPC: no space left on device, rename 'running.json.tmp' -> 'running.json'"), { code: "ENOSPC" });
      },
    };
    const { m, notices, seen } = manager(runtime, failing);
    expect(await m.open(SLUG)).toEqual({ kind: "failed" });
    const pgid = seen[0];
    spawnedPids.add(pgid);
    expect(groupMembers(pgid)).toEqual([]);
    expect(notices.at(-1)).toContain("ENOSPC");
    expect(notices.at(-1)).toContain("could not record it");
    expect(m.stateOf(SLUG)).toBe("none");
  }, 30_000);

  it("the rename fails (running.json is a directory): the same outcome, and the earlier directory is untouched", async () => {
    const runtime = path.join(tmp, "rt-rename");
    fs.mkdirSync(path.join(runtime, "running.json", "keep"), { recursive: true });
    const { m, notices, seen } = manager(runtime, new Registry(registryPath(runtime)));
    expect(await m.open(SLUG)).toEqual({ kind: "failed" });
    const pgid = seen[0];
    spawnedPids.add(pgid);
    expect(groupMembers(pgid)).toEqual([]);
    expect(notices.at(-1)).toContain("could not record it");
    expect(fs.existsSync(path.join(runtime, "running.json", "keep"))).toBe(true);
    expect(fs.readdirSync(runtime).filter((f) => f.includes(".tmp-"))).toEqual([]);
  }, 30_000);
});
