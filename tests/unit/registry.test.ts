import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProcRow } from "../../src/process-group";
import { isStale, parseEntry, Registry, REGISTRY_VERSION, type RegistryEntry, type RegistryProblem } from "../../src/registry";

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "app-runner-registry-"));
afterAll(() => {
  fs.chmodSync(tmp, 0o700);
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
const freshDir = () => {
  const dir = path.join(tmp, `d${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const entry = (slug = "build-dashboard", over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  slug,
  pid: 4100,
  pgid: 4100,
  members: [
    { pid: 4100, startTime: "Fri Nov  6 23:00:01 2026" },
    { pid: 4101, startTime: "Fri Nov  6 23:00:02 2026" },
  ],
  port: 4317,
  startedAt: 1_000,
  browserSessionExpected: false,
  ...over,
});

describe("schema (G10)", () => {
  it("a written entry holds the slug, pid, pgid, every member with its start time, the port and the browser flag", async () => {
    const dir = freshDir();
    await new Registry(path.join(dir, "running.json")).set(entry("build-dashboard", { browserSessionExpected: true }));
    expect(JSON.parse(fs.readFileSync(path.join(dir, "running.json"), "utf8"))).toEqual({
      version: 1,
      entries: {
        "build-dashboard": {
          slug: "build-dashboard",
          pid: 4100,
          pgid: 4100,
          members: [
            { pid: 4100, startTime: "Fri Nov  6 23:00:01 2026" },
            { pid: 4101, startTime: "Fri Nov  6 23:00:02 2026" },
          ],
          port: 4317,
          startedAt: 1_000,
          browserSessionExpected: true,
        },
      },
    });
    expect(REGISTRY_VERSION).toBe(1);
  });

  it("the file is private to the user (mode 0600)", async () => {
    const dir = freshDir();
    await new Registry(path.join(dir, "running.json")).set(entry());
    expect(fs.statSync(path.join(dir, "running.json")).mode & 0o777).toBe(0o600);
  });

  it("a null port (still starting) and a missing browser flag are read back as null and false", () => {
    const parsed = parseEntry({ slug: "a", pid: 10, pgid: 10, members: [{ pid: 10, startTime: "t" }], port: null, startedAt: 5 });
    expect(parsed).toEqual({ slug: "a", pid: 10, pgid: 10, members: [{ pid: 10, startTime: "t" }], port: null, startedAt: 5, browserSessionExpected: false });
  });

  it.each<[string, unknown]>([
    ["a string pid", { ...entry(), pid: "4100" }],
    ["pid 1", { ...entry(), pid: 1 }],
    ["a pid above the macOS maximum", { ...entry(), pgid: 100000 }],
    ["a negative pgid", { ...entry(), pgid: -4100 }],
    ["a member without a start time", { ...entry(), members: [{ pid: 4100, startTime: "" }] }],
    ["a member with a blank start time", { ...entry(), members: [{ pid: 4100, startTime: "   " }] }],
    ["a port of 0", { ...entry(), port: 0 }],
    ["a port above 65535", { ...entry(), port: 70000 }],
    ["a slug with a path separator", { ...entry(), slug: "../x" }],
    ["a slug of ..", { ...entry(), slug: ".." }],
    ["an array instead of an object", []],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(parseEntry(value)).toBeNull();
  });
});

describe("writes", () => {
  it("many concurrent sets and removes never expose a half-written file, and leave no temporary file behind", async () => {
    const dir = freshDir();
    const file = path.join(dir, "running.json");
    const reg = new Registry(file);
    let reading = true;
    let reads = 0;
    const seen: unknown[] = [];
    const reader = (async () => {
      while (reading) {
        try {
          seen.push(JSON.parse(fs.readFileSync(file, "utf8")));
          reads++;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") seen.push(e); // a partial file would be a SyntaxError
        }
        await new Promise((r) => setImmediate(r));
      }
    })();
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < 40; i++) {
      jobs.push(reg.set(entry(`app-${i % 8}`, { port: 4000 + i })));
      if (i % 5 === 4) jobs.push(reg.remove(`app-${(i + 3) % 8}`));
    }
    await Promise.all(jobs);
    reading = false;
    await reader;
    expect(reads).toBeGreaterThan(0);
    expect(seen.filter((s) => s instanceof Error)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(["running.json"]);
  });

  it("writes go to a temporary file in the same folder that is then renamed over the file", async () => {
    const dir = freshDir();
    const file = path.join(dir, "running.json");
    const reg = new Registry(file);
    await reg.set(entry("one"));
    const before = fs.statSync(file).ino;
    await reg.set(entry("two"));
    // A rename swaps the file for a new one; an in-place write would keep the inode.
    expect(fs.statSync(file).ino).not.toBe(before);
    expect(Object.keys((await reg.read()).entries).sort()).toEqual(["one", "two"]);
  });

  it("a write that fails (read-only folder) rejects, leaves the earlier file byte-identical and no temporary file", async () => {
    const dir = freshDir();
    const file = path.join(dir, "running.json");
    const reg = new Registry(file);
    await reg.set(entry("one"));
    const bytes = fs.readFileSync(file);
    fs.chmodSync(dir, 0o500);
    try {
      await expect(reg.set(entry("two"))).rejects.toThrow();
      await expect(reg.remove("one")).rejects.toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["running.json"]);
    // The queue survives a failure: the next write works.
    await reg.set(entry("three"));
    expect(Object.keys((await reg.read()).entries).sort()).toEqual(["one", "three"]);
  });

  it("removing an entry that is not there writes nothing", async () => {
    const dir = freshDir();
    const file = path.join(dir, "running.json");
    const reg = new Registry(file);
    await reg.set(entry("one"));
    const before = fs.statSync(file).ino;
    await reg.remove("absent");
    expect(fs.statSync(file).ino).toBe(before);
  });
});

describe("the stale-entry rule (G10, E5, E6, E7)", () => {
  const T_LEADER = "Fri Nov  6 23:00:01 2026";
  const T_MEMBER = "Fri Nov  6 23:00:02 2026";
  const REUSED = "Sat Nov  7 08:15:44 2026";
  const rec = entry("a"); // leader 4100 and member 4101, both in group 4100

  type Seen = "alive, same start" | "alive, other start" | "dead";
  const rows = (leader: Seen, member: Seen): ProcRow[] => {
    const out: ProcRow[] = [];
    if (leader !== "dead") out.push({ pid: 4100, pgid: 4100, startTime: leader === "alive, same start" ? T_LEADER : REUSED });
    if (member !== "dead") out.push({ pid: 4101, pgid: 4100, startTime: member === "alive, same start" ? T_MEMBER : REUSED });
    return out;
  };

  // Written out by hand: an entry is live exactly when some recorded member is alive in the group with its recorded start time.
  const table: Array<[Seen, Seen, boolean, string]> = [
    ["alive, same start", "alive, same start", false, "the app is as we left it"],
    ["alive, same start", "alive, other start", false, "the leader is ours; the reused member is ignored"],
    ["alive, same start", "dead", false, "the leader alone is enough"],
    ["alive, other start", "alive, same start", false, "E5/dead-leader style: a live recorded member keeps the group ours"],
    ["alive, other start", "alive, other start", true, "E6: every pid reused (a reboot): stale"],
    ["alive, other start", "dead", true, "E6: the leader pid was reused, nothing else is left"],
    ["dead", "alive, same start", false, "a dead leader with a live recorded member is NOT stale"],
    ["dead", "alive, other start", true, "the leader is dead and the member pid is a stranger's"],
    ["dead", "dead", true, "E7: nothing is left"],
  ];
  it.each(table)("leader %s, member %s: stale=%s (%s)", (leader, member, stale) => {
    expect(isStale(rec, rows(leader, member))).toBe(stale);
  });

  it("a recorded pid alive in another process group does not keep the entry (it left the group)", () => {
    expect(isStale(rec, [{ pid: 4100, pgid: 999, startTime: T_LEADER }])).toBe(true);
  });

  it("a stranger in the recorded group, with an unrecorded pid, does not keep the entry", () => {
    expect(isStale(rec, [{ pid: 4999, pgid: 4100, startTime: T_LEADER }])).toBe(true);
  });

  it("an empty process table is stale (E7)", () => {
    expect(isStale(rec, [])).toBe(true);
  });
});

describe("a file that cannot be used is moved aside, never overwritten", () => {
  const cases: Array<[string, string, RegistryProblem]> = [
    ["invalid JSON", "{ not json", "unreadable"],
    ["a truncated file", '{"version":1,"entries":{"a":{"slug":"a","pi', "unreadable"],
    ["an empty file", "", "empty"],
    ["a blank file", "  \n", "empty"],
    ["another schema version", JSON.stringify({ version: 2, entries: {} }), "wrong-version"],
    ["no version", JSON.stringify({ entries: {} }), "wrong-version"],
    ["an array", "[]", "invalid"],
    ["entries that are not an object", JSON.stringify({ version: 1, entries: [] }), "invalid"],
  ];
  it.each(cases)("%s", async (_label, text, problem) => {
    const dir = freshDir();
    const file = path.join(dir, "running.json");
    fs.writeFileSync(file, text);
    const heard: Array<[RegistryProblem, string | null]> = [];
    const reg = new Registry(file, { onProblem: (p, moved) => void heard.push([p, moved]) });
    const result = await reg.read();
    expect(result.entries).toEqual({});
    expect(result.problem).toBe(problem);
    const aside = fs.readdirSync(dir).filter((f) => f.startsWith("running.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), "utf8")).toBe(text);
    expect(result.movedTo).toBe(path.join(dir, aside[0]));
    expect(fs.existsSync(file)).toBe(false);
    expect(heard).toEqual([[problem, path.join(dir, aside[0])]]);
    // Said once: the second read finds no file and no problem.
    expect((await reg.read()).problem).toBeUndefined();
    expect(heard).toHaveLength(1);
  });

  it("a listener that throws does not break the read", async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, "running.json"), "oops");
    const reg = new Registry(path.join(dir, "running.json"), {
      onProblem: () => {
        throw new Error("boom");
      },
    });
    expect((await reg.read()).problem).toBe("unreadable");
  });

  it("a missing file is an empty registry with no problem", async () => {
    const reg = new Registry(path.join(freshDir(), "running.json"));
    expect(await reg.read()).toEqual({ version: 1, entries: {} });
  });
});

describe("two entries for one slug (F10)", () => {
  it("only the newest is kept and the count of dropped ones is reported", async () => {
    const dir = freshDir();
    const file = path.join(dir, "running.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: {
          first: entry("build-dashboard", { pid: 4100, pgid: 4100, startedAt: 2_000 }),
          second: entry("build-dashboard", { pid: 4200, pgid: 4200, startedAt: 9_000, members: [{ pid: 4200, startTime: "x" }] }),
          third: entry("build-dashboard", { pid: 4300, pgid: 4300, startedAt: 5_000, members: [{ pid: 4300, startTime: "y" }] }),
          other: entry("live-captions"),
        },
      }),
    );
    const result = await new Registry(file).read();
    expect(Object.keys(result.entries).sort()).toEqual(["build-dashboard", "live-captions"]);
    expect(result.entries["build-dashboard"].pid).toBe(4200);
    expect(result.duplicatesDropped).toBe(2);
  });

  it("invalid entries among valid ones are dropped without disturbing the rest", async () => {
    const dir = freshDir();
    const file = path.join(dir, "running.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: { ok: entry("ok"), bad: { slug: "bad", pid: "x" }, "../escape": entry("../escape") } }));
    expect(Object.keys((await new Registry(file).read()).entries)).toEqual(["ok"]);
  });
});
