import { Notice, Platform, Plugin, type WorkspaceLeaf } from "obsidian";
import { ProjectCommands, type InternalCommands } from "./commands";
import { ProjectManager } from "./manager";
import { stubSeams, type RuntimeSeams } from "./seams";
import { AppRunnerSettingTab } from "./settings-tab";
import { SettingsStore } from "./settings-store";
import { AppRunnerView, isWebviewAvailable, VIEW_TYPE_APP, webviewUrl, type ViewHost } from "./webview-view";

export const UNSUPPORTED_PLATFORM_NOTICE = "App Runner works on macOS only, so it did nothing on this computer.";

/** Open a URL in the default browser: Electron's shell when reachable, else the window opener (Obsidian hands it to the OS). */
function openExternal(url: string): void {
  try {
    const electron = (window as unknown as { require?: (m: string) => { shell?: { openExternal(u: string): unknown } } }).require?.("electron");
    if (electron?.shell) {
      void electron.shell.openExternal(url);
      return;
    }
  } catch {
    // fall through to window.open
  }
  window.open(url, "_blank");
}

export default class AppRunnerPlugin extends Plugin {
  store!: SettingsStore;
  manager!: ProjectManager;
  /** PR-2 replaces these with the real process control. */
  seams: RuntimeSeams = stubSeams;

  async onload(): Promise<void> {
    // F2: macOS desktop only. Anywhere else the plugin loads, registers nothing and says so once.
    if (!Platform.isDesktopApp || !Platform.isMacOS) {
      new Notice(UNSUPPORTED_PLATFORM_NOTICE);
      return;
    }

    this.store = new SettingsStore(
      { load: () => this.loadData(), save: (d) => this.saveData(d), backup: () => this.backUpDataFile(), exists: () => this.app.vault.adapter.exists(this.dataFilePath()) },
      { notify: (m) => new Notice(m, 15000) },
    );
    await this.store.load();

    const viewHost: ViewHost = {
      getProject: (slug) => this.store.get(slug),
      isWebviewAvailable: () => isWebviewAvailable(),
      openExternal,
      notify: (m) => new Notice(m),
    };
    this.registerView(VIEW_TYPE_APP, (leaf) => new AppRunnerView(leaf, viewHost));

    const commands = new ProjectCommands(
      this,
      this.manifest.id,
      {
        open: (slug) => void this.openProject(slug),
        stop: (slug) => this.stopProject(slug),
        popOutCurrentTab: () => this.popOutCurrentTab(),
      },
      () => (this.app as unknown as { commands?: InternalCommands }).commands,
    );
    this.manager = new ProjectManager(this.store, commands, this.seams, (m) => new Notice(m), () => this.refreshTabTitles());
    this.manager.registerAll();
    this.addSettingTab(new AppRunnerSettingTab(this.app, this, this.store, this.manager));
  }

  private dataFilePath(): string {
    return `${this.manifest.dir}/data.json`;
  }

  /** Copy data.json to data.json.corrupt-<time> beside it. Returns the new path, or null when there is no data.json. */
  private async backUpDataFile(): Promise<string | null> {
    const adapter = this.app.vault.adapter;
    const file = this.dataFilePath();
    if (!(await adapter.exists(file))) return null;
    const copy = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await adapter.copy(file, copy);
    return copy;
  }

  /** Starting arrives with PR-2. Until then Open shows a tab on the URL override, or says what is missing. */
  async openProject(slug: string): Promise<void> {
    const project = this.store.get(slug);
    if (!project) {
      new Notice("This project no longer exists.");
      return;
    }
    if (webviewUrl(project) === null) {
      new Notice(`Starting ${project.name} arrives with the next App Runner update. Set a URL override in its settings to open a page now.`);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_APP, active: true, state: { slug } });
    await this.app.workspace.revealLeaf(leaf);
  }

  stopProject(slug: string): void {
    const project = this.store.get(slug);
    new Notice(`Nothing running${project ? ` for ${project.name}` : ""}.`);
  }

  /** Pop out arrives in a later update; off an App Runner tab it only says so. */
  popOutCurrentTab(): void {
    const view = this.app.workspace.getActiveViewOfType(AppRunnerView);
    if (!view) {
      new Notice("The active tab is not an App Runner tab.");
      return;
    }
    new Notice("Pop out to browser arrives with a later App Runner update.");
  }

  private refreshTabTitles(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_APP).forEach((leaf: WorkspaceLeaf) => {
      (leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    });
  }
}
