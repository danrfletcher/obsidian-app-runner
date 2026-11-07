import type { InstanceInfo, InstanceState } from "./instance";
import { heldReasonText } from "./held";

/** G7: how a row says the app outlived the last Obsidian session. */
export const STILL_RUNNING_TEXT = "Still running from last session";

/** One row of the running list (G7), with every cell already worded. */
export interface RunningRow {
  slug: string;
  name: string;
  state: InstanceState;
  /** Shown as-is: the port, or a dash while there is none yet. */
  portText: string;
  startedAt: number;
  startedText: string;
  /** "N tabs" for Obsidian tabs, or "Held: <reason>" when the instance is Held. */
  sessionsText: string;
  /** Open adds a tab, so it needs a running app. */
  canOpen: boolean;
  /** Stop is available while starting (it cancels) and running; not once it is already stopping. */
  canStop: boolean;
  /** Show log is disabled when no log file exists (G17). */
  canShowLog: boolean;
  /** G7: found in the registry at launch; the row says "Still running from last session". */
  adopted: boolean;
}

export interface RowInputs {
  sessions(slug: string): number;
  logExists(slug: string): boolean;
  /** How a start time is worded. Defaults to local HH:MM:SS. */
  formatTime?(ms: number): string;
}

/** Local time as HH:MM:SS. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** "1 tab", "2 tabs". */
export function tabsText(count: number): string {
  return `${count} ${count === 1 ? "tab" : "tabs"}`;
}

/** The sessions cell: a Held instance says Held and why (the reason code worded by `heldReasonText`); otherwise the count of Obsidian tabs. */
export function sessionsText(info: Pick<InstanceInfo, "held" | "heldReason">, count: number): string {
  if (!info.held) return tabsText(count);
  const reason = heldReasonText(info.heldReason);
  return reason === "" ? "Held" : `Held: ${reason}`;
}

/**
 * G7: the running list as rows, oldest start first. Instances that started in the same millisecond keep the order they
 * were given in (a stable sort), so rows do not jump when something else changes.
 */
export function buildRunningRows(infos: readonly InstanceInfo[], inputs: RowInputs): RunningRow[] {
  const format = inputs.formatTime ?? clockTime;
  return infos
    .map((info, index) => ({ info, index }))
    .sort((a, b) => a.info.startedAt - b.info.startedAt || a.index - b.index)
    .map(({ info }) => ({
      slug: info.slug,
      name: info.name,
      state: info.state,
      portText: info.port === null ? "–" : String(info.port),
      startedAt: info.startedAt,
      startedText: format(info.startedAt),
      sessionsText: sessionsText(info, inputs.sessions(info.slug)),
      canOpen: info.state === "running",
      canStop: info.state !== "stopping",
      canShowLog: inputs.logExists(info.slug),
      adopted: info.adopted,
    }));
}

/** The one-line summary under a row's name. */
export function rowSummary(row: RunningRow): string {
  const summary = `${row.state}  ·  port ${row.portText}  ·  started ${row.startedText}  ·  ${row.sessionsText}`;
  return row.adopted ? `${summary}  ·  ${STILL_RUNNING_TEXT}` : summary;
}
