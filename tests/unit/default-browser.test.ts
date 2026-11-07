import { describe, expect, it } from "vitest";
import { classifyBrowser, FALLBACK_BROWSER_BUNDLE_ID, parseDefaultBrowserBundleId, SUPPORTED_BROWSERS } from "../../src/default-browser";

/** G13, F15: the default browser, by bundle id, is supported (Brave, Chrome, Arc, Edge) or it is not. */

describe("classifyBrowser: the Chromium family is supported", () => {
  it.each([
    ["Brave", "com.brave.Browser", "Brave Browser"],
    ["Chrome", "com.google.Chrome", "Google Chrome"],
    ["Arc", "company.thebrowser.Browser", "Arc"],
    ["Edge", "com.microsoft.edgemac", "Microsoft Edge"],
  ])("%s", (_name, bundleId, appName) => {
    const c = classifyBrowser(bundleId);
    expect(c.supported).toBe(true);
    if (c.supported) expect(c.browser.appName).toBe(appName);
  });

  it("macOS writes bundle ids in lower case in its preferences: still supported", () => {
    expect(classifyBrowser("com.brave.browser").supported).toBe(true);
    expect(classifyBrowser("COM.GOOGLE.CHROME").supported).toBe(true);
    expect(classifyBrowser("  com.microsoft.edgemac \n").supported).toBe(true);
  });

  it("the allow-list is exactly those four", () => {
    expect(Object.values(SUPPORTED_BROWSERS).map((b) => b.bundleId)).toEqual(["com.brave.Browser", "com.google.Chrome", "company.thebrowser.Browser", "com.microsoft.edgemac"]);
  });
});

describe("classifyBrowser: everything else is unsupported", () => {
  it.each([
    ["Safari", "com.apple.Safari"],
    ["Safari Technology Preview", "com.apple.SafariTechnologyPreview"],
    ["Firefox", "org.mozilla.firefox"],
    ["Orion", "com.kagi.kagimacOS"],
    ["Opera", "com.operasoftware.Opera"],
    ["Vivaldi", "com.vivaldi.Vivaldi"],
    ["Chromium", "org.chromium.Chromium"],
    ["Brave Beta", "com.brave.Browser.beta"],
    ["Chrome Canary", "com.google.Chrome.canary"],
    ["unknown", "com.example.whatever"],
    ["empty", ""],
    ["a prefix of a supported id", "com.brave"],
    ["a supported id with a suffix", "com.google.Chrome.evil"],
  ])("%s", (_name, bundleId) => {
    expect(classifyBrowser(bundleId)).toEqual({ supported: false, bundleId });
  });
});

describe("parseDefaultBrowserBundleId", () => {
  const handlers = (...h: object[]) => JSON.stringify({ LSHandlers: h });

  it("reads the handler of the http scheme", () => {
    expect(parseDefaultBrowserBundleId(handlers({ LSHandlerURLScheme: "http", LSHandlerRoleAll: "com.brave.browser" }))).toBe("com.brave.browser");
  });

  it("uses the https handler when there is no http one", () => {
    expect(parseDefaultBrowserBundleId(handlers({ LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.google.chrome" }))).toBe("com.google.chrome");
  });

  it("prefers http, ignores other schemes, and falls back to the viewer role", () => {
    expect(
      parseDefaultBrowserBundleId(
        handlers(
          { LSHandlerURLScheme: "mailto", LSHandlerRoleAll: "com.apple.mail" },
          { LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.google.chrome" },
          { LSHandlerURLScheme: "http", LSHandlerRoleViewer: "company.thebrowser.browser" },
        ),
      ),
    ).toBe("company.thebrowser.browser");
  });

  it("no handler chosen means Safari, which is unsupported", () => {
    expect(parseDefaultBrowserBundleId(handlers({ LSHandlerURLScheme: "mailto", LSHandlerRoleAll: "com.apple.mail" }))).toBe(FALLBACK_BROWSER_BUNDLE_ID);
    expect(parseDefaultBrowserBundleId("{}")).toBe(FALLBACK_BROWSER_BUNDLE_ID);
    expect(classifyBrowser(parseDefaultBrowserBundleId("{}")).supported).toBe(false);
  });

  it("text that is not the expected JSON throws, so the caller reports an unreadable browser instead of guessing Safari", () => {
    expect(() => parseDefaultBrowserBundleId("not json")).toThrow();
    expect(() => parseDefaultBrowserBundleId("null")).toThrow();
    expect(() => parseDefaultBrowserBundleId("[]")).toThrow();
  });
});
