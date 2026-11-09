import { SUPPORTED_BROWSERS, type SupportedBrowser, type SupportedBrowserId } from "./default-browser";

/**
 * F15: the AppleScript that lists a browser's open tab URLs. One fixed template; the only thing placed in it is the
 * app name of a browser in the `SUPPORTED_BROWSERS` allow-list, looked up by id here, so no user, page or registry text
 * can reach the script. The script checks `is running` itself (which does not launch the app) as well as the caller
 * having checked: a browser that quit in between is still not started by it. One URL per line comes back.
 */
export function tabUrlsScript(browserId: SupportedBrowserId): string[] {
  const browser: SupportedBrowser | undefined = Object.prototype.hasOwnProperty.call(SUPPORTED_BROWSERS, browserId) ? SUPPORTED_BROWSERS[browserId] : undefined;
  if (!browser) throw new Error("tabUrlsScript: not a supported browser");
  const app = browser.appName;
  return [
    `set tabUrls to ""`,
    `if application "${app}" is running then`,
    `tell application "${app}"`,
    `repeat with w in windows`,
    `repeat with t in tabs of w`,
    `set tabUrls to tabUrls & (URL of t) & linefeed`,
    `end repeat`,
    `end repeat`,
    `end tell`,
    `end if`,
    `return tabUrls`,
  ];
}

/** The `osascript` arguments for a script given as lines: `-e line` for each. */
export function osascriptArgs(lines: readonly string[]): string[] {
  return lines.flatMap((line) => ["-e", line]);
}

/** One URL per line, as `tabUrlsScript` returns them. Blank lines are dropped. */
export function parseTabUrls(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

export type OsascriptFailure = { kind: "denied" } | { kind: "not-running" } | { kind: "error"; message: string };

const MAX_MESSAGE = 200;

/**
 * Sort a failed osascript run. Error -1743 ("Not authorized to send Apple events") and -1744 (consent would be needed
 * but cannot be asked) are the Automation permission being denied or revoked. -600 is the app not running (it quit
 * between the check and the call). Anything else is a read error, with the first line of what osascript said.
 */
export function classifyOsascriptFailure(stderr: string): OsascriptFailure {
  if (/\(-174[34]\)|not authori[sz]ed to send apple events/i.test(stderr)) return { kind: "denied" };
  if (/\(-600\)|isn.t running/i.test(stderr)) return { kind: "not-running" };
  const first = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return { kind: "error", message: (first ?? "osascript failed").slice(0, MAX_MESSAGE) };
}
