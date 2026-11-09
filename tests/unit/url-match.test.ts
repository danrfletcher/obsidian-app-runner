import { describe, expect, it } from "vitest";
import { countMatchingTabs, tabMatchesPort } from "../../src/url-match";

/** G13: a browser tab belongs to the app when scheme, host and port all match; the path is ignored. */

const PORT = 8957;

describe("tabMatchesPort: every clause of the rule", () => {
  const rows: Array<[string, string, boolean]> = [
    // scheme: http or https only
    ["http", "http://127.0.0.1:8957/", true],
    ["https", "https://127.0.0.1:8957/", true],
    ["file", "file:///Users/dan/index.html", false],
    ["ftp", "ftp://127.0.0.1:8957/", false],
    ["ws", "ws://127.0.0.1:8957/", false],
    ["chrome internal page", "chrome://newtab/", false],
    ["view-source", "view-source:http://127.0.0.1:8957/", false],
    // host: the three loopback spellings
    ["127.0.0.1", "http://127.0.0.1:8957/", true],
    ["localhost", "http://localhost:8957/", true],
    ["[::1]", "http://[::1]:8957/", true],
    ["LOCALHOST in capitals", "http://LOCALHOST:8957/", true],
    ["another loopback address", "http://127.0.0.2:8957/", false],
    ["0.0.0.0", "http://0.0.0.0:8957/", false],
    ["a LAN address", "http://192.168.1.20:8957/", false],
    ["a public host", "https://example.com:8957/", false],
    ["a host that only starts with localhost", "http://localhost.example.com:8957/", false],
    ["localhost as a path", "http://example.com:8957/localhost", false],
    ["a user name that spells the host", "http://127.0.0.1:8957@evil.example/", false],
    // port: equality, with the scheme default when absent
    ["a different port", "http://127.0.0.1:8958/", false],
    ["a port that only starts the same", "http://127.0.0.1:89570/", false],
    ["no port on http (80)", "http://127.0.0.1/", false],
    ["no port on https (443)", "https://localhost/", false],
    // path, query and fragment are ignored
    ["a deep path", "http://127.0.0.1:8957/a/b/c", true],
    ["a query", "http://127.0.0.1:8957/?x=1&y=2", true],
    ["a fragment", "http://127.0.0.1:8957/#/live", true],
    ["no path at all", "http://127.0.0.1:8957", true],
    ["outer spaces", "  http://127.0.0.1:8957/  ", true],
    // not URLs
    ["empty", "", false],
    ["spaces", "   ", false],
    ["no scheme", "127.0.0.1:8957", false],
    ["garbage", "not a url", false],
    ["a half URL", "http://", false],
    ["a bad port", "http://127.0.0.1:abc/", false],
  ];
  it.each(rows)("%s", (_label, url, expected) => {
    expect(tabMatchesPort(url, PORT)).toBe(expected);
  });

  it("the default ports are matched when the instance is on 80 or 443", () => {
    expect(tabMatchesPort("http://localhost/", 80)).toBe(true);
    expect(tabMatchesPort("https://localhost/", 443)).toBe(true);
    expect(tabMatchesPort("http://localhost/", 443)).toBe(false);
    expect(tabMatchesPort("https://localhost:80/", 80)).toBe(true);
  });
});

describe("countMatchingTabs", () => {
  it("an empty list counts zero", () => {
    expect(countMatchingTabs([], PORT)).toBe(0);
  });

  it("counts every matching tab, two tabs on one page as two, and nothing else", () => {
    expect(
      countMatchingTabs(
        ["http://127.0.0.1:8957/", "http://localhost:8957/other", "http://127.0.0.1:4317/", "https://example.com/", "file:///x", "chrome://newtab/", "", "junk"],
        PORT,
      ),
    ).toBe(2);
    expect(countMatchingTabs(["http://127.0.0.1:8957/", "http://127.0.0.1:8957/"], PORT)).toBe(2);
  });

  it("only tabs of other apps or other schemes: zero", () => {
    expect(countMatchingTabs(["http://127.0.0.1:4317/", "file:///x", "http://192.168.1.2:8957/"], PORT)).toBe(0);
  });
});
