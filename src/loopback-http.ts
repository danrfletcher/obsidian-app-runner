import * as http from "node:http";
import * as https from "node:https";
import { isLoopbackUrl } from "./validation";

/** The part of a fetch Response the ready wait reads. */
export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
}

/** Fetch-shaped, so tests can fake it. */
export type HttpGet = (url: string, init: { signal: AbortSignal }) => Promise<HttpResponseLike>;

/**
 * `GET <url>` over loopback and nothing else (F6, F8): a URL that is not http(s) on 127.0.0.1, localhost or [::1] is
 * refused before any socket opens. Resolves as soon as the response headers arrive (any status counts as an answer; the
 * body is never read). Redirects are not followed, so a loopback app cannot send the probe anywhere else.
 *
 * Node's http is used rather than `fetch` because the Obsidian window's origin is not the app's: a cross-origin
 * `fetch` would be blocked by CORS even though the app answered.
 */
export const loopbackGet: HttpGet = (rawUrl, { signal }) =>
  new Promise((resolve, reject) => {
    if (!isLoopbackUrl(rawUrl)) return reject(new Error("Refusing to request a URL that is not on loopback."));
    if (signal.aborted) return reject(new Error("aborted"));
    const url = new URL(rawUrl);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        headers: { Accept: "text/html,*/*;q=0.8" },
        // A local https app usually has a self-signed certificate; the host is loopback, so nothing is exposed.
        ...(url.protocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        signal.removeEventListener("abort", onAbort);
        const headers = res.headers;
        res.destroy();
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            get: (name) => {
              const v = headers[name.toLowerCase()];
              return Array.isArray(v) ? v.join(", ") : (v ?? null);
            },
          },
        });
      },
    );
    const onAbort = () => req.destroy(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e) => {
      signal.removeEventListener("abort", onAbort);
      reject(e);
    });
    req.end();
  });
