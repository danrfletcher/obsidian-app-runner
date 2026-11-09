import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_SHELL = "/bin/zsh";
/** Login (-l) and interactive (-i) so the app sees the PATH Dan's Terminal has (nvm node), command (-c). */
export const SHELL_FLAGS = "-lic";

/** The part of a Node `ChildProcess` the plugin uses. */
export interface SpawnedChild {
  pid?: number;
  exitCode: number | null;
  signalCode: string | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  unref?(): void;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedChild;

export interface LogFs {
  mkdirSync(dir: string, options: { recursive: true }): unknown;
  /** Open for writing and truncate. Returns the file descriptor. */
  openSync(file: string, flags: "w"): number;
  closeSync(fd: number): void;
}

export interface SpawnAppOptions {
  command: string;
  cwd: string;
  logFile: string;
  /** Injectable for tests; the real plugin uses `/bin/zsh`. */
  shell?: string;
  /** Injectable for tests that must not read the user's shell profiles. The real plugin uses `-lic`. */
  shellFlags?: string;
}

export interface SpawnAppDeps {
  spawn?: SpawnFn;
  fs?: LogFs;
}

/**
 * Start the project's command through a login interactive shell, in its own process group (`detached` makes the child a
 * session and group leader). stdin is `ignore` (F3: no stdin); stdout and stderr both go to the log file, which is
 * truncated here, at each start, and never capped. Nothing in the project folder is touched (F5): the command is run
 * as given.
 */
export function spawnApp(options: SpawnAppOptions, deps: SpawnAppDeps = {}): SpawnedChild {
  const fsApi = deps.fs ?? fs;
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  fsApi.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const fd = fsApi.openSync(options.logFile, "w");
  try {
    const child = spawn(options.shell ?? DEFAULT_SHELL, [options.shellFlags ?? SHELL_FLAGS, options.command], {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    child.unref?.();
    return child;
  } finally {
    // The child has its own copy of the descriptor; the plugin must not hold the log open.
    fsApi.closeSync(fd);
  }
}
