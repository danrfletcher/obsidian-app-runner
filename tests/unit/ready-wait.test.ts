import { describe, expect, it } from "vitest";
import type { HttpGet, HttpResponseLike } from "../../src/loopback-http";
import type { Listener } from "../../src/port-discovery";
import { probe, waitForReady, type ReadyWaitOptions } from "../../src/ready-wait";
import { FakeClock } from "../fake-clock";

const res = (status = 200, contentType: string | null = "text/html"): HttpResponseLike => ({
  status,
  headers: { get: (n) => (n.toLowerCase() === "content-type" ? contentType : null) },
});

/** A fake HTTP: what each URL does, and a log of the requests with the fake time they were made. */
function fakeHttp(clock: FakeClock, behaviour: (url: string, n: number) => HttpResponseLike | "refuse" | "hang") {
  const requests: Array<{ url: string; at: number; aborted: boolean }> = [];
  const get: HttpGet = (url, { signal }) => {
    const entry = { url, at: clock.now(), aborted: false };
    requests.push(entry);
    const what = behaviour(url, requests.filter((r) => r.url === url).length);
    if (what === "refuse") return Promise.reject(new Error("ECONNREFUSED"));
    if (what === "hang") {
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          entry.aborted = true;
          reject(new Error("aborted"));
        }),
      );
    }
    return Promise.resolve(what);
  };
  return { get, requests };
}

const listener = (port: number, address = "127.0.0.1"): Listener => ({ pid: 100, address, port });

function opts(clock: FakeClock, http: HttpGet, over: Partial<ReadyWaitOptions> = {}): ReadyWaitOptions {
  return {
    clock,
    httpGet: http,
    members: async () => [100],
    listeners: async () => [listener(8957)],
    signal: new AbortController().signal,
    ...over,
  };
}

describe("probe: 'answers HTTP' (E3)", () => {
  it.each([200, 404, 500, 302, 401])("status %i counts as an answer", async (status) => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => res(status));
    expect(await clock.run(probe("http://127.0.0.1:1/", { httpGet: http.get, clock }))).toEqual({ html: true });
  });

  it("a refused connection is not an answer", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => "refuse");
    expect(await clock.run(probe("http://127.0.0.1:1/", { httpGet: http.get, clock }))).toBeNull();
  });

  it("no answer within 2 s is not an answer, and the request is aborted", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => "hang");
    const start = clock.now();
    expect(await clock.run(probe("http://127.0.0.1:1/", { httpGet: http.get, clock }))).toBeNull();
    expect(clock.now() - start).toBe(2000);
    expect(http.requests[0].aborted).toBe(true);
  });

  it.each([
    ["text/html", true],
    ["text/html; charset=utf-8", true],
    ["TEXT/HTML", true],
    ["application/xhtml+xml", true],
    ["application/json", false],
    ["text/plain", false],
    [null, false],
  ])("content-type %s: html=%s", async (type, html) => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => res(200, type));
    expect(await clock.run(probe("http://127.0.0.1:1/", { httpGet: http.get, clock }))).toEqual({ html });
  });
});

