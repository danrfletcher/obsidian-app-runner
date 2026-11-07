import { loopbackUrlError } from "./validation";

/** Why a URL was not handed to the browser: there is none yet, or it is not an http(s) loopback URL (F6). */
export type BrowserUrlProblem = "none" | "not-loopback";

export type BrowserUrlCheck = { ok: true; url: string } | { ok: false; problem: BrowserUrlProblem; message: string };

/**
 * G12, F6, F7: the one check before anything goes to the default browser. `instanceUrl` is the instance's current URL:
 * the project's URL override as written (a path is kept) when there is one, else the page on the port that was
 * discovered. It is returned unchanged (apart from stray outer spaces): no query, fragment, relay port or rewritten host
 * is ever added. Only http(s) on 127.0.0.1, localhost or [::1], without credentials, is accepted.
 */
export function checkBrowserUrl(instanceUrl: string | null | undefined): BrowserUrlCheck {
  const raw = instanceUrl?.trim() ?? "";
  if (raw === "") return { ok: false, problem: "none", message: "has no address to open yet" };
  const reason = loopbackUrlError(raw);
  if (reason !== null) return { ok: false, problem: "not-loopback", message: reason };
  return { ok: true, url: raw };
}
