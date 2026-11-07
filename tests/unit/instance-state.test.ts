import { describe, expect, it } from "vitest";
import type { OpenOutcome } from "../../src/instance";
import { logPath } from "../../src/runtime-paths";
import { FakeWorld, RUNTIME, project } from "../process-fakes";

const SLUG = "live-captions";
const LOG = logPath(RUNTIME, SLUG);

/** Track whether a promise has settled, without awaiting it. */
function track<T>(p: Promise<T>) {
  const t = { done: false, value: undefined as T | undefined, p };
  void p.then((v) => ((t.done = true), (t.value = v)));
  return t;
}

/** Open and serve: the app is up and the tab is due. */
async function startApp(w: FakeWorld, m = w.manager()) {
  const opening = track(m.open(SLUG));
  await w.clock.settle();
  w.serve(8957);
  await w.clock.run(opening.p);
  return { m, opening };
}

type State = "none" | "starting" | "running" | "stopping";
type Command = "open" | "stop" | "removeRuntime";

/** Bring a fresh world and manager to `state`. Leader ignores SIGTERM in "stopping" so the stop stays in progress. */
async function reach(state: State) {
  const w = new FakeWorld();
  const m = w.manager();
  let first: ReturnType<typeof track<OpenOutcome>> | undefined;
  let firstStop: ReturnType<typeof track<unknown>> | undefined;
  if (state === "stopping") w.nextLeader = { ignoresTerm: true };
  if (state !== "none") {
    first = track(m.open(SLUG));
    await w.clock.settle();
    if (state !== "starting") {
      w.serve(8957);
      await w.clock.run(first.p);
    }
  }
  if (state === "stopping") {
    firstStop = track(m.stop(SLUG));
    await w.clock.settle();
  }
  w.notices.length = 0; // only what the command under test says
  return { w, m, first, firstStop, leader: w.leaderPid() };
}

describe("instance state machine: every state crossed with every command (E17, E20)", () => {
  const rows: Array<{
    state: State;
    command: Command;
    outcome: unknown;
    firstOutcome?: unknown;
    spawns: number;
    signals: string[];
    after: State | "none";
    registry: boolean;
    notices: string[];
    waits?: boolean;
  }> = [
    { state: "none", command: "open", outcome: "tab", spawns: 1, signals: [], after: "running", registry: true, notices: ["Starting Live Captions"] },
    { state: "none", command: "stop", outcome: "nothing", spawns: 0, signals: [], after: "none", registry: false, notices: ["Nothing running for Live Captions."] },
    { state: "none", command: "removeRuntime", outcome: undefined, spawns: 0, signals: [], after: "none", registry: false, notices: [] },
    { state: "starting", command: "open", outcome: "joined", firstOutcome: "tab", spawns: 1, signals: [], after: "running", registry: true, notices: [] },
    { state: "starting", command: "stop", outcome: "cancelled", firstOutcome: "cancelled", spawns: 1, signals: ["-L SIGTERM"], after: "none", registry: false, notices: ["Cancelled starting Live Captions."] },
    { state: "starting", command: "removeRuntime", outcome: undefined, firstOutcome: "cancelled", spawns: 1, signals: ["-L SIGTERM"], after: "none", registry: false, notices: [] },
    { state: "running", command: "open", outcome: "tab", spawns: 1, signals: [], after: "running", registry: true, notices: [] },
    { state: "running", command: "stop", outcome: "stopped", spawns: 1, signals: ["-L SIGTERM"], after: "none", registry: false, notices: ["Stopped Live Captions."] },
    { state: "running", command: "removeRuntime", outcome: undefined, spawns: 1, signals: ["-L SIGTERM"], after: "none", registry: false, notices: [] },
    { state: "stopping", command: "open", outcome: "tab", spawns: 2, signals: ["-L SIGTERM", "-L SIGKILL"], after: "running", registry: true, notices: ["Stopped Live Captions.", "Starting Live Captions"], waits: true },
    { state: "stopping", command: "stop", outcome: "waited", spawns: 1, signals: ["-L SIGTERM", "-L SIGKILL"], after: "none", registry: false, notices: ["Stopped Live Captions."], waits: true },
    { state: "stopping", command: "removeRuntime", outcome: undefined, spawns: 1, signals: ["-L SIGTERM", "-L SIGKILL"], after: "none", registry: false, notices: ["Stopped Live Captions."], waits: true },
  ];

  it.each(rows)("$state + $command", async (row) => {
    const { w, m, first, firstStop, leader } = await reach(row.state);
    const cmd = track<unknown>(
      row.command === "open" ? m.open(SLUG).then((o) => o.kind) : row.command === "stop" ? m.stop(SLUG) : m.removeRuntime(project()),
    );
    await w.clock.settle();
    if (row.waits) expect(cmd.done).toBe(false); // an Open or Stop while stopping does not finish before the stop does
    if ((row.state === "starting" || row.state === "none") && row.command === "open") w.serve(8957); // the start now succeeds
    await w.clock.advance(5200);
    if (row.state === "stopping" && row.command === "open") w.serve(8957); // the fresh start's app comes up
    await w.clock.run(cmd.p);
    if (row.state === "stopping") await w.clock.run(firstStop!.p);
    if (first) await w.clock.run(first.p);

    expect(cmd.value).toBe(row.outcome);
    if (row.firstOutcome !== undefined) expect((first!.value as OpenOutcome).kind).toBe(row.firstOutcome);
    expect(w.spawns).toHaveLength(row.spawns);
    expect(w.signals.map(([pid, sig]) => `${pid === -leader ? "-L" : pid} ${sig}`)).toEqual(row.signals);
    expect(m.stateOf(SLUG)).toBe(row.after);
    expect(w.registry.entries.has(SLUG)).toBe(row.registry);
    expect(w.notices).toEqual(row.notices);
    if (row.command === "removeRuntime") expect(w.logs.has(LOG)).toBe(false);
  });
});

