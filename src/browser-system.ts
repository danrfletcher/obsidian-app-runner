import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { SUPPORTED_BROWSERS, parseDefaultBrowserBundleId, type SupportedBrowser } from "./default-browser";

/** How the plugin asks the system about the browser. Each is real here and a fake in tests. */
export interface OsascriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `osascript` with these arguments. Never rejects: a failure to run is a non-zero code with the reason in `stderr`. */
export type OsascriptRunner = (args: string[]) => Promise<OsascriptResult>;

/** The default browser's bundle id as macOS reports it; rejects when it cannot be read. */
export type DefaultBrowserReader = () => Promise<string>;

/** Is the app with this bundle id running now? Must not start it. */
export type RunningCheck = (bundleId: string) => Promise<boolean>;

/** How long one osascript call may take. A first call waits on the macOS Automation prompt, so this is generous. */
export const OSASCRIPT_TIMEOUT_MS = 30_000;

/**
 * The three system tools, found on PATH by name (the macOS ones live in /usr/bin, which Obsidian's PATH has). That is
 * what lets the container check put a fake `osascript` (and `plutil`, `lsappinfo`) first on PATH for the same code.
 * Nothing but these literal names and the arguments built in this file is ever run.
 */
const OSASCRIPT = "osascript";
const PLUTIL = "plutil";
const LSAPPINFO = "lsappinfo";

export const realOsascript: OsascriptRunner = (args) =>
  new Promise((resolve) => {
    execFile(OSASCRIPT, args, { timeout: OSASCRIPT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as { code?: unknown; killed?: boolean };
      if (e.killed) return resolve({ code: 1, stdout, stderr: "osascript timed out" });
      resolve({ code: typeof e.code === "number" ? e.code : 1, stdout, stderr: stderr || err.message });
    });
  });

/** The default browser, read from the LaunchServices preferences with `plutil` (no AppleScript, so nothing is launched). */
export const realDefaultBrowser: DefaultBrowserReader = () =>
  new Promise((resolve, reject) => {
    const file = path.join(os.homedir(), "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
    execFile(PLUTIL, ["-convert", "json", "-o", "-", file], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      if (err) {
        // No such file: no handler was ever chosen, which is Safari.
        if (/No such file|couldn.t be opened/i.test(`${err.message}`)) return resolve(parseDefaultBrowserBundleId("{}"));
        return reject(err);
      }
      try {
        resolve(parseDefaultBrowserBundleId(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });

const KNOWN_BUNDLE_IDS = new Set<string>(Object.values(SUPPORTED_BROWSERS).map((b: SupportedBrowser) => b.bundleId.toLowerCase()));

/**
 * `lsappinfo find bundleid=<id>` prints the app's ASN when it is running and nothing when it is not. It only asks the
 * system about running applications; it never starts one. Only an allow-listed bundle id is ever passed to it.
 */
export const realIsRunning: RunningCheck = (bundleId) =>
  new Promise((resolve, reject) => {
    if (!KNOWN_BUNDLE_IDS.has(bundleId.toLowerCase())) return reject(new Error("not a supported browser"));
    execFile(LSAPPINFO, ["find", `bundleid=${bundleId}`], { timeout: 10_000, encoding: "utf8" }, (err, stdout) => {
      if (err) return reject(err);
      resolve(/ASN:/.test(stdout));
    });
  });
