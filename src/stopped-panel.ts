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

export type StoppedCause = "requested" | "crashed" | "not-running";

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
  const message =
    cause === "crashed" ? `${projectName} stopped on its own.` : cause === "requested" ? `${projectName} was stopped.` : `${projectName} is not running.`;
  return { heading: "App stopped", message, logLines: [...logLines], canStart: true };
}