describe("G5 Open runs the project's start command", () => {
  it("spawns `zsh -lic <command>` in the project folder and gives a tab when the app answers", async () => {
    const w = new FakeWorld();
    const { opening } = await startApp(w);
    expect(opening.value).toEqual({ kind: "tab", url: "http://127.0.0.1:8957/" });
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].command).toBe("/bin/zsh");
    expect(w.spawns[0].args).toEqual(["-lic", "npm run start"]);
    expect(w.spawns[0].options.cwd).toBe("/work/live-captions");
    expect(w.spawns[0].options.detached).toBe(true);
    expect(w.spawns[0].options.stdio).toEqual(["ignore", 99, 99]);
  });

  it("GP3: the Starting notice comes first, before any process exists", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    void m.open(SLUG);
    expect(w.notices).toEqual(["Starting Live Captions"]);
    expect(w.spawns.length).toBe(0 + 1); // the notice is sent synchronously; the spawn follows in the same tick
  });

  it("the second Open on a running app only asks for another tab", async () => {
    const w = new FakeWorld();
    const { m } = await startApp(w);
    expect(await m.open(SLUG)).toEqual({ kind: "tab", url: "http://127.0.0.1:8957/" });
    expect(w.spawns).toHaveLength(1);
  });

  it("the log is truncated by each start, not by joining or by a second tab", async () => {
    const w = new FakeWorld();
    const { m } = await startApp(w);
    await m.open(SLUG);
    expect(w.truncations).toEqual([LOG]);
    await w.clock.run(m.stop(SLUG));
    await startApp(w, m);
    expect(w.truncations).toEqual([LOG, LOG]);
  });

  it("the app's URL is available to the tab once running, and only then", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    expect(m.urlOf(SLUG)).toBeUndefined();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    expect(m.urlOf(SLUG)).toBeUndefined();
    w.serve(8957);
    await w.clock.run(opening.p);
    expect(m.urlOf(SLUG)).toBe("http://127.0.0.1:8957/");
  });

  it("the registry entry is written at spawn with the leader's pid, pgid and start time, then updated with the port", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    const pid = w.leaderPid();
    expect(w.registry.entries.get(SLUG)).toMatchObject({ slug: SLUG, pid, pgid: pid, port: null, members: [{ pid, startTime: w.startTimeFor(pid) }] });
    w.serve(8957);
    await w.clock.run(opening.p);
    await w.clock.settle();
    expect(w.registry.entries.get(SLUG)!.port).toBe(8957);
  });

  it("members that appear later are recorded with their start times", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    const pid = w.leaderPid();
    w.addProc(pid + 100, pid);
    await w.clock.advance(1000);
    w.serve(8957);
    await w.clock.run(opening.p);
    expect(w.registry.entries.get(SLUG)!.members.map((x) => x.pid)).toEqual([pid, pid + 100]);
  });
});

