import type { BrowserReaderDeps } from "../src/browser-poller";
import type { OsascriptResult } from "../src/browser-system";
import { lines } from "./fixtures/osascript-output";

/**
 * The system side of the browser poll, faked: which browser is the default, whether it is running, and what osascript
 * answers. Only these three are faked; the script text, the answer's parsing, the URL matching and the Held sequencing
 * are the real code. Every call is recorded, so a test can show that nothing was sent to a browser that is not running.
 */
export class FakeBrowser {
  /** The default browser's bundle id. */
  bundleId = "com.brave.Browser";
  running = false;
  /** What osascript answers next: a canned result, or a function that returns one. */
  answer: OsascriptResult | (() => OsascriptResult | Promise<OsascriptResult>) = lines();
  defaultError: Error | null = null;
  defaultReads = 0;
  runningChecks: string[] = [];
  /** Every osascript call, as the arguments it got. */
  scripts: string[][] = [];

  constructor(init: Partial<Pick<FakeBrowser, "bundleId" | "running" | "answer">> = {}) {
    Object.assign(this, init);
  }

  /** The browser is running and shows these tabs. */
  show(...urls: string[]): void {
    this.running = true;
    this.answer = lines(...urls);
  }

  get osascriptCalls(): number {
    return this.scripts.length;
  }

  deps(): BrowserReaderDeps {
    return {
      defaultBrowser: async () => {
        this.defaultReads++;
        if (this.defaultError) throw this.defaultError;
        return this.bundleId;
      },
      isRunning: async (bundleId) => {
        this.runningChecks.push(bundleId);
        return this.running && bundleId.toLowerCase() === this.bundleId.toLowerCase();
      },
      osascript: async (args) => {
        this.scripts.push(args);
        return typeof this.answer === "function" ? this.answer() : this.answer;
      },
    };
  }
}
