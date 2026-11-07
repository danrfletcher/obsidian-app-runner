import { describe, expect, it } from "vitest";
import { classifyLog, lastLogLines, startFailureNotice, type StartFailure } from "../../src/start-notices";

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

describe("lastLogLines", () => {
  it("returns the last 10 of a longer log", () => {
    expect(lastLogLines(lines(25))).toEqual(Array.from({ length: 10 }, (_, i) => `line ${i + 16}`));
  });

  it("returns all of a shorter log, in order", () => {
    expect(lastLogLines(lines(3))).toEqual(["line 1", "line 2", "line 3"]);
  });

  it("returns exactly 10 of a 10-line log", () => {
    expect(lastLogLines(lines(10))).toHaveLength(10);
  });

  it("an empty or blank log gives no lines", () => {
    expect(lastLogLines("")).toEqual([]);
    expect(lastLogLines("\n\n   \n")).toEqual([]);
  });

  it("drops blank lines and a trailing newline", () => {
    expect(lastLogLines("a\n\n\nb\n")).toEqual(["a", "b"]);
  });

  it("cuts a very long line to 200 characters with an ellipsis", () => {
    const [out] = lastLogLines("x".repeat(5000));
    expect(out).toHaveLength(200);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, 199)).toBe("x".repeat(199));
  });

  it("leaves a 200-character line alone", () => {
    expect(lastLogLines("y".repeat(200))[0]).toBe("y".repeat(200));
  });

  it("strips colour codes, carriage returns and control characters", () => {
    expect(lastLogLines("\u001b[31mred\u001b[0m text\r\nplain\u0007 bell\r\nprogress 10%\rprogress 100%")).toEqual([
      "red text",
      "plain bell",
      "progress 10%",
      "progress 100%",
    ]);
  });
});

describe("classifyLog", () => {
  it.each([
    ["Error: listen EADDRINUSE: address already in use 127.0.0.1:8957", "address-in-use"],
    ["OSError: [Errno 48] Address already in use", "address-in-use"],
    ["zsh:1: command not found: nope", "command-not-found"],
    ["sh: nope: command not found", "command-not-found"],
    ["Server started", null],
    ["", null],
  ])("%s -> %s", (text, cause) => {
    expect(classifyLog(text)).toBe(cause);
  });

  it("address in use outranks command not found", () => {
    expect(classifyLog("command not found: x\nEADDRINUSE")).toBe("address-in-use");
  });
});

describe("startFailureNotice", () => {
  const name = "Live Captions";
  const notice = (failure: StartFailure, log = "") => startFailureNotice(name, failure, log);

  it("E1: names the folder, carries no log lines", () => {
    expect(notice({ kind: "folder-missing", folder: "/Users/dan/Developer/live-captions" })).toBe(
      "Live Captions was not started: its folder /Users/dan/Developer/live-captions is missing or has moved. Fix the folder in App Runner settings.",
    );
  });

  it("E2: command not found says so and carries the log lines", () => {
    expect(notice({ kind: "exited" }, "zsh:1: command not found: nope\n")).toBe(
      "Live Captions could not start: the command was not found in your login shell's PATH.\n\nLast lines of the log:\nzsh:1: command not found: nope",
    );
  });

  it("E3: a start that timed out says 60 seconds and carries the last 10 lines (G6)", () => {
    const text = notice({ kind: "timeout" }, lines(30));
    expect(text.startsWith("Live Captions did not answer on any local web port within 60 seconds, so it was stopped.\n\nLast lines of the log:\n")).toBe(true);
    expect(text.split("\n").slice(-10)).toEqual(Array.from({ length: 10 }, (_, i) => `line ${i + 21}`));
    expect(text).not.toContain("line 20\n");
  });

  it("G6: every process exited before a port answered", () => {
    expect(notice({ kind: "exited" }, "starting...\nboom")).toBe("Live Captions stopped before it was ready.\n\nLast lines of the log:\nstarting...\nboom");
  });

  it("E4: address in use is named and says the other program was left alone", () => {
    const text = notice({ kind: "exited" }, "Error: listen EADDRINUSE: address already in use 127.0.0.1:8957");
    expect(text).toContain("its port is already in use by another program");
    expect(text).toContain("left that program alone");
    expect(text).toContain("EADDRINUSE");
  });

  it("E16: a blocked .zshrc times out with the banner lines from the log in the notice", () => {
    const text = notice({ kind: "timeout" }, "Welcome back, Dan\nPress enter to continue:");
    expect(text).toContain("within 60 seconds");
    expect(text.endsWith("Last lines of the log:\nWelcome back, Dan\nPress enter to continue:")).toBe(true);
  });

  it("an empty log says so instead of listing nothing", () => {
    expect(notice({ kind: "exited" }, "")).toBe("Live Captions stopped before it was ready.\n\nThe log is empty.");
  });

  it("a shorter log lists only the lines it has", () => {
    expect(notice({ kind: "timeout" }, "one\ntwo")).toMatch(/Last lines of the log:\none\ntwo$/);
  });

  it("very long lines are cut in the notice", () => {
    const text = notice({ kind: "exited" }, `${"z".repeat(10_000)}\nend`);
    expect(text.length).toBeLessThan(400);
  });

  it("a spawn failure, a registry failure and an internal error all name the project and keep the log", () => {
    expect(notice({ kind: "spawn-failed", message: "spawn /bin/zsh ENOENT" }, "x")).toContain("could not be started: spawn /bin/zsh ENOENT");
    expect(notice({ kind: "registry-failed" }, "x")).toContain("could not record it");
    expect(notice({ kind: "internal", message: "oops" }, "x")).toContain("could not be started: oops");
  });
});