describe("G5 Open in browser: the start path completes, the URL goes to one openExternal seam, no tab", () => {
  it("hands the loopback URL to openExternal once and returns no tab", async () => {
    const w = new FakeWorld(project({ openInBrowser: true }));
    const { opening } = await startApp(w);
    expect(opening.value).toEqual({ kind: "browser", url: "http://127.0.0.1:8957/" });
    expect(w.external).toEqual(["http://127.0.0.1:8957/"]);
    expect(w.spawns).toHaveLength(1);
    expect(w.registry.entries.has(SLUG)).toBe(true);
  });

  it("a second Open on the running app also goes to the browser, not a tab", async () => {
    const w = new FakeWorld(project({ openInBrowser: true }));
    const { m } = await startApp(w);
    expect((await m.open(SLUG)).kind).toBe("browser");
    expect(w.external).toHaveLength(2);
  });

  it("two racing Opens give one openExternal call", async () => {
    const w = new FakeWorld(project({ openInBrowser: true }));
    const m = w.manager();
    const a = track(m.open(SLUG));
    const b = track(m.open(SLUG));
    await w.clock.settle();
    w.serve(8957);
    await w.clock.run(Promise.all([a.p, b.p]));
    expect(w.external).toHaveLength(1);
    expect([a.value!.kind, b.value!.kind].sort()).toEqual(["browser", "joined"]);
  });
});

describe("E20 racing starts make one spawn, one registry entry, one tab", () => {
  it("two Opens in the same tick", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const a = track(m.open(SLUG));
    const b = track(m.open(SLUG));
    await w.clock.settle();
    w.serve(8957);
    await w.clock.run(Promise.all([a.p, b.p]));
    expect(w.spawns).toHaveLength(1);
    expect(w.registry.entries.size).toBe(1);
    expect([a.value!.kind, b.value!.kind].sort()).toEqual(["joined", "tab"]);
    expect(w.notices.filter((n) => n.startsWith("Starting"))).toEqual(["Starting Live Captions"]);
  });

  it("two Opens either side of an await boundary", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const a = track(m.open(SLUG));
    await Promise.resolve();
    await w.clock.settle(1);
    const b = track(m.open(SLUG));
    await w.clock.settle();
    const c = track(m.open(SLUG));
    w.serve(8957);
    await w.clock.run(Promise.all([a.p, b.p, c.p]));
    expect(w.spawns).toHaveLength(1);
    expect(w.registry.sets).toBeGreaterThan(0);
    expect(w.registry.entries.size).toBe(1);
    expect([a, b, c].map((x) => x.value!.kind).sort()).toEqual(["joined", "joined", "tab"]);
  });

  it("ten Opens at once still make one spawn and one tab", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const all = Array.from({ length: 10 }, () => track(m.open(SLUG)));
    await w.clock.settle();
    w.serve(8957);
    await w.clock.run(Promise.all(all.map((x) => x.p)));
    expect(w.spawns).toHaveLength(1);
    expect(all.filter((x) => x.value!.kind === "tab")).toHaveLength(1);
  });

  it("a second project starts on its own", async () => {
    const w = new FakeWorld(project(), project({ name: "Build Dashboard", slug: "build-dashboard", folder: "/work/build-dashboard" }));
    const m = w.manager();
    const a = track(m.open(SLUG));
    const b = track(m.open("build-dashboard"));
    await w.clock.settle();
    expect(w.spawns).toHaveLength(2);
    w.serve(8957, { pid: 5000 });
    w.serve(4317, { pid: 5001 });
    await w.clock.run(Promise.all([a.p, b.p]));
    expect([a.value!.kind, b.value!.kind]).toEqual(["tab", "tab"]);
  });
});

