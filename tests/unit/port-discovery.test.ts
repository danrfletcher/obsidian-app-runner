import { describe, expect, it } from "vitest";
import { choosePort, classifyBind, loopbackCandidates, parseLsof } from "../../src/port-discovery";

/** Captured from `lsof -nP -a -iTCP -sTCP:LISTEN -p <pid>` on macOS 26: IPv6 dual-stack wildcard, IPv4 loopback, IPv6 loopback, IPv4 wildcard. */
const LSOF_FIXTURE = `COMMAND  PID        USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    5927 danfletcher   12u  IPv6  0x3e8563f3de0d68e      0t0  TCP *:59081 (LISTEN)
node    5927 danfletcher   13u  IPv4 0x91f64b4d8735f5f0      0t0  TCP 127.0.0.1:59082 (LISTEN)
node    5927 danfletcher   14u  IPv6 0xc88e599d8973da5c      0t0  TCP [::1]:59083 (LISTEN)
node    5927 danfletcher   15u  IPv4 0xe717764be688a395      0t0  TCP *:59084 (LISTEN)
`;

describe("parseLsof", () => {
  it("reads pid, bind address and port from real lsof output, skipping the header", () => {
    expect(parseLsof(LSOF_FIXTURE)).toEqual([
      { pid: 5927, address: "*", port: 59081 },
      { pid: 5927, address: "127.0.0.1", port: 59082 },
      { pid: 5927, address: "[::1]", port: 59083 },
      { pid: 5927, address: "*", port: 59084 },
    ]);
  });

  it("reads a LAN address, an IPv6 wildcard and several pids", () => {
    const text = [
      "node 11 dan 3u IPv4 0x1 0t0 TCP 192.168.1.20:3000 (LISTEN)",
      "node 12 dan 4u IPv6 0x2 0t0 TCP [::]:3001 (LISTEN)",
      "python 13 dan 5u IPv4 0x3 0t0 TCP 127.0.0.1:3002 (LISTEN)",
    ].join("\n");
    expect(parseLsof(text).map((l) => [l.pid, l.address, l.port])).toEqual([
      [11, "192.168.1.20", 3000],
      [12, "[::]", 3001],
      [13, "127.0.0.1", 3002],
    ]);
  });

  it.each([
    ["empty", ""],
    ["header only", "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n"],
    ["an established connection", "node 1 dan 3u IPv4 0x1 0t0 TCP 127.0.0.1:50000->127.0.0.1:8957 (ESTABLISHED)"],
    ["a UDP socket", "mDNSRespo 1 root 3u IPv4 0x1 0t0 UDP *:5353"],
    ["garbage", "lsof: WARNING: can't stat() fuse file system"],
    ["an out-of-range port", "node 1 dan 3u IPv4 0x1 0t0 TCP 127.0.0.1:99999 (LISTEN)"],
  ])("gives nothing for %s", (_label, text) => {
    expect(parseLsof(text)).toEqual([]);
  });
});

describe("bind classification (F6)", () => {
  it.each([
    ["127.0.0.1", "loopback4"],
    ["[::1]", "loopback6"],
    ["*", "wildcard"],
    ["[::]", "wildcard"],
    ["192.168.1.20", "other"],
    ["10.0.0.5", "other"],
    ["127.0.0.2", "other"],
    ["[fe80::1]", "other"],
    ["0.0.0.0", "other"],
  ])("%s is %s", (address, kind) => {
    expect(classifyBind(address)).toBe(kind);
  });
});

describe("loopbackCandidates", () => {
  const l = (address: string, port: number, pid = 1) => ({ pid, address, port });

  it("keeps IPv4 loopback, IPv6 loopback and wildcard, and drops a non-loopback-only listener", () => {
    const out = loopbackCandidates([l("127.0.0.1", 3000), l("[::1]", 3001), l("*", 3002), l("192.168.1.20", 3003)]);
    expect(out).toEqual([
      { port: 3000, host: "127.0.0.1" },
      { port: 3001, host: "[::1]" },
      { port: 3002, host: "127.0.0.1" },
    ]);
  });

  it("a port seen on both IPv6 loopback and IPv4 is reached over IPv4; no duplicates", () => {
    expect(loopbackCandidates([l("[::1]", 4000), l("127.0.0.1", 4000), l("*", 4000)])).toEqual([{ port: 4000, host: "127.0.0.1" }]);
  });

  it("is ordered lowest port first and empty for no listeners", () => {
    expect(loopbackCandidates([l("*", 9000), l("*", 80), l("*", 8000)]).map((c) => c.port)).toEqual([80, 8000, 9000]);
    expect(loopbackCandidates([])).toEqual([]);
  });

  it("works on the real fixture: all four listeners are reachable over loopback", () => {
    expect(loopbackCandidates(parseLsof(LSOF_FIXTURE)).map((c) => [c.port, c.host])).toEqual([
      [59081, "127.0.0.1"],
      [59082, "127.0.0.1"],
      [59083, "[::1]"],
      [59084, "127.0.0.1"],
    ]);
  });
});

describe("choosePort (E3)", () => {
  it("nothing answered: none", () => {
    expect(choosePort([])).toEqual({ kind: "none" });
  });

  it("one answering port is taken, HTML or not", () => {
    expect(choosePort([{ port: 3000, html: true }])).toEqual({ kind: "port", port: 3000 });
    expect(choosePort([{ port: 3000, html: false }])).toEqual({ kind: "port", port: 3000 });
  });

  it("prefers the one port that answers HTML over a lower non-HTML port", () => {
    expect(choosePort([{ port: 3000, html: false }, { port: 8957, html: true }])).toEqual({ kind: "port", port: 8957 });
  });

  it("more than one HTML port needs the picker, lowest first", () => {
    expect(choosePort([{ port: 9000, html: true }, { port: 3000, html: true }, { port: 5000, html: false }])).toEqual({
      kind: "picker",
      ports: [3000, 9000],
    });
  });

  it("no HTML port: the lowest answering port", () => {
    expect(choosePort([{ port: 9000, html: false }, { port: 4000, html: false }, { port: 6000, html: false }])).toEqual({ kind: "port", port: 4000 });
  });
});
