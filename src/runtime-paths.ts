import * as os from "node:os";
import * as path from "node:path";

export const RUNTIME_ROOT_NAME = "Obsidian App Runner";

/** A single path segment made of safe characters only: no separators, no `..`, no empty string. */
function safeSegment(value: string, what: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`Refusing to use "${value}" as the ${what} in a runtime path.`);
  }
  return value;
}

/**
 * Where runtime state (the registry and the logs) lives: `~/Library/Application Support/Obsidian App Runner/<vault key>/`.
 * Outside the vault on purpose (F16). The key comes from data.json, so it is checked before it becomes a folder name.
 */
export function runtimeDir(vaultKey: string, home: string = os.homedir()): string {
  return path.join(home, "Library", "Application Support", RUNTIME_ROOT_NAME, safeSegment(vaultKey, "vault key"));
}

/** `logs/<slug>.log` under the runtime directory (G17). */
export function logPath(runtime: string, slug: string): string {
  return path.join(runtime, "logs", `${safeSegment(slug, "project slug")}.log`);
}

export function registryPath(runtime: string): string {
  return path.join(runtime, "running.json");
}
