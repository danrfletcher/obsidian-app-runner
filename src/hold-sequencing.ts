import type { Clock } from "./clock";
import type { BrowserReadResult } from "./browser-poller";
import { HELD_AUTOMATION_DENIED, HELD_BROWSER_UNREADABLE, HELD_BROWSER_UNSUPPORTED, HELD_OPENED_IN_BROWSER } from "./held";

/** G12: how long after the first successful tab read an app opened in the browser is held while no tab of it is seen. */
export const HOLD_MS = 30_000;

/** The reasons that mean the browser cannot be read (as opposed to the pop-out hold itself). */
export const PROBLEM_REASONS: readonly string[] = [HELD_BROWSER_UNSUPPORTED, HELD_AUTOMATION_DENIED, HELD_BROWSER_UNREADABLE];

/**
 * `pending`: no successful tab read yet since the app was opened in the browser. `timing`: the 30 s clock is running.
 * `over`: the hold has ended and the normal rule applies (the 15 s grace when sessions are zero).
 */
export type HoldPhase = "pending" | "timing" | "over";

export interface HoldSequencerDeps {
  clock: Clock;
  /** Something observable changed: the tab count, the problem or the phase. Called after the state is updated, once per event. */
  onChange(): void;
  holdMs?: number;
}

export interface HoldInitial {
  /** The hold is still in progress (the instance was Held when this started watching it). Otherwise it has ended. */
  holding: boolean;
  /** A problem reason carried over from the registry, so a permanent denial survives a relaunch. */
  problem?: string | null;
}

/**
 * G12, G13: the Held sequencing for one app that is expected in the browser. The poller's results go in; out come the
 * browser tab count, the Held reason to show (or none), and when the 15 s grace may begin.
 *
 * - Opened in the browser: Held (`opened-in-browser`) with the hold `pending`. Nothing starts a clock until a poll reads
 *   the browser successfully (a browser that is not running, or cannot be read, is not a read).
 * - The first successful read starts the 30 s clock. A tab of the app seen by any successful read ends the hold at once.
 *   Thirty seconds after the first read with none seen, the hold ends too; Held clears and, with no Obsidian tab open,
 *   the kill timer starts its 15 s grace.
 * - A browser that cannot be read (unsupported, a read error) shows its reason and holds the app until a read works;
 *   the hold clock does not start and a running clock keeps running. A denied permission is permanent: nothing after
 *   it changes the reason, and the monitor stops polling.
 * - Opening the app in the browser again (`begin`) starts a fresh hold.
 */
export class HoldSequencer {
  private phase: HoldPhase;
  private problem: string | null;
  private tabCount = 0;
  private cancelTimer: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly deps: HoldSequencerDeps,
    initial: HoldInitial,
  ) {
    this.phase = initial.holding ? "pending" : "over";
    this.problem = initial.problem && PROBLEM_REASONS.includes(initial.problem) ? initial.problem : null;
  }

  get holdPhase(): HoldPhase {
    return this.phase;
  }

  /** Browser tabs on the instance's port, from the last poll that could read. Zero when unreadable or not running. */
  get tabs(): number {
    return this.tabCount;
  }

  /** The permission was denied: permanent for this instance. */
  get denied(): boolean {
    return this.problem === HELD_AUTOMATION_DENIED;
  }

  get problemReason(): string | null {
    return this.problem;
  }

  /** The Held reason to show now, or null when the app is not Held for the browser. */
  get heldReason(): string | null {
    if (this.problem) return this.problem;
    return this.phase === "over" ? null : HELD_OPENED_IN_BROWSER;
  }

  get hasPendingTimer(): boolean {
    return this.cancelTimer !== null;
  }

  /** The app was opened in the browser (again): a fresh hold, with no clock until the next successful read. */
  begin(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.phase = "pending";
    this.deps.onChange();
  }

  apply(result: BrowserReadResult): void {
    if (this.disposed || this.denied) return;
    switch (result.kind) {
      case "denied":
        this.problem = HELD_AUTOMATION_DENIED;
        this.tabCount = 0;
        break;
      case "unsupported":
        this.problem = HELD_BROWSER_UNSUPPORTED;
        this.tabCount = 0;
        break;
      case "error":
        this.problem = HELD_BROWSER_UNREADABLE;
        this.tabCount = 0;
        break;
      case "not-running":
        // Readable in the sense that nothing is wrong: no tabs. It is not a read, so no clock starts.
        this.problem = null;
        this.tabCount = 0;
        break;
      case "tabs":
        this.problem = null;
        this.tabCount = result.count;
        if (result.count > 0) this.endHold();
        else if (this.phase === "pending") this.startClock();
        break;
    }
    this.deps.onChange();
  }

  private startClock(): void {
    this.phase = "timing";
    this.cancelTimer = this.deps.clock.after(this.deps.holdMs ?? HOLD_MS, () => {
      this.cancelTimer = null;
      if (this.disposed || this.phase !== "timing") return;
      this.phase = "over";
      this.deps.onChange();
    });
  }

  private endHold(): void {
    this.clearTimer();
    this.phase = "over";
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }
}
