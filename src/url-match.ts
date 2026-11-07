/** The hosts a browser tab can be on and still be this machine's own app (F6). `URL.hostname` keeps the brackets on an IPv6 host. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * G13: does one browser tab URL belong to the instance listening on `port`? True when the scheme is http or https, the
 * host is 127.0.0.1, localhost or [::1], and the port equals `port` (an absent port is 80 for http and 443 for https).
 * The path, query and fragment are ignored. Anything that does not parse as a URL does not match.
 */
export function tabMatchesPort(rawUrl: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  const tabPort = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return tabPort === port;
}

/** How many of the tab URLs belong to the instance on `port`. Two tabs on the same page count as two. */
export function countMatchingTabs(urls: readonly string[], port: number): number {
  return urls.filter((u) => tabMatchesPort(u, port)).length;
}