describe("G6 failed starts", () => {
  it("every process exits before a port answers: no tab, the notice carries the log lines, nothing is left behind", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    w.logs.set(LOG, "Error: boom\nat server.js:1\n");
    w.procs = []; // the app died
    w.children.get(w.leaderPid())!.exit(1);
    const out = await w.clock.run(opening.p);
    expect(out).toEqual({ kind: "failed" });
    expect(w.notices.at(-1)).toBe("Live Captions stopped before it was ready.\n\nLast lines of the log:\nError: boom\nat server.js:1");
    expect(m.stateOf(SLUG)).toBe("none");
    expect(w.registry.entries.has(SLUG)).toBe(false);
    expect(m.urlOf(SLUG)).toBeUndefined();
  });

  it("60 s with nothing answering: the group is stopped, no tab, the notice shows the last 10 log lines", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    w.logs.set(LOG, Array.from({ length: 15 }, (_, i) => `out ${i + 1}`).join("\n"));
    const leader = w.leaderPid();
    const start = w.clock.now();
    const out = await w.clock.run(opening.p);
    expect(out).toEqual({ kind: "failed" });
    expect(w.clock.now() - start).toBeGreaterThanOrEqual(60_000);
    expect(w.signals[0]).toEqual([-leader, "SIGTERM"]);
    expect(w.procs).toEqual([]);
    const notice = w.notices.at(-1)!;
    expect(notice).toContain("within 60 seconds");
    expect(notice.split("\n").slice(-10)).toEqual(Array.from({ length: 10 }, (_, i) => `out ${i + 6}`));
    expect(m.stateOf(SLUG)).toBe("none");
    expect(w.registry.entries.has(SLUG)).toBe(false);
  });

  it("after a failed start the next Open starts cleanly", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    w.nextLeader = { exitsWith: 127 };
    expect((await w.clock.run(m.open(SLUG))).kind).toBe("failed");
    expect(m.stateOf(SLUG)).toBe("none");
    expect(w.registry.entries.size).toBe(0);
    const { opening } = await startApp(w, m);
    expect(opening.value!.kind).toBe("tab");
    expect(w.spawns).toHaveLength(2);
    expect(w.registry.entries.get(SLUG)!.pid).toBe(w.leaderPid());
    expect(m.stateOf(SLUG)).toBe("running");
  });

  it("E2: a command that exits at once fails fast, long before 60 s, with the log lines", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    w.nextLeader = { exitsWith: 127 };
    const opening = track(m.open(SLUG));
    w.logs.set(LOG, "zsh:1: command not found: nope");
    const start = w.clock.now();
    const out = await w.clock.run(opening.p);
    expect(out.kind).toBe("failed");
    expect(w.clock.now() - start).toBeLessThan(5000);
    expect(w.notices.at(-1)).toContain("the command was not found in your login shell's PATH");
    expect(w.notices.at(-1)).toContain("zsh:1: command not found: nope");
  });

  it("a shell that cannot be spawned (no pid) fails with the spawn error and clears the instance", async () => {
    const w = new FakeWorld();
    const m = w.manager({
      spawn: () => {
        const child = new (class extends (require("node:events").EventEmitter as typeof import("node:events").EventEmitter) {
          pid = undefined;
          exitCode = null;
          signalCode = null;
        })();
        setTimeout(() => child.emit("error", new Error("spawn /bin/zsh ENOENT")), 0);
        return child as never;
      },
    });
    const out = await w.clock.run(m.open(SLUG));
    expect(out.kind).toBe("failed");
    expect(w.notices.at(-1)).toContain("spawn /bin/zsh ENOENT");
    expect(m.stateOf(SLUG)).toBe("none");
    expect(w.signals).toEqual([]);
  });

  it("a registry write that fails at spawn stops the app it just started and says so (E15)", async () => {
    const w = new FakeWorld();
    w.registry.failSets = true;
    const m = w.manager();
    const out = await w.clock.run(m.open(SLUG));
    expect(out.kind).toBe("failed");
    expect(w.signals[0]).toEqual([-w.leaderPid(), "SIGTERM"]);
    expect(w.procs).toEqual([]);
    expect(w.notices.at(-1)).toContain("could not record it");
    expect(m.stateOf(SLUG)).toBe("none");
  });

  it("E4: the app dies with address-in-use; the notice says so and no other process is signalled", async () => {
    const w = new FakeWorld();
    // Something Dan started by hand holds 8957 and answers; it is not in our group.
    w.addProc(777, 777);
    w.answers.set(8957, { html: true });
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    w.logs.set(LOG, "Error: listen EADDRINUSE: address already in use 127.0.0.1:8957");
    w.procs = w.procs.filter((p) => p.pid === 777);
    w.children.get(w.leaderPid())!.exit(1);
    const out = await w.clock.run(opening.p);
    expect(out.kind).toBe("failed");
    expect(w.notices.at(-1)).toContain("its port is already in use by another program");
    expect(w.procs.map((p) => p.pid)).toEqual([777]);
    expect(w.signals.every(([pid]) => pid !== -777)).toBe(true);
    expect(w.probes).toEqual([]); // the foreign listener was never probed: it is not in our group's lsof
    expect(m.urlOf(SLUG)).toBeUndefined();
  });

  it("E4 with a URL override on the taken port: the foreign program is never taken for the app", async () => {
    const w = new FakeWorld(project({ urlOverride: "http://127.0.0.1:8957/" }));
    w.addProc(777, 777);
    w.listening.set(777, [["127.0.0.1", 8957]]);
    w.answers.set(8957, { html: true });
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    w.logs.set(LOG, "EADDRINUSE");
    w.procs = w.procs.filter((p) => p.pid === 777);
    w.children.get(w.leaderPid())!.exit(1);
    expect((await w.clock.run(opening.p)).kind).toBe("failed");
    expect(w.probes).toEqual([]);
    expect(w.signals.every(([pid]) => pid !== -777)).toBe(true);
  });

  it("E16: a .zshrc that blocks hits the 60 s timeout with its banner lines in the notice", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    w.logs.set(LOG, "Welcome to Dan's zsh\nPress any key to continue...");
    expect((await w.clock.run(opening.p)).kind).toBe("failed");
    const notice = w.notices.at(-1)!;
    expect(notice).toContain("within 60 seconds");
    expect(notice).toContain("Press any key to continue...");
  });

  it("E16: banners from a .zshrc that does not block never reach a notice", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    w.logs.set(LOG, "Welcome to Dan's zsh\nnvm ready");
    w.serve(8957);
    await w.clock.run(opening.p);
    expect(w.notices.join("\n")).not.toContain("Welcome");
  });

  it("added: the app exits mid-start but a sibling lingers; the sibling is still stopped and the entry removed", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    const leader = w.leaderPid();
    w.addProc(leader + 50, leader); // a worker the app started
    await w.clock.advance(1000); // recorded at the next look
    // the leader exits on its own; the worker lingers and listens nowhere
    w.procs = w.procs.filter((p) => p.pid !== leader);
    w.children.get(leader)!.exit(1);
    const out = await w.clock.run(opening.p);
    expect(out.kind).toBe("failed");
    expect(w.signals[0]).toEqual([-leader, "SIGTERM"]);
    expect(w.procs).toEqual([]);
    expect(w.registry.entries.has(SLUG)).toBe(false);
    expect(m.stateOf(SLUG)).toBe("none");
  });
});

