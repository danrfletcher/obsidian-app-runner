import * as fs from "node:fs";
import * as path from "node:path";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs shared with the real build, no types
import { buildOptions } from "../../build-options.mjs";
import { FORM_FIELDS, type Project } from "../../src/project";
import { SettingsStore } from "../../src/settings-store";
import { fakeFs, input, memoryPersistence } from "../helpers";

const root = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Modules that may talk to the network. Empty in this PR: a loopback probe arrives with PR-2. */
const NETWORK_ALLOW_LIST: string[] = [];

const sources = sourceFiles(path.join(root, "src")).map((file) => ({ file: path.relative(root, file), text: fs.readFileSync(file, "utf8") }));
let bundle = "";

beforeAll(async () => {
  // The same options as `npm run build`, kept in memory so the check does not depend on a build having run first.
  const result = await build({ ...buildOptions({ production: true }), write: false, logLevel: "silent" });
  bundle = (result.outputFiles ?? []).map((f: { text: string }) => f.text).join("\n");
  expect(bundle.length).toBeGreaterThan(1000);
});

/** Run `pattern` over every source file and the bundle; returns where it was found. */
function hits(pattern: RegExp, skip: string[] = []): string[] {
  const found = sources.filter((s) => !skip.includes(s.file) && pattern.test(s.text)).map((s) => s.file);
  if (pattern.test(bundle)) found.push("main.js (bundle)");
  return found;
}

describe("sanity: the checks can fail", () => {
  it("finds a token that is there", () => {
    expect(hits(/registerView/)).toContain("src/main.ts");
    expect(hits(/registerView/)).toContain("main.js (bundle)");
  });
});

describe("F1 commands only", () => {
  it.each(["addRibbonIcon", "addStatusBarItem", "registerObsidianProtocolHandler", "hotkeys"])("%s appears nowhere", (token) => {
    expect(hits(new RegExp(token))).toEqual([]);
  });
});

describe("F2 desktop and macOS only", () => {
  it("the manifest is desktop only", () => {
    expect(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).isDesktopOnly).toBe(true);
  });
  it("onload gates on desktop and macOS before registering anything", () => {
    const main = sources.find((s) => s.file === "src/main.ts")!.text;
    const gate = main.indexOf("Platform.isMacOS");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(main.indexOf("registerView("));
    expect(gate).toBeLessThan(main.indexOf("addSettingTab("));
  });
});

describe("F8 no telemetry, no network apart from loopback and the browser", () => {
  it.each([
    ["fetch()", /\bfetch\s*\(/],
    ["XMLHttpRequest", /XMLHttpRequest/],
    ["WebSocket", /WebSocket/],
    ["an http/https/net/dgram/tls import", /(?:from\s*|require\s*\(\s*)["'](?:node:)?(?:https?|net|dgram|tls|http2)["']/],
    ["requestUrl", /requestUrl/],
    ["sendBeacon", /sendBeacon/],
  ])("%s appears outside the allow-listed loopback module", (_label, pattern) => {
    expect(hits(pattern, NETWORK_ALLOW_LIST)).toEqual([]);
  });

  it("the allow-list is empty and no such module exists yet", () => {
    expect(NETWORK_ALLOW_LIST).toEqual([]);
    expect(sources.map((s) => s.file).filter((f) => /probe/i.test(f))).toEqual([]);
  });

  it("the only place a webview src is set is guarded by the loopback check", () => {
    const setters = sources.filter((s) => /setAttribute\(\s*["']src["']/.test(s.text));
    expect(setters.map((s) => s.file)).toEqual(["src/webview-view.ts"]);
    expect(setters[0].text).toMatch(/webviewUrl\(project\)/);
    expect(sources.find((s) => s.file === "src/webview-view.ts")!.text).toMatch(/isLoopbackUrl\(url\)/);
    expect(hits(/\.src\s*=/)).toEqual([]);
    expect(hits(/iframe/i, ["src/webview-view.ts"])).toEqual([]);
  });
});

describe("F9 one start command per project", () => {
  it("a stored project has exactly the known fields, no env, Docker or extra-command field", async () => {
    const store = new SettingsStore(memoryPersistence(), { fs: fakeFs() });
    await store.load();
    const r = await store.add(input());
    if (!r.ok) throw new Error("add failed");
    const keys = Object.keys(r.project as Project).sort();
    expect(keys).toEqual(["command", "folder", "killOnClose", "name", "openInBrowser", "slug", "urlOverride"]);
    expect(keys.filter((k) => /env|docker|args|commands|script/i.test(k))).toEqual([]);
  });

  it("the form has exactly one command field", () => {
    expect([...FORM_FIELDS]).toEqual(["name", "folder", "command", "urlOverride", "killOnClose", "openInBrowser"]);
    expect(FORM_FIELDS.filter((f) => /command/i.test(f))).toEqual(["command"]);
  });
});

describe("F12 no native modules, no dependency on another plugin", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  it("package.json has no runtime dependencies and no native dev dependency", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(all.filter((n) => /node-pty|node-gyp|bindings|ffi|sqlite3|better-sqlite|fsevents|commander|prebuild|napi|nan$/i.test(n))).toEqual([]);
    expect(pkg.gypfile).toBeUndefined();
    expect(fs.existsSync(path.join(root, "binding.gyp"))).toBe(false);
  });

  it("the bundle requires no .node file", () => {
    expect(bundle).not.toMatch(/require\s*\(\s*["'][^"']*\.node["']\s*\)/);
    expect(bundle).not.toMatch(/\.node["']\s*\)/);
    expect(bundle).not.toMatch(/process\.dlopen/);
    expect(sources.filter((s) => /\.node["']/.test(s.text)).map((s) => s.file)).toEqual([]);
  });

  it("no code reads another plugin or depends on Commander", () => {
    expect(hits(/plugins\.plugins/)).toEqual([]);
    expect(hits(/getPlugin\s*\(/)).toEqual([]);
    expect(hits(/commander/i)).toEqual([]);
  });
});
