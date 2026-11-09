import { lastLogLines, NOTICE_LINE_MAX } from "./start-notices";

/** How many log lines the App stopped panel shows (G9). */
export const PANEL_LOG_LINES = 10;
/** How much of the end of the log is read; plenty for ten lines. */
export const PANEL_LOG_BYTES = 64 * 1024;

/**
 * The last 10 lines of the project's log for the App stopped panel: fewer when the log is short, none when it is
 * missing or empty. A very long line is cut and colour codes are removed (same cleaning as the start-failure notice).
 */
export async function readLogTail(fs: { readTail(file: string, bytes: number): Promise<string> }, logFile: string): Promise<string[]> {
  let text = "";
  try {
    text = await fs.readTail(logFile, PANEL_LOG_BYTES);
  } catch {
    return [];
  }
  return lastLogLines(text, PANEL_LOG_LINES, NOTICE_LINE_MAX);
}

/**
 * Why the panel is up. `waiting` and `checking` are not stops: the app is running but has no web port yet (an app adopted
 * mid-start), or the launch check for apps left running is not finished. Neither offers Start (there is nothing to start).
 */
export type StoppedCause = "requested" | "crashed" | "not-running" | "waiting" | "checking";

export interface StoppedPanelModel {
  heading: string;
  message: string;
  logLines: string[];
  /** False when the project no longer exists: there is nothing to start. */
  canStart: boolean;
}

/** What the App stopped panel says. A deleted project gets a plain message and no Start button. */
export function stoppedPanelModel(projectName: string | undefined, cause: StoppedCause, logLines: readonly string[]): StoppedPanelModel {
  if (projectName === undefined) {
    return {
      heading: "App stopped",
      message: "This project no longer exists in App Runner settings. Close this tab.",
      logLines: [],
      canStart: false,
    };
  }
  if (cause === "waiting" || cause === "checking") {
    return cause === "waiting"
      ? { heading: `Waiting for ${projectName}`, message: `${projectName} is running but has not opened a web port yet. This tab loads it as soon as it does.`, logLines: [...logLines], canStart: false }
      : { heading: `Checking ${projectName}`, message: `Checking whether ${projectName} is still running from the last session.`, logLines: [], canStart: false };
  }
  const message =
    cause === "crashed" ? `${projectName} stopped on its own.` : cause === "requested" ? `${projectName} was stopped.` : `${projectName} is not running.`;
  return { heading: "App stopped", message, logLines: [...logLines], canStart: true };
}
