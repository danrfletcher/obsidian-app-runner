import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { loopbackGet } from "../../src/loopback-http";
import { Registry, type RegistryEntry } from "../../src/registry";
import { realRuntimeFs } from "../../src/runtime-fs";
import { logPath, registryPath, runtimeDir } from "../../src/runtime-paths";
import { createLogActions } from "../../src/show-log";

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "app-runner-files-"));
let server: http.Server | undefined;
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe("F16 runtime paths are outside the vault", () => {
  it("live under Application Support, per vault key", () => {
    expect(runtimeDir("abc-123", "/Users/dan")).toBe("/Users/dan/Library/Application Support/Obsidian App Runner/abc-123");
  });

  it("G17: the log is logs/<slug>.log and the registry is running.json", () => {
    expect(logPath("/rt", "live-captions")).toBe("/rt/logs/live-captions.log");
    expect(registryPath("/rt")).toBe("/rt/running.json");
  });

  it.each(["", ".", "..", "../x", "a/b", "a b", "k\u0000"])("a vault key or slug of %j is refused", (bad) => {
    expect(() => runtimeDir(bad, "/h")).toThrow(/Refusing/);
    expect(() => logPath("/rt", bad)).toThrow(/Refusing/);
  });
});

describe("Registry (a real file)", () => {
  const entry = (slug: string, pid = 10): RegistryEntry => ({ slug, pid, pgid: pid, members: [{ pid, startTime: "t" }], port: null, startedAt: 1 });

  it("round-trips entries, written whole with owner-only permissions", async () => {
    const file = path.join(tmp, "a", "running.json");
    const r = new Registry(file);
    await r.set(entry("one"));
    await r.set({ ...entry("two", 20), port: 3000 });
    expect(Object.keys((await r.read()).entries)).toEqual(["one", "two"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).entries.two.port).toBe(3000);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    await r.remove("one");
    expect(Object.keys((await r.read()).entries)).toEqual(["two"]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["running.json"]); // no temp file left behind
  });

  it("many writes at once all land (no lost update)", async () => {
    const r = new Registry(path.join(tmp, "b", "running.json"));
    await Promise.all(Array.from({ length: 25 }, (_, i) => r.set(entry(`p${i}`, i + 2))));
    expect(Object.keys((await r.read()).entries)).toHaveLength(25);
  });

  it("removing a missing entry or reading a missing file is fine", async () => {
    const r = new Registry(path.join(tmp, "c", "running.json"));
    expect(await r.read()).toEqual({ version: 1, entries: {} });
    await r.remove("nope");
    expect(fs.existsSync(path.join(tmp, "c", "running.json"))).toBe(false);
  });

  it("an unreadable file is moved aside, not overwritten", async () => {
    const dir = path.join(tmp, "d");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "running.json"), "{ not json");
    const r = new Registry(path.join(dir, "running.json"));
    await r.set(entry("one"));
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.startsWith("running.json.corrupt-"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, files.find((f) => f.startsWith("running.json.corrupt-"))!), "utf8")).toBe("{ not json");
    expect(Object.keys((await r.read()).entries)).toEqual(["one"]);
  });

  it("entries that fail validation are dropped on read", async () => {
    const dir = path.join(tmp, "e");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "running.json"), JSON.stringify({ version: 1, entries: { ok: entry("ok"), bad: { slug: "bad", pid: "x" }, liar: entry("other") } }));
    expect(Object.keys((await new Registry(path.join(dir, "running.json")).read()).entries)).toEqual(["ok"]);
  });
});

