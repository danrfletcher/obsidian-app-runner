import { Modal, type App } from "obsidian";

/**
 * E3: several local ports serve a web page, so ask which one is the app. Resolves with the chosen port, or null when
 * the dialog is dismissed or `signal` aborts (a Stop while the dialog is up closes it). The caller remembers the choice.
 */
export class PortPickerModal extends Modal {
  private resolve: (port: number | null) => void = () => {};
  private settled = false;
  readonly result: Promise<number | null>;

  constructor(app: App, private readonly appName: string, private readonly ports: readonly number[], signal?: AbortSignal) {
    super(app);
    this.result = new Promise((resolve) => (this.resolve = resolve));
    signal?.addEventListener("abort", () => this.settle(null), { once: true });
  }

  onOpen(): void {
    this.contentEl.createEl("h3", { text: `Which page is ${this.appName}?` });
    this.contentEl.createEl("p", { text: `${this.appName} is serving web pages on more than one local port. Pick the one to open. App Runner remembers it as this project's URL override.` });
    for (const port of this.ports) {
      const button = this.contentEl.createEl("button", { text: `http://127.0.0.1:${port}/`, cls: "mod-cta" });
      button.addEventListener("click", () => this.settle(port));
    }
  }

  onClose(): void {
    this.settle(null);
  }

  private settle(port: number | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(port);
    this.close();
  }
}
