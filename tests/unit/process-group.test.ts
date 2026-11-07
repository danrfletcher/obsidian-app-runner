import { describe, expect, it } from "vitest";
import {
  isOwned,
  membersOf,
  mergeMembers,
  parsePs,
  signalGroup,
  stopGroup,
  type KillFn,
  type ProcRow,
  type ProcessTable,
  type Signal,
} from "../../src/process-group";
import { FakeClock } from "../fake-clock";

/** Captured from `LC_ALL=C ps -axo pid=,pgid=,lstart=` on macOS 26: padded columns, a trailing-space line, a blank line. */
const PS_FIXTURE = [
  "    1     1 Thu Oct 15 11:57:42 2026    ",
  "  120   120 Fri Nov  6 23:21:39 2026",
  "  123   120 Fri Nov  6 23:21:39 2026",
  "",
  " 5000  5000 Fri Nov  6 23:30:01 2026",
  " 5001  5000 Fri Nov  6 23:30:02 2026",
  " 5002  5000 Fri Nov  6 23:30:03 2026",
].join("\n");

describe("parsePs", () => {
  it("reads pid, pgid and the start time, ignoring padding and blank lines", () => {
    const rows = parsePs(PS_FIXTURE);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ pid: 1, pgid: 1, startTime: "Thu Oct 15 11:57:42 2026" });
    expect(rows[2]).toEqual({ pid: 123, pgid: 120, startTime: "Fri Nov  6 23:21:39 2026" });
  });

  it("parses the two-column form `ps -axo pid=,pgid=` too (no start time)", () => {
    expect(parsePs("  10  10\n  11  10\n")).toEqual([
      { pid: 10, pgid: 10, startTime: "" },
      { pid: 11, pgid: 10, startTime: "" },
    ]);
  });

  it.each([
    ["header-like text", "  PID  PGID STARTED\n  12  12"],
    ["non-numeric pid", "abc 12\n7 7"],
    ["non-numeric pgid", "7 x\n8 8"],
    ["one column", "9\n8 8"],
    ["negative", "-3 -3\n8 8"],
  ])("skips %s", (_label, text) => {
    const rows = parsePs(text);
    expect(rows.every((r) => Number.isInteger(r.pid) && Number.isInteger(r.pgid))).toBe(true);
    expect(rows.at(-1)!.pid).toBe(rows.at(-1)!.pgid);
    expect(rows.map((r) => r.pid)).not.toContain(NaN);
  });

  it("empty and whitespace-only output give no rows", () => {
    expect(parsePs("")).toEqual([]);
    expect(parsePs("\n  \n\t\n")).toEqual([]);
  });

  it("handles CRLF line ends", () => {
    expect(parsePs("1 1 Thu Oct 15 11:57:42 2026\r\n2 2 Thu Oct 15 11:57:43 2026\r\n")).toHaveLength(2);
  });
});

describe("group membership and ownership", () => {
  const rows = parsePs(PS_FIXTURE);

  it("membersOf returns every row of the group with its start time", () => {
    expect(membersOf(rows, 5000)).toEqual([
      { pid: 5000, startTime: "Fri Nov  6 23:30:01 2026" },
      { pid: 5001, startTime: "Fri Nov  6 23:30:02 2026" },
      { pid: 5002, startTime: "Fri Nov  6 23:30:03 2026" },
    ]);
    expect(membersOf(rows, 99999)).toEqual([]);
  });

  it("start-time capture: the recorded members carry the lstart text", () => {
    expect(membersOf(rows, 120).map((m) => m.startTime)).toEqual(["Fri Nov  6 23:21:39 2026", "Fri Nov  6 23:21:39 2026"]);
  });

  it("mergeMembers adds only members it has not seen (same pid and start time)", () => {
    const a = [{ pid: 1, startTime: "t1" }];
    expect(mergeMembers(a, [{ pid: 1, startTime: "t1" }, { pid: 2, startTime: "t2" }])).toEqual([
      { pid: 1, startTime: "t1" },
      { pid: 2, startTime: "t2" },
    ]);
    // the same pid with another start time is a different process
    expect(mergeMembers(a, [{ pid: 1, startTime: "t9" }])).toHaveLength(2);
  });

  it("isOwned needs a recorded member alive in that group with the same start time", () => {
    const recorded = [{ pid: 5001, startTime: "Fri Nov  6 23:30:02 2026" }];
    expect(isOwned(rows, 5000, recorded)).toBe(true);
    expect(isOwned(rows, 120, recorded)).toBe(false); // wrong group
    expect(isOwned(rows, 5000, [{ pid: 5001, startTime: "Sat Nov  7 00:00:00 2026" }])).toBe(false); // pid reused
    expect(isOwned(rows, 5000, [])).toBe(false);
    expect(isOwned([], 5000, recorded)).toBe(false);
  });
});