describe("E1 folder missing at start", () => {
  it("refuses before anything is spawned, names the folder, writes no entry and leaves the log alone", async () => {
    const w = new FakeWorld(project({ folder: "/work/moved" }));
    w.logs.set(LOG, "previous run output");
    const m = w.manager();
    expect(await m.open(SLUG)).toEqual({ kind: "refused" });
    expect(w.spawns).toEqual([]);
    expect(w.truncations).toEqual([]);
    expect(w.logs.get(LOG)).toBe("previous run output");
    expect(w.registry.sets).toBe(0);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toContain("/work/moved");
    expect(w.notices[0]).not.toContain("Starting");
    expect(m.stateOf(SLUG)).toBe("none");
  });
});

describe("E3 several ports and the picker", () => {
  async function twoPorts(w: FakeWorld) {
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    w.serve(3000, { html: true });
    w.serve(8957, { html: true });
    return { m, opening };
  }

  it("two HTML ports: the picker is shown once and the choice is remembered as the URL override", async () => {
    const w = new FakeWorld();
    w.pickerAnswer = 8957;
    const { opening } = await twoPorts(w);
    await w.clock.run(opening.p);
    expect(w.pickerCalls).toEqual([[3000, 8957]]);
    expect(opening.value).toEqual({ kind: "tab", url: "http://127.0.0.1:8957/" });
    expect(w.remembered).toEqual([[SLUG, "http://127.0.0.1:8957/"]]);
  });

  it("a dismissed picker uses the lowest HTML port and remembers nothing", async () => {
    const w = new FakeWorld();
    w.pickerAnswer = null;
    const { opening } = await twoPorts(w);
    await w.clock.run(opening.p);
    expect(opening.value).toEqual({ kind: "tab", url: "http://127.0.0.1:3000/" });
    expect(w.remembered).toEqual([]);
  });

  it("a Stop while the picker is up cancels the start without a tab", async () => {
    const w = new FakeWorld();
    let release!: (n: number | null) => void;
    const m = w.manager({ pickPort: (_p, _ports, signal) => new Promise((resolve) => ((release = resolve), signal.addEventListener("abort", () => resolve(null)))) });
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    w.serve(3000);
    w.serve(8957);
    await w.clock.advance(1100);
    expect(release).toBeTypeOf("function");
    const stop = track(m.stop(SLUG));
    await w.clock.run(stop.p);
    await w.clock.run(opening.p);
    expect(opening.value).toEqual({ kind: "cancelled" });
    expect(w.remembered).toEqual([]);
  });

  it("an app listening only on a non-loopback address is ignored until the 60 s timeout", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    w.serve(8957, { address: "192.168.1.20" });
    expect((await w.clock.run(opening.p)).kind).toBe("failed");
    expect(w.probes).toEqual([]);
  });

  it("F6: a non-loopback URL override is ignored and discovery is used", async () => {
    const w = new FakeWorld(project({ urlOverride: "http://example.com:8957/" }));
    const { opening } = await startApp(w);
    expect(opening.value).toEqual({ kind: "tab", url: "http://127.0.0.1:8957/" });
    expect(w.probes.every((u) => u.startsWith("http://127.0.0.1:"))).toBe(true);
  });

  it("a loopback URL override replaces discovery and its path is kept", async () => {
    const w = new FakeWorld(project({ urlOverride: "http://localhost:8957/live" }));
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    w.serve(8957);
    await w.clock.run(opening.p);
    expect(opening.value).toEqual({ kind: "tab", url: "http://localhost:8957/live" });
  });
});

