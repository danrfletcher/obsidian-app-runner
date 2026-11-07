import { describe, expect, it } from "vitest";
import { classifyOsascriptFailure, osascriptArgs, parseTabUrls, tabUrlsScript } from "../../src/browser-script";
import { SUPPORTED_BROWSERS, type SupportedBrowserId } from "../../src/default-browser";
import { APP_NOT_RUNNING, CONSENT_UNAVAILABLE, PERMISSION_DENIED, SCRIPT_ERROR, TIMED_OUT } from "../fixtures/osascript-output";

/** F15: the AppleScript is one fixed template per supported browser; only the allow-listed app name is put in it. */

const ids = Object.keys(SUPPORTED_BROWSERS) as SupportedBrowserId[];

describe("tabUrlsScript", () => {
  it.each(ids)("%s: the script names that browser's app and nothing else", (id) => {
    const text = tabUrlsScript(id).join("\n");
    const app = SUPPORTED_BROWSERS[id].appName;
    expect(text.match(/application "([^"]*)"/g)).toEqual([`application "${app}"`, `application "${app}"`]);
    expect(text).toContain(`if application "${app}" is running then`);
  });

  it("the scripts differ only by the app name", () => {
    const strip = (id: SupportedBrowserId) => tabUrlsScript(id).join("\n").split(SUPPORTED_BROWSERS[id].appName).join("<APP>");
    const [first, ...rest] = ids.map(strip);
    for (const other of rest) expect(other).toBe(first);
  });

  it("the whole template, written out", () => {
    expect(tabUrlsScript("chrome")).toEqual([
      'set tabUrls to ""',
      'if application "Google Chrome" is running then',
      'tell application "Google Chrome"',
      "repeat with w in windows",
      "repeat with t in tabs of w",
      "set tabUrls to tabUrls & (URL of t) & linefeed",
      "end repeat",
      "end repeat",
      "end tell",
      "end if",
      "return tabUrls",
    ]);
  });

  it("only reads: no activate, launch, open, quit, close, make or set on the browser", () => {
    for (const id of ids) expect(tabUrlsScript(id).join("\n")).not.toMatch(/\b(activate|launch|open location|quit|close|make|reopen|delete|execute|do shell script)\b/);
  });

  it("anything that is not an allow-listed id is refused, whatever text it carries", () => {
    for (const bad of ["safari", "firefox", "orion", "", 'brave" & (do shell script "x") & "', "__proto__", "constructor", "toString"]) {
      expect(() => tabUrlsScript(bad as SupportedBrowserId)).toThrow(/not a supported browser/);
    }
  });
});

describe("osascriptArgs", () => {
  it("is -e before each line, in order", () => {
    expect(osascriptArgs(["a", "b"])).toEqual(["-e", "a", "-e", "b"]);
  });
});

describe("parseTabUrls", () => {
  it("one URL per line, blank lines and outer spaces dropped", () => {
    expect(parseTabUrls("http://a/\r\n  http://b/  \n\n")).toEqual(["http://a/", "http://b/"]);
  });
  it("empty output is no tabs", () => {
    expect(parseTabUrls("")).toEqual([]);
    expect(parseTabUrls("\n")).toEqual([]);
  });
  it("a URL with commas in it stays one tab", () => {
    expect(parseTabUrls("http://127.0.0.1:8957/?a=1,2,3\n")).toEqual(["http://127.0.0.1:8957/?a=1,2,3"]);
  });
});

describe("classifyOsascriptFailure", () => {
  it("a refused Automation permission is denied, whichever error osascript reports", () => {
    expect(classifyOsascriptFailure(PERMISSION_DENIED.stderr)).toEqual({ kind: "denied" });
    expect(classifyOsascriptFailure(CONSENT_UNAVAILABLE.stderr)).toEqual({ kind: "denied" });
    expect(classifyOsascriptFailure("Not authorised to send Apple events to Arc.")).toEqual({ kind: "denied" });
  });
  it("the app quitting in between is not running, not an error", () => {
    expect(classifyOsascriptFailure(APP_NOT_RUNNING.stderr)).toEqual({ kind: "not-running" });
  });
  it("anything else is an error carrying its first line, cut to a sensible length", () => {
    expect(classifyOsascriptFailure(SCRIPT_ERROR.stderr)).toEqual({ kind: "error", message: SCRIPT_ERROR.stderr.trim() });
    expect(classifyOsascriptFailure(TIMED_OUT.stderr)).toEqual({ kind: "error", message: "osascript timed out" });
    expect(classifyOsascriptFailure("")).toEqual({ kind: "error", message: "osascript failed" });
    const long = classifyOsascriptFailure("x".repeat(5000));
    expect(long.kind === "error" && long.message.length).toBe(200);
  });
});
