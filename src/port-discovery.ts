import { execFile } from "node:child_process";

export interface Listener {
  pid: number;
  /** The address as lsof printed it: `127.0.0.1`, `[::1]`, `*`, `[::]` or another address. */
  address: string;
  port: number;
}

/**
 * Parse `lsof -nP -a -iTCP -sTCP:LISTEN -p <pids>` output. Lines that are not a LISTEN socket (the header, blanks,
 * anything unexpected) are skipped.
 */
export function parseLsof(output: string): Listener[] {
  const out: Listener[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\S+\s+(\d+)\s.*\sTCP\s+(\[[^\]]*\]|[^\s:]+):(\d+)\s+\(LISTEN\)\s*$/.exec(line);
    if (!m) continue;
    const port = Number(m[3]);
    if (port < 1 || port > 65535) continue;
    out.push({ pid: Number(m[1]), address: m[2], port });
  }
  return out;
}

export type BindKind = "loopback4" | "loopback6" | "wildcard" | "other";

/**
 * How a listener's bind address relates to loopback. `127.0.0.1` and `[::1]` are loopback. `*` and `[::]` listen on
 * every interface, loopback included, so 127.0.0.1 reaches them. Any other address (a LAN address, another 127.x
 * address) is not loopback: nothing on it is probed or opened (F6).
 */
export function classifyBind(address: string): BindKind {
  if (address === "127.0.0.1") return "loopback4";
  if (address === "[::1]") return "loopback6";
  if (address === "*" || address === "[::]") return "wildcard";
  return "other";
}

export interface Candidate {
  port: number;
  /** The host to probe and show: 127.0.0.1, or [::1] when the app listens on IPv6 loopback only. */
  host: "127.0.0.1" | "[::1]";
}

/** The ports an app may be reached on over loopback, one per port, lowest port first. Non-loopback-only listeners are dropped. */
export function loopbackCandidates(listeners: readonly Listener[]): Candidate[] {
  const byPort = new Map<number, Candidate>();
  for (const l of listeners) {
    const kind = classifyBind(l.address);
    if (kind === "other") continue;
    if (kind === "loopback6") {
      if (!byPort.has(l.port)) byPort.set(l.port, { port: l.port, host: "[::1]" });
    } else {
      byPort.set(l.port, { port: l.port, host: "127.0.0.1" }); // IPv4 loopback wins over IPv6 for the same port
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export interface Answer {
  port: number;
  /** The `GET /` response was HTML (a Content-Type of text/html or application/xhtml+xml). */
  html: boolean;
}

export type PortChoice = { kind: "port"; port: number } | { kind: "picker"; ports: number[] } | { kind: "none" };

/**
 * E3. Among the ports that answered: one that serves HTML wins; more than one HTML port needs the picker; with no HTML
 * port the lowest answering port is taken.
 */
export function choosePort(answers: readonly Answer[]): PortChoice {
  if (answers.length === 0) return { kind: "none" };
  const html = answers.filter((a) => a.html).map((a) => a.port).sort((a, b) => a - b);
  if (html.length === 1) return { kind: "port", port: html[0] };
  if (html.length > 1) return { kind: "picker", ports: html };
  return { kind: "port", port: Math.min(...answers.map((a) => a.port)) };
}

/** Runs lsof for the given pids and returns its text. lsof exits 1 when it finds nothing; that is an empty answer, not an error. */
export type LsofRunner = (pids: readonly number[]) => Promise<string>;

export const LSOF_ARGS = ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p"];

export const realLsof: LsofRunner = (pids) =>
  new Promise((resolve, reject) => {
    if (pids.length === 0) return resolve("");
    execFile("lsof", [...LSOF_ARGS, pids.join(",")], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (err && code !== 1) reject(err);
      else resolve(stdout ?? "");
    });
  });
