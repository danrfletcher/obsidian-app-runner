import { describe, expect, it } from "vitest";
import { PANEL_LOG_LINES, readLogTail, stoppedPanelModel } from "../../src/stopped-panel";
import { NOTICE_LINE_MAX } from "../../src/start-notices";

/** A log "file" in memory, read the way the real tail reader is: the last `bytes` bytes. */
const fsWith = (content: string | null) => ({
  readTail: async (_file: string, bytes: number) => {
    if (content === null) return ""; // missing: the real reader answers with nothing
    return content.length > bytes ? content.slice(content.length - bytes) : content;
  },
});

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

describe("the log tail for the App stopped panel (G9)", () => {
  it("returns the last 10 lines of a longer log, in order", async () => {
    expect(PANEL_LOG_LINES).toBe(10);
    const tail = await readLogTail(fsWith(lines(25).join("\n") + "\n"), "/x.log");
    expect(tail).toEqual(lines(25).slice(15));
    expect(tail).toHaveLength(10);
  });

  it("returns all of a short log", async () => {
    expect(await readLogTail(fsWith("one\ntwo\nthree\n"), "/x.log")).toEqual(["one", "two", "three"]);
    expect(await readLogTail(fsWith(lines(10).join("\n")), "/x.log")).toEqual(lines(10));
  });

  it("returns nothing for a log that is missing or empty", async () => {
    expect(await readLogTail(fsWith(null), "/missing.log")).toEqual([]);
    expect(await readLogTail(fsWith(""), "/x.log")).toEqual([]);
    expect(await readLogTail(fsWith("\n\n   \n"), "/x.log")).toEqual([]);
  });

  it("cuts a very long single line, so one line cannot fill the panel", async () => {
    const huge = "x".repeat(50_000);
    const tail = await readLogTail(fsWith(`before\n${huge}\n`), "/x.log");
    expect(tail).toHaveLength(2);
    expect(tail[0]).toBe("before");
    expect(tail[1].length).toBeLessThanOrEqual(NOTICE_LINE_MAX);
    expect(tail[1].endsWith("…")).toBe(true);
  });

  it("drops blank lines and colour codes", async () => {
    expect(await readLogTail(fsWith("\u001b[31mred\u001b[0m\n\n\nplain\r\n"), "/x.log")).toEqual(["red", "plain"]);
  });

  it("an unreadable log gives no lines instead of an error", async () => {
    const failing = {
      readTail: async () => {
        throw new Error("EACCES");
      },
    };
    expect(await readLogTail(failing, "/x.log")).toEqual([]);
  });

  it("asks the reader for the file it was given", async () => {
    const asked: string[] = [];
    await readLogTail({ readTail: async (f) => (asked.push(f), "") }, "/runtime/logs/live-captions.log");
    expect(asked).toEqual(["/runtime/logs/live-captions.log"]);
  });
});

describe("what the panel says", () => {
  it.each([
    ["crashed", "Live Captions stopped on its own."],
    ["requested", "Live Captions was stopped."],
    ["not-running", "Live Captions is not running."],
  ] as const)("%s", (cause, message) => {
    expect(stoppedPanelModel("Live Captions", cause, ["a", "b"])).toEqual({ heading: "App stopped", message, logLines: ["a", "b"], canStart: true });
  });

  it("for a deleted project it is a plain message with no Start and no log", () => {
    expect(stoppedPanelModel(undefined, "crashed", ["old line"])).toEqual({
      heading: "App stopped",
      message: "This project no longer exists in App Runner settings. Close this tab.",
      logLines: [],
      canStart: false,
    });
  });
});
