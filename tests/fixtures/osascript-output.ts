/**
 * Canned `osascript` results, as the fixed tab-listing script in src/browser-script.ts returns them (one URL per line),
 * and the error text osascript prints when the Automation permission is refused or the app is gone. The fake runner in
 * tests/browser-fakes.ts hands these to the real parsing and matching code.
 */
import type { OsascriptResult } from "../../src/browser-system";

export const ok = (stdout: string): OsascriptResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): OsascriptResult => ({ code: 1, stdout: "", stderr });

export const lines = (...urls: string[]): OsascriptResult => ok(urls.length ? `${urls.join("\n")}\n` : "");

/** One canned listing per browser in the allow-list: the app tab on 8957 among others, as that browser would report it. */
export const TABS_PER_BROWSER: Record<"brave" | "chrome" | "arc" | "edge", OsascriptResult> = {
  brave: lines("http://127.0.0.1:8957/", "https://example.com/", "chrome://newtab/"),
  chrome: lines("https://news.example.org/", "http://localhost:8957/captions"),
  arc: lines("http://[::1]:8957/", "https://example.com/a?b=c"),
  edge: lines("edge://settings/", "http://127.0.0.1:8957/#/live"),
};

export const NO_TABS: OsascriptResult = ok("\n");
export const NO_OUTPUT: OsascriptResult = ok("");

/** The text osascript writes when macOS refuses Automation access to the browser (error -1743). */
export const PERMISSION_DENIED = fail("14:62: execution error: Not authorized to send Apple events to Brave Browser. (-1743)\n");
export const CONSENT_UNAVAILABLE = fail("14:62: execution error: Brave Browser got an error: The user has declined permission. (-1744)\n");
export const APP_NOT_RUNNING = fail("execution error: Application isn’t running. (-600)\n");
export const SCRIPT_ERROR = fail("1:5: syntax error: Expected end of line but found identifier. (-2741)\n");
export const TIMED_OUT = fail("osascript timed out");
