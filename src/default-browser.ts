/**
 * F15: the browsers whose tabs can be read, keyed by bundle id (lower case: macOS bundle ids are case-insensitive).
 * `appName` is the name AppleScript addresses the app by; it is the only text ever placed in a script (browser-script.ts),
 * and it comes from this table, never from user or page input.
 */
export const SUPPORTED_BROWSERS = {
  brave: { id: "brave", bundleId: "com.brave.Browser", appName: "Brave Browser" },
  chrome: { id: "chrome", bundleId: "com.google.Chrome", appName: "Google Chrome" },
  arc: { id: "arc", bundleId: "company.thebrowser.Browser", appName: "Arc" },
  edge: { id: "edge", bundleId: "com.microsoft.edgemac", appName: "Microsoft Edge" },
} as const;

export type SupportedBrowserId = keyof typeof SUPPORTED_BROWSERS;
export type SupportedBrowser = (typeof SUPPORTED_BROWSERS)[SupportedBrowserId];

/** What macOS uses when no handler has been chosen for http. */
export const FALLBACK_BROWSER_BUNDLE_ID = "com.apple.Safari";

export type BrowserClass = { supported: true; browser: SupportedBrowser } | { supported: false; bundleId: string };

/** G13: the default browser's bundle id as a supported browser, or as unsupported. Safari, Firefox, Orion and anything unknown are unsupported. */
export function classifyBrowser(bundleId: string): BrowserClass {
  const wanted = bundleId.trim().toLowerCase();
  for (const browser of Object.values(SUPPORTED_BROWSERS)) {
    if (browser.bundleId.toLowerCase() === wanted) return { supported: true, browser };
  }
  return { supported: false, bundleId: bundleId.trim() };
}

/**
 * The bundle id handling http in the JSON form of `com.apple.launchservices.secure.plist`. When no entry names a handler
 * for http (or https) macOS is using Safari. Throws when the text is not the expected JSON, so the caller treats it as
 * an unreadable browser, not as Safari.
 */
export function parseDefaultBrowserBundleId(plistJson: string): string {
  const data: unknown = JSON.parse(plistJson);
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("the default browser setting was not in the expected shape");
  const handlers = (data as { LSHandlers?: unknown }).LSHandlers;
  if (handlers === undefined) return FALLBACK_BROWSER_BUNDLE_ID;
  if (!Array.isArray(handlers)) throw new Error("the default browser setting was not in the expected shape");
  // The web link handler: the entry for the http scheme, or failing that the https one (macOS sets both together).
  const webSchemes = ["^http$", "^https$"].map((p) => new RegExp(p, "i"));
  for (const scheme of webSchemes) {
    for (const h of handlers) {
      if (typeof h !== "object" || h === null) continue;
      const entry = h as { LSHandlerURLScheme?: unknown; LSHandlerRoleAll?: unknown; LSHandlerRoleViewer?: unknown };
      if (typeof entry.LSHandlerURLScheme !== "string" || !scheme.test(entry.LSHandlerURLScheme)) continue;
      const id = [entry.LSHandlerRoleAll, entry.LSHandlerRoleViewer].find((v) => typeof v === "string" && v.trim() !== "");
      if (typeof id === "string") return id.trim();
    }
  }
  return FALLBACK_BROWSER_BUNDLE_ID;
}