describe("waitForReady", () => {
  it("the first round that finds an answering port returns at once, with its URL", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => res());
    const start = clock.now();
    const out = await clock.run(waitForReady(opts(clock, http.get)));
    expect(out).toEqual({ kind: "ready", port: 8957, url: "http://127.0.0.1:8957/", picked: false });
    expect(clock.now()).toBe(start);
    expect(http.requests.map((r) => r.url)).toEqual(["http://127.0.0.1:8957/"]);
  });

  it("retries every 1 s while nothing answers, then succeeds", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, (_u, n) => (n < 4 ? "refuse" : res()));
    const start = clock.now();
    const out = await clock.run(waitForReady(opts(clock, http.get)));
    expect(out.kind).toBe("ready");
    expect(http.requests.map((r) => r.at - start)).toEqual([0, 1000, 2000, 3000]);
  });

  it("a probe that hangs costs 2 s, then the next round starts 1 s later", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, (_u, n) => (n === 1 ? "hang" : res()));
    const start = clock.now();
    await clock.run(waitForReady(opts(clock, http.get)));
    expect(http.requests.map((r) => r.at - start)).toEqual([0, 3000]);
  });

  it("a response with any status is ready (a 500 is still an app that answers)", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => res(500, null));
    expect((await clock.run(waitForReady(opts(clock, http.get)))).kind).toBe("ready");
  });

  it("gives up with `timeout` at 60 s when no port ever answers", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => "refuse");
    const start = clock.now();
    const out = await clock.run(waitForReady(opts(clock, http.get)));
    expect(out).toEqual({ kind: "timeout" });
    expect(clock.now() - start).toBe(60_000);
    expect(http.requests.at(-1)!.at - start).toBe(59_000);
  });

  it("with no listening port at all it also times out at 60 s, probing nothing", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => res());
    const start = clock.now();
    const out = await clock.run(waitForReady(opts(clock, http.get, { listeners: async () => [] })));
    expect(out).toEqual({ kind: "timeout" });
    expect(clock.now() - start).toBe(60_000);
    expect(http.requests).toEqual([]);
  });

  it("returns `exited` the moment every group member is gone, long before 60 s", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => "refuse");
    let round = 0;
    const start = clock.now();
    const out = await clock.run(waitForReady(opts(clock, http.get, { members: async () => (++round <= 2 ? [100] : []) })));
    expect(out).toEqual({ kind: "exited" });
    expect(clock.now() - start).toBe(2000);
  });

  it("exits at once when there is nobody in the group from the first look", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => res());
    expect(await clock.run(waitForReady(opts(clock, http.get, { members: async () => [] })))).toEqual({ kind: "exited" });
    expect(http.requests).toEqual([]);
  });

  it("a sibling that lingers keeps the wait going after the leader is gone", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => "refuse");
    const out = await clock.run(waitForReady(opts(clock, http.get, { members: async () => [200] })));
    expect(out).toEqual({ kind: "timeout" });
  });

  it("an abort cancels the wait without waiting out the 1 s sleep", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => "refuse");
    const controller = new AbortController();
    const pending = waitForReady(opts(clock, http.get, { signal: controller.signal }));
    await clock.settle();
    controller.abort();
    expect(await clock.run(pending)).toEqual({ kind: "cancelled" });
    expect(clock.now()).toBe(1_000_000);
  });

  it("probes the lsof ports over loopback only: a LAN-only listener is never probed", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => res());
    const out = await clock.run(
      waitForReady(opts(clock, http.get, { listeners: async () => [listener(3000, "192.168.1.20"), listener(4000, "[::1]")] })),
    );
    expect(out).toMatchObject({ kind: "ready", port: 4000, url: "http://[::1]:4000/" });
    expect(http.requests.map((r) => r.url)).toEqual(["http://[::1]:4000/"]);
  });

  describe("several ports (E3)", () => {
    const two = async () => [listener(3000), listener(8957)];

    it("prefers the port that answers HTML", async () => {
      const clock = new FakeClock();
      const http = fakeHttp(clock, (u) => (u.includes(":3000") ? res(200, "application/json") : res(200, "text/html")));
      expect(await clock.run(waitForReady(opts(clock, http.get, { listeners: two })))).toMatchObject({ kind: "ready", port: 8957, picked: false });
    });

    it("takes the lowest answering port when none serves HTML", async () => {
      const clock = new FakeClock();
      const http = fakeHttp(clock, () => res(200, "application/json"));
      expect(await clock.run(waitForReady(opts(clock, http.get, { listeners: two })))).toMatchObject({ kind: "ready", port: 3000 });
    });

    it("asks once when more than one serves HTML, and returns the choice", async () => {
      const clock = new FakeClock();
      const http = fakeHttp(clock, () => res());
      const asked: number[][] = [];
      const out = await clock.run(
        waitForReady(opts(clock, http.get, { listeners: two, pick: async (ports) => (asked.push(ports), 8957) })),
      );
      expect(asked).toEqual([[3000, 8957]]);
      expect(out).toEqual({ kind: "ready", port: 8957, url: "http://127.0.0.1:8957/", picked: true });
    });

    it("a dismissed picker takes the lowest HTML port and is not remembered as a pick", async () => {
      const clock = new FakeClock();
      const http = fakeHttp(clock, () => res());
      const out = await clock.run(waitForReady(opts(clock, http.get, { listeners: two, pick: async () => null })));
      expect(out).toEqual({ kind: "ready", port: 3000, url: "http://127.0.0.1:3000/", picked: false });
    });

    it("a port that is only listening (not yet answering) is waited out, not chosen", async () => {
      const clock = new FakeClock();
      const http = fakeHttp(clock, (u, n) => (u.includes(":3000") ? "refuse" : n < 3 ? "refuse" : res()));
      const out = await clock.run(waitForReady(opts(clock, http.get, { listeners: two })));
      expect(out).toMatchObject({ kind: "ready", port: 8957 });
    });
  });

  describe("URL override", () => {
    it("is probed instead of the discovered port, with its path kept", async () => {
      const clock = new FakeClock();
      const http = fakeHttp(clock, () => res());
      const out = await clock.run(
        waitForReady(opts(clock, http.get, { urlOverride: "http://127.0.0.1:8957/live", listeners: async () => [listener(3000), listener(8957)] })),
      );
      expect(out).toEqual({ kind: "ready", port: 8957, url: "http://127.0.0.1:8957/live", picked: false });
      expect(http.requests.map((r) => r.url)).toEqual(["http://127.0.0.1:8957/live"]);
    });

    it("is not used when the group does not listen on its port (E4: someone else holds it)", async () => {
      const clock = new FakeClock();
      const http = fakeHttp(clock, () => res()); // the foreign program answers on 8957...
      const out = await clock.run(
        waitForReady(opts(clock, http.get, { urlOverride: "http://127.0.0.1:8957/", listeners: async () => [listener(3000)] })),
      );
      expect(out).toEqual({ kind: "timeout" }); // ...but the app is not on that port, so it never counts
      expect(http.requests).toEqual([]);
    });
  });
});

