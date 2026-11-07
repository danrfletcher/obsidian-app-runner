import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { InstanceEvent } from "./instance";
import type { Project } from "./project";
import { stoppedPanelModel, type StoppedCause } from "./stopped-panel";
import { isLoopbackUrl } from "./validation";

export const VIEW_TYPE_APP = "app-runner-view";

/** What the tab needs from the plugin. */
export interface ViewHost {
  getProject(slug: string): Project | undefined;
  isWebviewAvailable(): boolean;
  /** The loopback URL of the project's running app, or undefined when it is not running. */
  instanceUrl?(slug: string): string | undefined;
  /** Open a URL in the default browser. */
  openExternal(url: string): void;
  notify(message: string): void;
  /** Hear about instances changing and ending (G8, G9). Returns the unsubscribe. */
  subscribe?(listener: (event: InstanceEvent) => void): () => void;
  /** The panel's Start button: the same start path as the Open command, without opening a tab of its own (G9). */
  start?(slug: string): Promise<unknown>;
  /** The last lines of the project's log, for the App stopped panel. */
  logTail?(slug: string): Promise<string[]>;
  /** A tab's saved state changed or it opened: the plugin re-counts sessions (G14). */
  sessionsChanged?(): void;
}

/** The slice of `document` the availability check reads, so tests can supply both outcomes. */
export interface WebviewProbeEnv {
  customElements?: { get(name: string): unknown };
  createElement(tag: string): unknown;
}

/**
 * E18: Electron only provides `<webview>` when the window was created with `webviewTag`. When it was not, the tag is an
 * unknown element: no `webview` custom element is defined and the element has no `getWebContentsId`.
 */
export function isWebviewAvailable(env?: WebviewProbeEnv): boolean {
  const e: WebviewProbeEnv = env ?? {
    customElements: typeof customElements === "undefined" ? undefined : customElements,
    createElement: (tag) => document.createElement(tag),
  };
  try {
    if (e.customElements?.get("webview") !== undefined) return true;
    const el = e.createElement("webview") as { getWebContentsId?: unknown } | null;
    return typeof el?.getWebContentsId === "function";
  } catch {
    return false;
  }
}

/**
 * The URL a tab loads: the running app's URL when the host knows one, else the project's URL override. It is re-checked
 * here, so a `src` is never anything but a loopback URL even if data.json was edited by hand (F6, F8). null when there
 * is nothing to show.
 */
export function webviewUrl(project: Project, instanceUrl?: string): string | null {
  for (const candidate of [instanceUrl, project.urlOverride]) {
    const url = candidate?.trim() ?? "";
    if (url !== "" && isLoopbackUrl(url)) return url;
  }
  return null;
}

/** What the tab shows: the app, the App stopped panel, or a plain message. */
type Mode = "app" | "stopped" | "message";

/** G11: one tab, one `<webview>`. The view state is the slug only; the URL is read from the instance at load. */
export class AppRunnerView extends ItemView {
  private slug = "";
  private mode: Mode = "message";
  private unsubscribe: (() => void) | null = null;
  /** Bumped by every render, so a panel waiting for the log does not draw over a newer page. */
  private renderToken = 0;
  /** True while the panel's Start is running, so a second click starts nothing. */
  private starting = false;

