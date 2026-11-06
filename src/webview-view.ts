import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { Project } from "./project";
import { isLoopbackUrl } from "./validation";

export const VIEW_TYPE_APP = "app-runner-view";

/** What the tab needs from the plugin. */
export interface ViewHost {
  getProject(slug: string): Project | undefined;
  isWebviewAvailable(): boolean;
  /** Open a URL in the default browser. */
  openExternal(url: string): void;
  notify(message: string): void;
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
 * The URL a tab loads: the project's override. It is re-checked here, so a `src` is never anything but a loopback URL
 * even if data.json was edited by hand (F6, F8). null when there is nothing to show yet.
 */
export function webviewUrl(project: Project): string | null {
  const url = project.urlOverride.trim();
  return url !== "" && isLoopbackUrl(url) ? url : null;
}

/** G11: one tab, one `<webview>`. The view state is the slug only; the URL is read from project settings at load. */
export class AppRunnerView extends ItemView {
  private slug = "";

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

  /** Called when the tab is opened, restored or duplicated: the URL is looked up now, so a changed override is followed. */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const slug = (state as { slug?: unknown } | null)?.slug;
    this.slug = typeof slug === "string" ? slug : "";
    this.renderPage();
    await super.setState(state, result);
  }

  private renderPage(): void {
    this.contentEl.empty();
    const project = this.host.getProject(this.slug);
    if (!project) {
      this.showMessage("This project no longer exists in App Runner settings. Close this tab.");
      return;
    }
    const url = webviewUrl(project);
    if (url === null) {
      this.showMessage(`${project.name} has no page to show yet. Starting apps arrives in a later update; set a URL override in the project settings to open a page now.`);
      return;
    }
    if (!this.host.isWebviewAvailable()) {
      // E18: nothing is rendered; the page opens in the default browser and the tab closes.
      this.host.notify(`This Obsidian window cannot embed web pages (webview is unavailable), so ${project.name} opened in your default browser instead.`);
      this.host.openExternal(url);
      this.leaf.detach();
      return;
    }
    const el = this.contentEl.createEl("webview" as "div", { cls: "app-runner-webview" });
    el.setAttribute("partition", "persist:app-runner");
    el.setAttribute("src", url);
  }

  private showMessage(text: string): void {
    this.contentEl.createDiv({ cls: "app-runner-message", text });
  }
}
