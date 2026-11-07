import type { Clock } from "./clock";
import type { HttpGet } from "./loopback-http";
import { choosePort, loopbackCandidates, type Answer, type Listener } from "./port-discovery";

export const READY_TIMEOUT_MS = 60_000;
export const PROBE_TIMEOUT_MS = 2000;
export const RETRY_MS = 1000;

export interface ProbeResult {
  html: boolean;
}

/**
 * 'Answers HTTP' (E3): any response, of any status, to `GET <url>` within `timeoutMs`. null when nothing answered
 * (refused, reset, or no answer in time).
 */
export async function probe(url: string, deps: { httpGet: HttpGet; clock: Clock; timeoutMs?: number }): Promise<ProbeResult | null> {
  const controller = new AbortController();
  const timedOut = Symbol("timeout");
  const request = deps.httpGet(url, { signal: controller.signal }).then(
    (res) => ({ res }),
    () => null,
  );
  const outcome = await Promise.race([request, deps.clock.sleep(deps.timeoutMs ?? PROBE_TIMEOUT_MS).then(() => timedOut)]);
  if (outcome === timedOut) {
    controller.abort();
    return null;
  }
  if (outcome === null) return null;
  const type = (outcome as { res: { headers: { get(n: string): string | null } } }).res.headers.get("content-type") ?? "";
  return { html: /\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(type) };
}

export type ReadyResult =
  | { kind: "ready"; port: number; url: string; picked: boolean }
  | { kind: "exited" }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export interface ReadyWaitOptions {
  clock: Clock;
  /** `GET` over loopback; fetch-shaped. */
  httpGet: HttpGet;
  /** The pids of the processes now in the app's group. Empty means every process in the group has exited. */
  members(): Promise<number[]>;
  /** lsof for those pids. */
  listeners(pids: number[]): Promise<Listener[]>;
  /**
   * A validated loopback URL that replaces port discovery (G1). Its port must still be one this group listens on, so a
   * program that already holds the port is never mistaken for the app (E4).
   */
  urlOverride?: string;
  /** Asked once when several ports serve HTML. null (dismissed) takes the lowest of them. */
  pick?: (ports: number[]) => Promise<number | null>;
  signal: AbortSignal;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  retryMs?: number;
}

function portOf(url: string): number {
  const u = new URL(url);
  return u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
}

/**
 * Wait until the app answers HTTP on a loopback port that its own process group listens on. Each round: which processes
 * are left (none: fail at once), which loopback ports they listen on, which of those answer. A round repeats every
 * `retryMs` until `timeoutMs`.
 */
export async function waitForReady(o: ReadyWaitOptions): Promise<ReadyResult> {
  const timeoutMs = o.timeoutMs ?? READY_TIMEOUT_MS;
  const retryMs = o.retryMs ?? RETRY_MS;
  const deadline = o.clock.now() + timeoutMs;
  const aborted = new Promise<"aborted">((resolve) => {
    if (o.signal.aborted) resolve("aborted");
    else o.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  const probeDeps = { httpGet: o.httpGet, clock: o.clock, timeoutMs: o.probeTimeoutMs };

  while (o.clock.now() < deadline) {
    if (o.signal.aborted) return { kind: "cancelled" };
    const pids = await o.members();
    if (o.signal.aborted) return { kind: "cancelled" };
    if (pids.length === 0) return { kind: "exited" };

    const candidates = loopbackCandidates(await o.listeners(pids));
    if (o.signal.aborted) return { kind: "cancelled" };
    const targets = o.urlOverride
      ? candidates.filter((c) => c.port === portOf(o.urlOverride!)).map((c) => ({ port: c.port, url: o.urlOverride! }))
      : candidates.map((c) => ({ port: c.port, url: `http://${c.host}:${c.port}/` }));
    const probed = await Promise.all(targets.map(async (t) => ({ t, r: await probe(t.url, probeDeps) })));
    if (o.signal.aborted) return { kind: "cancelled" };

    const answered = probed.filter((p) => p.r !== null);
    if (answered.length > 0) {
      const answers: Answer[] = answered.map((p) => ({ port: p.t.port, html: p.r!.html }));
      const urlFor = (port: number) => answered.find((p) => p.t.port === port)!.t.url;
      const choice = choosePort(answers);
      if (choice.kind === "port") return { kind: "ready", port: choice.port, url: urlFor(choice.port), picked: false };
      if (choice.kind === "picker") {
        const chosen = o.pick ? await o.pick(choice.ports) : null;
        if (o.signal.aborted) return { kind: "cancelled" };
        const port = chosen !== null && choice.ports.includes(chosen) ? chosen : choice.ports[0];
        return { kind: "ready", port, url: urlFor(port), picked: chosen !== null };
      }
    }
    if ((await Promise.race([o.clock.sleep(retryMs), aborted])) === "aborted") return { kind: "cancelled" };
  }
  return { kind: "timeout" };
}