  constructor(leaf: WorkspaceLeaf, private readonly host: ViewHost) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_APP;
  }

  getDisplayText(): string {
    return this.host.getProject(this.slug)?.name ?? "App Runner";
  }

  getIcon(): string {
    return "app-window";
  }

  getState(): Record<string, unknown> {
    return { slug: this.slug };
  }

  async onOpen(): Promise<void> {
    this.listen();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.renderToken++;
  }

  private listen(): void {
    if (this.unsubscribe || !this.host.subscribe) return;
    // The promise is returned so a caller that awaits the listener (tests do) waits for the redraw too.
    this.unsubscribe = this.host.subscribe((event) => this.onInstanceEvent(event).catch(() => undefined));
  }

  /** Called when the tab is opened, restored or duplicated: the URL is looked up now, so a changed port is followed. */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const slug = (state as { slug?: unknown } | null)?.slug;
    this.slug = typeof slug === "string" ? slug : "";
    this.listen();
    await this.renderPage();
    this.host.sessionsChanged?.();
    await super.setState(state, result);
  }

  /**
   * G8, G9: a Stop or a crash of this tab's app switches it to the App stopped panel (the page is gone either way).
   * When the app is running again, a tab on the panel reloads into it (G9). A failed start changes nothing here: the
   * start-failure notice already told the user, and a tab never opened for it.
   */
  async onInstanceEvent(event: InstanceEvent): Promise<void> {
    if (event.slug !== this.slug || this.slug === "") return;
    if (event.type === "ended") {
      if (event.cause === "start-failed" || this.mode === "message") return;
      await this.showStopped(event.cause === "crashed" ? "crashed" : "requested");
    } else if (this.mode === "stopped" && this.host.instanceUrl?.(this.slug) !== undefined) {
      await this.renderPage();
    }
  }

  /** The project list changed (a rename, a delete): redraw a panel so it names the project, or drops Start when it is gone. */
  async refresh(): Promise<void> {
    if (this.mode === "stopped") await this.showStopped("not-running");
  }

  private async renderPage(): Promise<void> {
    this.renderToken++;
    this.contentEl.empty();
    const project = this.host.getProject(this.slug);
    if (!project) {
      this.mode = "message";
      this.showMessage("This project no longer exists in App Runner settings. Close this tab.");
      return;
    }
    // With an instance source the URL comes from the instance only (E19): a stopped app's old override is not a page.
    const live = this.host.instanceUrl?.(this.slug);
    const url = this.host.instanceUrl ? (live === undefined ? null : webviewUrl(project, live)) : webviewUrl(project);
    if (url === null) {
      await this.showStopped("not-running");
      return;
    }
    if (!this.host.isWebviewAvailable()) {
      // E18: nothing is rendered; the page opens in the default browser and the tab closes.
      this.mode = "message";
      this.host.notify(`This Obsidian window cannot embed web pages (webview is unavailable), so ${project.name} opened in your default browser instead.`);
      this.host.openExternal(url);
      this.leaf.detach();
      return;
    }
    this.mode = "app";
    const el = this.contentEl.createEl("webview" as "div", { cls: "app-runner-webview" });
    el.setAttribute("partition", "persist:app-runner");
    el.setAttribute("src", url);
  }

  private showMessage(text: string): void {
    this.contentEl.createDiv({ cls: "app-runner-message", text });
  }

  /** The App stopped panel (G8, G9, E13): what happened, the last 10 log lines, and Start unless the project is gone. */
  private async showStopped(cause: StoppedCause): Promise<void> {
    const token = ++this.renderToken;
    this.mode = "stopped";
    const project = this.host.getProject(this.slug);
    let lines: string[] = [];
    if (project && this.host.logTail) {
      try {
        lines = await this.host.logTail(this.slug);
      } catch {
        lines = [];
      }
    }
    if (token !== this.renderToken) return; // something newer was drawn while the log was read
    const model = stoppedPanelModel(project?.name, cause, lines);
    this.contentEl.empty();
    const panel = this.contentEl.createDiv({ cls: "app-runner-stopped" });
    panel.createEl("h3", { text: model.heading });
    panel.createEl("p", { text: model.message });
    if (model.logLines.length > 0) {
      panel.createEl("p", { cls: "app-runner-stopped-label", text: "Last lines of the log:" });
      panel.createEl("pre", { cls: "app-runner-log", text: model.logLines.join("\n") });
    }
    if (model.canStart && this.host.start) {
      const button = panel.createEl("button", { cls: "mod-cta", text: "Start" });
      button.addEventListener("click", () => void this.start(button));
    }
  }

  /** G9: Start runs the Open path; the tab reloads into the app when the instance reports it is running. */
  private async start(button: HTMLButtonElement): Promise<void> {
    if (this.starting || !this.host.start) return;
    this.starting = true;
    button.disabled = true;
    try {
      await this.host.start(this.slug);
    } catch {
      // The start path reports its own failures with a notice.
    } finally {
      this.starting = false;
      button.disabled = false;
    }
  }
}
