import { describe, expect, it } from "vitest";
import { checkBrowserUrl } from "../../src/browser-url";

/**
 * F6, F7: the one gate in front of the default browser. A URL is either handed over exactly as it is (outer spaces
 * trimmed) or refused with the reason; nothing is ever added to it or rewritten.
 */

describe("accepted: the URL comes back unchanged", () => {
  const cases: Array<{ name: string; input: string; url: string }> = [
    { name: "the discovered port's page", input: "http://127.0.0.1:8957/", url: "http://127.0.0.1:8957/" },
    { name: "no trailing slash, as an override may be written", input: "http://127.0.0.1:8957", url: "http://127.0.0.1:8957" },
    { name: "an override with a path is kept", input: "http://127.0.0.1:4317/dashboard", url: "http://127.0.0.1:4317/dashboard" },
    { name: "an override with a query keeps its own query", input: "http://127.0.0.1:4317/d?tab=2", url: "http://127.0.0.1:4317/d?tab=2" },
    { name: "an override with a fragment keeps its own fragment", input: "http://127.0.0.1:4317/#live", url: "http://127.0.0.1:4317/#live" },
    { name: "localhost", input: "http://localhost:3000/", url: "http://localhost:3000/" },
    { name: "IPv6 loopback", input: "http://[::1]:3000/x", url: "http://[::1]:3000/x" },
    { name: "https on loopback", input: "https://127.0.0.1:8443/", url: "https://127.0.0.1:8443/" },
    { name: "outer spaces are trimmed, nothing else", input: "  http://127.0.0.1:8957/a  ", url: "http://127.0.0.1:8957/a" },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(checkBrowserUrl(c.input)).toEqual({ ok: true, url: c.url });
    });
  }

  it("never adds a query, a fragment, a proxy port or another host", () => {
    const out = checkBrowserUrl("http://127.0.0.1:8957/");
    expect(out.ok && out.url).toBe("http://127.0.0.1:8957/");
    expect(out.ok && /[?#]/.test(out.url)).toBe(false);
  });
});

describe("rejected before any browser open (F6)", () => {
  const cases: Array<{ name: string; input: string }> = [
    { name: "a LAN address", input: "http://192.168.1.20:8957/" },
    { name: "a public host", input: "https://example.com/" },
    { name: "0.0.0.0", input: "http://0.0.0.0:8957/" },
    { name: "a look-alike host", input: "http://127.0.0.1.evil.test:8957/" },
    { name: "credentials that hide the real host", input: "http://127.0.0.1@evil.test/" },
    { name: "credentials on a loopback host", input: "http://user:pw@127.0.0.1:8957/" },
    { name: "a file URL", input: "file:///etc/passwd" },
    { name: "a custom scheme", input: "obsidian://open?vault=x" },
    { name: "javascript:", input: "javascript:alert(1)" },
    { name: "not a URL at all", input: "127.0.0.1:8957" },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const out = checkBrowserUrl(c.input);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.problem).toBe("not-loopback");
        expect(out.message).not.toBe("");
      }
    });
  }
});

describe("no address yet", () => {
  for (const input of [null, undefined, "", "   "]) {
    it(`${JSON.stringify(input)} is "none", not a loopback problem`, () => {
      expect(checkBrowserUrl(input as never)).toEqual({ ok: false, problem: "none", message: "has no address to open yet" });
    });
  }
});