describe("E17 Stop while starting or stopping", () => {
  it("Stop while starting kills the group, opens no tab and leaves no entry", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    const leader = w.leaderPid();
    w.serve(8957);
    expect(await w.clock.run(m.stop(SLUG))).toBe("cancelled");
    await w.clock.run(opening.p);
    expect(opening.value).toEqual({ kind: "cancelled" });
    expect(w.signals).toEqual([[-leader, "SIGTERM"]]);
    expect(w.procs).toEqual([]);
    expect(m.stateOf(SLUG)).toBe("none");
    expect(w.registry.entries.size).toBe(0);
  });

  it("an Open while stopping waits, then starts fresh with a new group", async () => {
    const w = new FakeWorld();
    w.nextLeader = { ignoresTerm: true };
    const { m } = await startApp(w);
    const firstLeader = w.leaderPid();
    const stop = track(m.stop(SLUG));
    await w.clock.settle();
    const open = track(m.open(SLUG));
    await w.clock.advance(1000);
    expect(open.done).toBe(false);
    expect(w.spawns).toHaveLength(1);
    await w.clock.advance(4200);
    await w.clock.settle();
    expect(stop.done).toBe(true);
    expect(w.spawns).toHaveLength(2);
    w.serve(8957, { pid: w.leaderPid() });
    await w.clock.run(open.p);
    expect(open.value!.kind).toBe("tab");
    expect(w.leaderPid()).not.toBe(firstLeader);
    expect(w.registry.entries.get(SLUG)!.pid).toBe(w.leaderPid());
  });
});