describe("signalGroup", () => {
  it("signals the negative pid, i.e. the whole group", () => {
    const sent: Array<[number, Signal]> = [];
    expect(signalGroup((p, s) => void sent.push([p, s]), 5000, "SIGTERM")).toBe("sent");
    expect(sent).toEqual([[-5000, "SIGTERM"]]);
  });

  it("ESRCH is success: the group is already gone", () => {
    const kill: KillFn = () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    expect(signalGroup(kill, 5000, "SIGTERM")).toBe("gone");
  });

  it("any other error is raised", () => {
    const kill: KillFn = () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    };
    expect(() => signalGroup(kill, 5000, "SIGTERM")).toThrow("denied");
  });

  it.each([0, 1, -5, 1.5, NaN])("refuses to signal group %s", (pgid) => {
    const sent: unknown[] = [];
    expect(() => signalGroup((...a) => void sent.push(a), pgid, "SIGTERM")).toThrow(/Refusing/);
    expect(sent).toEqual([]);
  });
});

describe("stopGroup: SIGTERM then SIGKILL (E8)", () => {
  const T0 = "Fri Nov  6 23:30:01 2026";

  /** A table whose rows the test controls over time. */
  function world(initial: ProcRow[]) {
    const clock = new FakeClock();
    let rows = initial;
    const sent: Array<[number, Signal]> = [];
    const table: ProcessTable = { snapshot: async () => rows };
    return {
      clock,
      sent,
      table,
      set: (r: ProcRow[]) => (rows = r),
      kill: ((pid: number, sig: Signal) => void sent.push([pid, sig])) as KillFn,
    };
  }

  it("a group that exits on SIGTERM is never SIGKILLed", async () => {
    const w = world([{ pid: 5000, pgid: 5000, startTime: T0 }]);
    const kill: KillFn = (pid, sig) => {
      w.sent.push([pid, sig]);
      if (sig === "SIGTERM") w.set([]);
    };
    const out = await w.clock.run(stopGroup({ pgid: 5000, members: [{ pid: 5000, startTime: T0 }], table: w.table, kill, clock: w.clock }));
    expect(out).toBe("terminated");
    expect(w.sent).toEqual([[-5000, "SIGTERM"]]);
    expect(w.clock.now() - 1_000_000).toBeLessThan(5000);
  });

  it("a group that ignores SIGTERM gets SIGKILL after 5 s, not before", async () => {
    const w = world([{ pid: 5000, pgid: 5000, startTime: T0 }]);
    const pending = stopGroup({ pgid: 5000, members: [{ pid: 5000, startTime: T0 }], table: w.table, kill: w.kill, clock: w.clock });
    await w.clock.advance(4900);
    expect(w.sent).toEqual([[-5000, "SIGTERM"]]);
    await w.clock.advance(200);
    expect(await pending).toBe("killed");
    expect(w.sent).toEqual([
      [-5000, "SIGTERM"],
      [-5000, "SIGKILL"],
    ]);
  });

  it("the grace period is configurable but is 5 s by default", async () => {
    const w = world([{ pid: 5000, pgid: 5000, startTime: T0 }]);
    const start = w.clock.now();
    await w.clock.run(stopGroup({ pgid: 5000, members: [{ pid: 5000, startTime: T0 }], table: w.table, kill: w.kill, clock: w.clock }));
    expect(w.clock.now() - start).toBeGreaterThanOrEqual(5000);
    expect(w.clock.now() - start).toBeLessThan(5200);
  });

  it("ESRCH on SIGTERM is success and nothing more is sent", async () => {
    const w = world([{ pid: 5000, pgid: 5000, startTime: T0 }]);
    const kill: KillFn = (pid, sig) => {
      w.sent.push([pid, sig]);
      throw Object.assign(new Error("x"), { code: "ESRCH" });
    };
    expect(await w.clock.run(stopGroup({ pgid: 5000, members: [{ pid: 5000, startTime: T0 }], table: w.table, kill, clock: w.clock }))).toBe("gone");
    expect(w.sent).toEqual([[-5000, "SIGTERM"]]);
  });

  it("ESRCH on SIGKILL (it died in the last instant) is success too", async () => {
    const w = world([{ pid: 5000, pgid: 5000, startTime: T0 }]);
    const kill: KillFn = (pid, sig) => {
      w.sent.push([pid, sig]);
      if (sig === "SIGKILL") throw Object.assign(new Error("x"), { code: "ESRCH" });
    };
    expect(await w.clock.run(stopGroup({ pgid: 5000, members: [{ pid: 5000, startTime: T0 }], table: w.table, kill, clock: w.clock }))).toBe("killed");
  });

  it("does not signal a group with no recorded live member (pid reused: other start time)", async () => {
    const w = world([{ pid: 5000, pgid: 5000, startTime: "Sat Nov  7 09:00:00 2026" }]);
    const out = await w.clock.run(stopGroup({ pgid: 5000, members: [{ pid: 5000, startTime: T0 }], table: w.table, kill: w.kill, clock: w.clock }));
    expect(out).toBe("not-ours");
    expect(w.sent).toEqual([]);
  });

  it("does not signal a group that is gone", async () => {
    const w = world([]);
    expect(await w.clock.run(stopGroup({ pgid: 5000, members: [{ pid: 5000, startTime: T0 }], table: w.table, kill: w.kill, clock: w.clock }))).toBe("not-ours");
    expect(w.sent).toEqual([]);
  });

  it("a live leader proves ownership: SIGTERM is sent with nothing recorded", async () => {
    const w = world([{ pid: 5000, pgid: 5000, startTime: T0 }]);
    const kill: KillFn = (pid, sig) => {
      w.sent.push([pid, sig]);
      w.set([]);
    };
    await w.clock.run(stopGroup({ pgid: 5000, members: [], table: w.table, kill, clock: w.clock, leaderAlive: () => true }));
    expect(w.sent).toEqual([[-5000, "SIGTERM"]]);
  });

  it("a sibling that ignores SIGTERM after the leader left is still SIGKILLed (members are recorded before SIGTERM)", async () => {
    const sibling = { pid: 5001, pgid: 5000, startTime: "Fri Nov  6 23:30:02 2026" };
    const w = world([{ pid: 5000, pgid: 5000, startTime: T0 }, sibling]);
    const kill: KillFn = (pid, sig) => {
      w.sent.push([pid, sig]);
      if (sig === "SIGTERM") w.set([sibling]); // the leader exits, the sibling ignores it
      else w.set([]);
    };
    // only the leader was recorded; the sibling is found by the snapshot taken before SIGTERM
    const out = await w.clock.run(stopGroup({ pgid: 5000, members: [{ pid: 5000, startTime: T0 }], table: w.table, kill, clock: w.clock }));
    expect(out).toBe("killed");
    expect(w.sent.map(([, s]) => s)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("immediate mode signals before any ps (plugin unload)", async () => {
    const order: string[] = [];
    const w = world([{ pid: 5000, pgid: 5000, startTime: T0 }]);
    const table: ProcessTable = {
      snapshot: async () => {
        order.push("ps");
        return [{ pid: 5000, pgid: 5000, startTime: T0 }];
      },
    };
    const kill: KillFn = (_p, sig) => {
      order.push(sig);
      w.set([]);
    };
    const promise = stopGroup({ pgid: 5000, members: [], table, kill, clock: w.clock, leaderAlive: () => true, immediate: true, graceMs: 100 });
    expect(order[0]).toBe("SIGTERM"); // sent synchronously, before the first ps
    await w.clock.run(promise);
    expect(order.slice(0, 2)).toEqual(["SIGTERM", "ps"]);
  });
});
