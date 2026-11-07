import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * F4: nothing restarts an app by itself. These read the source: the behavioural 60 s checks after a crash, a Stop and
 * an auto-stop are in kill-timer.test.ts and lifecycle-plugin.test.ts.
 */
const SRC = path.resolve(__dirname, "../../src");
const files = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ name: f, text: fs.readFileSync(path.join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "") }));

/** Calls that start an app: the manager's open, and the host's start/open hooks. */
const STARTS = /\b(?:instances|manager|host|actions|this)\.(?:open|start|openProject)\(|\bm\.open\(/;
/** Anything that runs code later or on a schedule. */
const TIMERS = /\bsetTimeout\(|\bsetInterval\(|\.after\(|registerInterval\(|\bonLayoutReady\(/;

describe("F4 no auto-restart code path", () => {
  it("the kill timer never starts anything: it only stops, and it only reads state otherwise", () => {
    const kill = files.find((f) => f.name === "kill-timer.ts")!.text;
    expect(kill).not.toMatch(/\.(open|start|openProject)\(/);
    expect(kill).toMatch(/\.stop\(/);
  });

  it("no file with a timer, interval or layout-ready hook calls a start path from inside it", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const lines = f.text.split("\n");
      lines.forEach((line, i) => {
        if (!TIMERS.test(line)) return;
        // The timer's callback is on its own line or the next few: look at that window.
        const window = lines.slice(i, i + 4).join("\n");
        if (STARTS.test(window)) offenders.push(`${f.name}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no interval and no registerInterval anywhere in src", () => {
    for (const f of files) expect(f.text, f.name).not.toMatch(/\bsetInterval\(|registerInterval\(/);
  });

  it("the only callers of the manager's open are the Open path and the panel's Start", () => {
    const callers = files.filter((f) => /\binstances\.open\(/.test(f.text)).map((f) => f.name);
    expect(callers).toEqual(["main.ts"]);
    const main = files.find((f) => f.name === "main.ts")!.text;
    const hits = [...main.matchAll(/this\.instances\.open\(/g)].length;
    expect(hits).toBe(2); // openProject (command, list) and the host's start (panel button)
    expect(main).toMatch(/start: \(slug\) => this\.instances\.open\(slug\)/);
  });

  it("the instance manager's exit handler on a crash does not call open or spawn again", () => {
    const inst = files.find((f) => f.name === "instance.ts")!.text;
    expect(inst).not.toMatch(/\bthis\.open\(/);
    expect(inst.match(/\bspawn\(/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