describe("Stop when nothing runs", () => {
  it("shows a notice and signals nothing, also for a project that was deleted", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    expect(await m.stop(SLUG)).toBe("nothing");
    expect(await m.stop("gone")).toBe("nothing");
    expect(w.signals).toEqual([]);
    expect(w.notices).toEqual(["Nothing running for Live Captions.", "Nothing running for gone."]);
  });

  it("after a Stop, a second Stop says nothing is running and signals nothing more", async () => {
    const w = new FakeWorld();
    const { m } = await startApp(w);
    await w.clock.run(m.stop(SLUG));
    const sent = w.signals.length;
    expect(await m.stop(SLUG)).toBe("nothing");
    expect(w.signals).toHaveLength(sent);
  });
});

describe("a running app that dies by itself", () => {
  it("is dropped with its entry, and a notice says so", async () => {
    const w = new FakeWorld();
    const { m } = await startApp(w);
    const leader = w.leaderPid();
    w.procs = [];
    w.children.get(leader)!.exit(1);
    await w.clock.settle();
    expect(m.stateOf(SLUG)).toBe("none");
    expect(w.registry.entries.size).toBe(0);
    expect(w.notices.at(-1)).toBe("Live Captions stopped on its own.");
    expect(w.signals).toEqual([]);
  });

  it("stays running when only the leader is gone and a worker still lives", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    const opening = track(m.open(SLUG));
    await w.clock.settle();
    const leader = w.leaderPid();
    w.addProc(leader + 9, leader); // started while the app was coming up: recorded at the next look
    await w.clock.advance(1000);
    w.serve(8957);
    await w.clock.run(opening.p);
    w.procs = w.procs.filter((p) => p.pid !== leader);
    w.children.get(leader)!.exit(0);
    await w.clock.settle();
    expect(m.stateOf(SLUG)).toBe("running");
  });
});

describe("unload and delete", () => {
  it("stopAllNow sends SIGTERM to every group synchronously", async () => {
    const w = new FakeWorld();
    const { m } = await startApp(w);
    const leader = w.leaderPid();
    m.stopAllNow();
    expect(w.signals).toEqual([[-leader, "SIGTERM"]]);
    await w.clock.advance(500);
    expect(m.stateOf(SLUG)).toBe("none");
    expect(w.registry.entries.size).toBe(0);
  });

  it("a SIGKILL follows 5 s later for a group that ignores SIGTERM", async () => {
    const w = new FakeWorld();
    w.nextLeader = { ignoresTerm: true };
    const { m } = await startApp(w);
    m.stopAllNow();
    await w.clock.advance(5200);
    expect(w.signals.map(([, s]) => s)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("removeRuntime removes the log and the registry entry of a stopped project", async () => {
    const w = new FakeWorld();
    const m = w.manager();
    w.logs.set(LOG, "old");
    w.registry.entries.set(SLUG, { slug: SLUG, pid: 1, pgid: 1, members: [], port: null, startedAt: 0 });
    await m.removeRuntime(project());
    expect(w.logs.has(LOG)).toBe(false);
    expect(w.registry.entries.size).toBe(0);
    expect(w.signals).toEqual([]);
  });
});

describe("F11 a group that is not ours is never signalled", () => {
  it("Stop does nothing to a group whose recorded members are gone (a pid reused by something else)", async () => {
    const w = new FakeWorld();
    const { m } = await startApp(w);
    const leader = w.leaderPid();
    // The leader's child object says it has exited, and a stranger now holds that pid under a different start time.
    w.children.get(leader)!.exitCode = 0;
    w.procs = [{ pid: leader, pgid: leader, startTime: "Sat Nov  7 09:00:00 2026", ignoresTerm: false }];
    await w.clock.run(m.stop(SLUG));
    expect(w.signals).toEqual([]);
    expect(w.procs).toHaveLength(1);
    expect(m.stateOf(SLUG)).toBe("none");
  });
});
