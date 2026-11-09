import { describe, expect, it } from "vitest";
import type { SpawnOptions } from "node:child_process";
import { DEFAULT_SHELL, SHELL_FLAGS, spawnApp, type LogFs, type SpawnedChild } from "../../src/spawn";
import { FakeChild } from "../process-fakes";

function setup() {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const fsCalls: string[] = [];
  const fs: LogFs = {
    mkdirSync: (dir) => void fsCalls.push(`mkdir ${dir}`),
    openSync: (file, flags) => (fsCalls.push(`open ${file} ${flags}`), 42),
    closeSync: (fd) => void fsCalls.push(`close ${fd}`),
  };
  let child = new FakeChild(321);
  const spawn = (command: string, args: string[], options: SpawnOptions): SpawnedChild => {
    calls.push({ command, args, options });
    fsCalls.push("spawn");
    return child;
  };
  return { calls, fsCalls, fs, spawn, setChild: (c: FakeChild) => (child = c) };
}

describe("spawnApp (GP3, F3)", () => {
  it("runs `zsh -lic <command>` in the project folder, detached, with stdin ignored", () => {
    const { calls, fs, spawn } = setup();
    spawnApp({ command: "npm run start", cwd: "/work/live-captions", logFile: "/rt/logs/live-captions.log" }, { spawn, fs });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/bin/zsh");
    expect(calls[0].args).toEqual(["-lic", "npm run start"]);
    expect(calls[0].options.cwd).toBe("/work/live-captions");
    expect(calls[0].options.detached).toBe(true);
    expect(DEFAULT_SHELL).toBe("/bin/zsh");
    expect(SHELL_FLAGS).toBe("-lic");
  });

  it("stdin is ignore and stdout and stderr are the same log file descriptor", () => {
    const { calls, fs, spawn } = setup();
    spawnApp({ command: "c", cwd: "/x", logFile: "/rt/logs/a.log" }, { spawn, fs });
    expect(calls[0].options.stdio).toEqual(["ignore", 42, 42]);
  });

  it("the log is opened for writing (truncating) before the spawn and closed in the plugin after it", () => {
    const { fsCalls, fs, spawn } = setup();
    spawnApp({ command: "c", cwd: "/x", logFile: "/rt/logs/a.log" }, { spawn, fs });
    expect(fsCalls).toEqual(["mkdir /rt/logs", "open /rt/logs/a.log w", "spawn", "close 42"]);
  });

  it("each start truncates: two starts open the log with 'w' twice and never with 'a'", () => {
    const { fsCalls, fs, spawn } = setup();
    spawnApp({ command: "c", cwd: "/x", logFile: "/rt/logs/a.log" }, { spawn, fs });
    spawnApp({ command: "c", cwd: "/x", logFile: "/rt/logs/a.log" }, { spawn, fs });
    expect(fsCalls.filter((c) => c.startsWith("open"))).toEqual(["open /rt/logs/a.log w", "open /rt/logs/a.log w"]);
  });

  it("the shell binary and flags are injectable; the command is passed as one argument, never split", () => {
    const { calls, fs, spawn } = setup();
    spawnApp({ command: "echo 'a b' && ls", cwd: "/x", logFile: "/l", shell: "/bin/sh", shellFlags: "-c" }, { spawn, fs });
    expect(calls[0].command).toBe("/bin/sh");
    expect(calls[0].args).toEqual(["-c", "echo 'a b' && ls"]);
  });

  it("closes the log descriptor even when the spawn throws", () => {
    const { fsCalls, fs } = setup();
    const boom = () => {
      throw new Error("spawn failed");
    };
    expect(() => spawnApp({ command: "c", cwd: "/x", logFile: "/l" }, { spawn: boom, fs })).toThrow("spawn failed");
    expect(fsCalls).toContain("close 42");
  });

  it("detaches the child from the plugin's event loop", () => {
    const { fs, spawn, setChild } = setup();
    const child = new FakeChild(5);
    let unrefs = 0;
    child.unref = () => void unrefs++;
    setChild(child);
    spawnApp({ command: "c", cwd: "/x", logFile: "/l" }, { spawn, fs });
    expect(unrefs).toBe(1);
  });
});
