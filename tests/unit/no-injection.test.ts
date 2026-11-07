import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The F7, F8 and F1 source scans for this PR. They read the files in src/ as text (comments included, so a comment
 * cannot hide a token either), and a first test proves the scan can find a token that is there.
 */

const root = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.(ts|tsx|js|mjs|cjs)$/.test(p) ? [p] : [];
  });
}

const sources = sourceFiles(path.join(root, "src")).map((file) => ({ file: path.relative(root, file), text: fs.readFileSync(file, "utf8") }));

const where = (pattern: RegExp) => sources.filter((s) => pattern.test(s.text)).map((s) => s.file);

describe("the scan can fail", () => {
  it("finds tokens that are there", () => {
    expect(where(/openExternal/)).toContain("src/main.ts");
    expect(where(/checkBrowserUrl/)).toContain("src/instance.ts");
  });
  it("covers every source file", () => {
    expect(sources.length).toBeGreaterThan(15);
    expect(sources.map((s) => s.file)).toContain("src/browser-url.ts");
  });
});

describe("F7 the browser gets a plain loopback URL: nothing is injected, hooked or proxied", () => {
  const forbidden = [
    "executeJavaScript",
    "insertCSS",
    "preload",
    "webRequest",
    "onBeforeRequest",
    "onBeforeSendHeaders",
    "setProxy",
    "createServer",
    "createProxyServer",
    "http-proxy",
    "proxy",
    "injectJavaScript",
    "addInitScript",
    "evaluateJavaScript",
  ];
  it.each(forbidden)("%s appears nowhere in src/", (token) => {
    expect(where(new RegExp(token, "i"))).toEqual([]);
  });

  it("only the existing loopback probe imports node:http or node:net, and it has no server", () => {
    expect(where(/from\s+["'](?:node:)?(?:http|https|net|http2|tls)["']/)).toEqual(["src/loopback-http.ts"]);
    expect(where(/require\(\s*["'](?:node:)?(?:http|https|net|http2|tls)["']\s*\)/)).toEqual([]);
  });

  it("the URL given to the browser is built from the instance URL alone: no URL is constructed or edited in the hand-off", () => {
    const url = sources.find((s) => s.file === "src/browser-url.ts")!.text;
    expect(url).not.toMatch(/new URL|searchParams|\.hash\s*=|\.search\s*=|\.host\s*=|\.hostname\s*=|\.port\s*=|\.pathname\s*=/);
    const instance = sources.find((s) => s.file === "src/instance.ts")!.text;
    expect(instance).toMatch(/this\.deps\.openExternal\(checked\.url\)/);
  });
});

describe("F6 and F8 the only external action is the browser open, on a checked loopback URL", () => {
  it("the hand-off checks the URL before the opener, in that order", () => {
    const instance = sources.find((s) => s.file === "src/instance.ts")!.text;
    const check = instance.indexOf("checkBrowserUrl(url)");
    const open = instance.indexOf("this.deps.openExternal(");
    expect(check).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(check);
    expect(instance.match(/this\.deps\.openExternal\(/g)).toHaveLength(1);
  });

  it("the tab's own fallback opens only a URL that passed isLoopbackUrl", () => {
    const view = sources.find((s) => s.file === "src/webview-view.ts")!.text;
    expect(view.match(/host\.openExternal\(/g)).toHaveLength(1);
    expect(view).toMatch(/isLoopbackUrl\(url\)\) return url;/);
  });

  it("osascript is run from one module, and AppleScript text lives in one other (F15)", () => {
    expect(where(/const OSASCRIPT = |NSAppleScript/)).toEqual(["src/browser-system.ts"]);
    expect(where(/tell application/)).toEqual(["src/browser-script.ts"]);
    expect(where(/execFile\(OSASCRIPT/)).toEqual(["src/browser-system.ts"]);
  });

  it("the OS open is reached from main.ts only, and only through the one openExternal function", () => {
    expect(where(/shell\.openExternal|window\.open\(/)).toEqual(["src/main.ts"]);
    const main = sources.find((s) => s.file === "src/main.ts")!.text;
    expect(main.match(/shell\.openExternal\(/g)).toHaveLength(1);
    expect(main.match(/window\.open\(/g)).toHaveLength(1);
  });
});

describe("F1 no ribbon icon, status bar item, default hotkey or URI handler", () => {
  it.each(["addRibbonIcon", "addStatusBarItem", "registerObsidianProtocolHandler", "hotkeys"])("%s appears nowhere in src/", (token) => {
    expect(where(new RegExp(token))).toEqual([]);
  });

  it("the Pop out command is a plain command with no hotkey", () => {
    const commands = sources.find((s) => s.file === "src/commands.ts")!.text;
    expect(commands).toMatch(/id: POP_OUT_COMMAND_ID, name: POP_OUT_COMMAND_NAME, callback/);
  });
});

describe("no new dependency", () => {
  it("package.json has the same dependency lists as before this PR", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});