describe("realRuntimeFs", () => {
  it("readTail returns the last bytes, and empty for a missing file", async () => {
    const file = path.join(tmp, "log.txt");
    fs.writeFileSync(file, "0123456789");
    expect(await realRuntimeFs.readTail(file, 4)).toBe("6789");
    expect(await realRuntimeFs.readTail(file, 100)).toBe("0123456789");
    expect(await realRuntimeFs.readTail(path.join(tmp, "missing"), 4)).toBe("");
  });

  it("opening a log with 'w' truncates it; removeFile is quiet about a missing file", async () => {
    const file = path.join(tmp, "t.log");
    fs.writeFileSync(file, "old");
    realRuntimeFs.closeSync(realRuntimeFs.openSync(file, "w"));
    expect(fs.readFileSync(file, "utf8")).toBe("");
    await realRuntimeFs.removeFile(file);
    await realRuntimeFs.removeFile(file);
    expect(realRuntimeFs.exists(file)).toBe(false);
    expect(realRuntimeFs.isDirectory(tmp)).toBe(true);
    expect(realRuntimeFs.isDirectory(path.join(tmp, "nope"))).toBe(false);
  });
});

describe("loopbackGet (F6, F8)", () => {
  async function serve(handler: http.RequestListener) {
    server = http.createServer(handler);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return (server.address() as { port: number }).port;
  }
  const signal = () => new AbortController().signal;

  it("resolves on headers with status and content-type, for any status", async () => {
    const port = await serve((_q, r) => {
      r.statusCode = 404;
      r.setHeader("content-type", "text/html");
      r.end("nope");
    });
    const res = await loopbackGet(`http://127.0.0.1:${port}/`, { signal: signal() });
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(res.headers.get("x-missing")).toBeNull();
  });

  it("does not follow a redirect off loopback", async () => {
    const port = await serve((_q, r) => {
      r.statusCode = 302;
      r.setHeader("location", "http://example.com/");
      r.end();
    });
    expect((await loopbackGet(`http://127.0.0.1:${port}/`, { signal: signal() })).status).toBe(302);
  });

  it("rejects a refused connection", async () => {
    const port = await serve((_q, r) => r.end());
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    await expect(loopbackGet(`http://127.0.0.1:${port}/`, { signal: signal() })).rejects.toThrow();
  });

  it("an abort cancels a request that never answers", async () => {
    const port = await serve(() => {});
    const c = new AbortController();
    const pending = loopbackGet(`http://127.0.0.1:${port}/`, { signal: c.signal });
    setTimeout(() => c.abort(), 20);
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it.each(["http://example.com/", "http://192.168.1.5:3000/", "http://0.0.0.0:3000/", "ftp://127.0.0.1/", "file:///etc/passwd", "http://127.0.0.1.evil.com/", "not a url"])(
    "refuses %s before opening a socket",
    async (url) => {
      await expect(loopbackGet(url, { signal: signal() })).rejects.toThrow(/Refusing/);
    },
  );
});

describe("G17 Show log", () => {
  function make(existing: string[], failOpen = false) {
    const calls: string[] = [];
    const notices: string[] = [];
    const logs = createLogActions({
      runtimeDir: "/rt",
      exists: (f) => existing.includes(f),
      shell: {
        openPath: async (f) => (calls.push(`open ${f}`), failOpen ? "no app" : ""),
        showItemInFolder: (f) => void calls.push(`reveal ${f}`),
      },
      notify: (m) => void notices.push(m),
    });
    return { logs, calls, notices };
  }

  it("opens the log file with the system app", async () => {
    const { logs, calls } = make(["/rt/logs/a.log"]);
    expect(logs.exists("a")).toBe(true);
    await logs.show("a");
    expect(calls).toEqual(["open /rt/logs/a.log"]);
  });

  it("reveals it in Finder when it cannot be opened", async () => {
    const { logs, calls } = make(["/rt/logs/a.log"], true);
    await logs.show("a");
    expect(calls).toEqual(["open /rt/logs/a.log", "reveal /rt/logs/a.log"]);
  });

  it("says so when there is no log, and opens nothing", async () => {
    const { logs, calls, notices } = make([]);
    expect(logs.exists("a")).toBe(false);
    await logs.show("a");
    expect(calls).toEqual([]);
    expect(notices).toHaveLength(1);
  });
});