describe("a ps or lsof look that never comes back", () => {
  it("members() hanging: the wait ends at the deadline with a timeout, not later", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => res());
    const start = clock.now();
    const result = await clock.run(waitForReady(opts(clock, http.get, { members: () => new Promise<number[]>(() => {}), timeoutMs: 5000 })));
    expect(result).toEqual({ kind: "timeout" });
    expect(clock.now() - start).toBe(5000);
    expect(clock.pendingTimers).toBe(0); // the deadline timer is cancelled or fired, none left behind
  });

  it("listeners() hanging: the same", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => res());
    const start = clock.now();
    const result = await clock.run(waitForReady(opts(clock, http.get, { listeners: () => new Promise<Listener[]>(() => {}), timeoutMs: 5000 })));
    expect(result).toEqual({ kind: "timeout" });
    expect(clock.now() - start).toBe(5000);
    expect(http.requests).toEqual([]);
  });

  it("a look that answers in time is not cut short", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => res());
    const result = await clock.run(waitForReady(opts(clock, http.get)));
    expect(result).toMatchObject({ kind: "ready", port: 8957 });
  });

  it("a look that fails still fails the wait (the caller reports it)", async () => {
    const clock = new FakeClock();
    const http = fakeHttp(clock, () => res());
    await expect(clock.run(waitForReady(opts(clock, http.get, { members: async () => Promise.reject(new Error("ps failed")) })))).rejects.toThrow("ps failed");
    expect(clock.pendingTimers).toBe(0);
  });
});
