/** How many log lines a start-failure notice carries (G6). */
export const NOTICE_LOG_LINES = 10;
/** A log line longer than this is cut, so one huge line cannot fill the notice. */
export const NOTICE_LINE_MAX = 200;

// eslint-disable-next-line no-control-regex -- matches the ESC and BEL control characters of ANSI colour sequences
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
// eslint-disable-next-line no-control-regex -- strips control characters from log lines before they go in a notice
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * The last `max` non-empty lines of the log, colour codes and control characters removed, each cut to `maxLength`
 * characters. A log with fewer lines gives them all; an empty log gives none.
 */
export function lastLogLines(text: string, max: number = NOTICE_LOG_LINES, maxLength: number = NOTICE_LINE_MAX): string[] {
  const lines = text
    .replace(ANSI, "")
    .split(/\r?\n|\r/)
    .map((l) => l.replace(CONTROL, "").trimEnd())
    .filter((l) => l.trim() !== "");
  return lines.slice(-max).map((l) => (l.length > maxLength ? `${l.slice(0, maxLength - 1)}…` : l));
}

export type LogCause = "address-in-use" | "command-not-found" | null;

/** What the log says about why the app stopped: its port was taken (E4), or the shell could not find the command (E2). */
export function classifyLog(text: string): LogCause {
  if (/EADDRINUSE|address already in use|address in use/i.test(text)) return "address-in-use";
  if (/command not found|: not found\b/i.test(text)) return "command-not-found";
  return null;
}

export type StartFailure =
  | { kind: "folder-missing"; folder: string }
  // Every process in the group exited before a port answered (G6, E2, E4).
  | { kind: "exited" }
  // 60 s passed with no loopback port answering (E3, E16).
  | { kind: "timeout" }
  | { kind: "spawn-failed"; message: string }
  | { kind: "registry-failed"; message?: string }
  | { kind: "internal"; message: string };

function withLog(headline: string, logText: string): string {
  const lines = lastLogLines(logText);
  if (lines.length === 0) return `${headline}\n\nThe log is empty.`;
  return `${headline}\n\nLast lines of the log:\n${lines.join("\n")}`;
}

/** The notice for a start that failed. Always names the project; carries the last log lines when there is a log. */
export function startFailureNotice(name: string, failure: StartFailure, logText: string): string {
  switch (failure.kind) {
    case "folder-missing":
      return `${name} was not started: its folder ${failure.folder} is missing or has moved. Fix the folder in App Runner settings.`;
    case "spawn-failed":
      return withLog(`${name} could not be started: ${failure.message}`, logText);
    case "registry-failed": {
      const why = failure.message ? ` (${failure.message.replace(/\s+/g, " ").slice(0, 200)})` : "";
      return withLog(`${name} was stopped because App Runner could not record it${why}, and an app it cannot track must not keep running.`, logText);
    }
    case "internal":
      return withLog(`${name} could not be started: ${failure.message}`, logText);
    case "exited":
    case "timeout": {
      const cause = classifyLog(logText);
      if (cause === "address-in-use") {
        return withLog(`${name} could not start: its port is already in use by another program. App Runner left that program alone.`, logText);
      }
      if (cause === "command-not-found") {
        return withLog(`${name} could not start: the command was not found in your login shell's PATH.`, logText);
      }
      if (failure.kind === "exited") return withLog(`${name} stopped before it was ready.`, logText);
      return withLog(`${name} did not answer on any local web port within 60 seconds, so it was stopped.`, logText);
    }
  }
}
