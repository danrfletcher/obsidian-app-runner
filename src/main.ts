import { Notice, Platform, Plugin, type WorkspaceLeaf } from "obsidian";
import { ProjectCommands, type InternalCommands } from "./commands";
import { realClock } from "./clock";
import { InstanceManager, type InstanceDeps } from "./instance";
import { loopbackGet } from "./loopback-http";
import { ProjectManager } from "./manager";
import { PortPickerModal } from "./port-picker";
import { realLsof } from "./port-discovery";
import { realKill, realProcessTable } from "./process-group";
import { Registry } from "./registry";
import { realRuntimeFs } from "./runtime-fs";
import { registryPath, runtimeDir } from "./runtime-paths";
import { createLogActions, type ShellOpener } from "./show-log";
import { AppRunnerSettingTab } from "./settings-tab";
import { SettingsStore } from "./settings-store";
import { AppRunnerView, isWebviewAvailable, VIEW_TYPE_APP, type ViewHost } from "./webview-view";

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

/** Electron's `shell`, reached lazily: Show log opens the file with the system app (G17). */
const electronShell: ShellOpener = {
  openPath: async (file) => {
    const shell = (window as unknown as { require?: (m: string) => { shell?: { openPath(f: string): Promise<string> } } }).require?.("electron")?.shell;
    return shell ? shell.openPath(file) : "The system shell is not available.";
  },
  showItemInFolder: (file) => {
    (window as unknown as { require?: (m: string) => { shell?: { showItemInFolder(f: string): void } } }).require?.("electron")?.shell?.showItemInFolder(file);
  },
};

export default class AppRunnerPlugin extends Plugin {
  store!: SettingsStore;
  manager!: ProjectManager;
  instances!: InstanceManager;
  /** Replaces parts of the real process side (spawn, ps, lsof, the runtime folder). Tests set it before `onload`. */
  instanceDeps: Partial<InstanceDeps> = {};

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

    const notify = (message: string) => void new Notice(message, message.includes("\n") ? 20000 : 6000);
    const runtime = this.instanceDeps.runtimeDir ?? runtimeDir(this.store.vaultKey);
    const deps: InstanceDeps = {
      getProject: (slug) => this.store.get(slug),
      runtimeDir: runtime,
      notify,
      openExternal,
      pickPort: (project, ports, signal) => {
        const modal = new PortPickerModal(this.app, project.name, ports, signal);
        modal.open();
        return modal.result;
      },
      rememberUrl: async (slug, url) => void (await this.store.setUrlOverride(slug, url)),
      fs: realRuntimeFs,
      table: realProcessTable,
      lsof: realLsof,
      kill: realKill,
      http: loopbackGet,
      clock: realClock,
      registry: new Registry(registryPath(runtime)),
      ...this.instanceDeps,
    };
    this.instances = new InstanceManager(deps);
    const logs = createLogActions({ runtimeDir: runtime, exists: (file) => deps.fs.exists(file), shell: electronShell, notify });

    const viewHost: ViewHost = {
      getProject: (slug) => this.store.get(slug),
      instanceUrl: (slug) => this.instances.urlOf(slug),
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
        stop: (slug) => void this.stopProject(slug),
        popOutCurrentTab: () => this.popOutCurrentTab(),
      },
      () => (this.app as unknown as { commands?: InternalCommands }).commands,
    );
    this.manager = new ProjectManager(this.store, commands, this.instances, (m) => new Notice(m), () => this.refreshTabTitles());
    this.manager.registerAll();
    this.addSettingTab(new AppRunnerSettingTab(this.app, this, this.store, this.manager, logs));
  }

  /** Until adoption at relaunch lands, apps do not outlive the plugin: every group gets SIGTERM now, SIGKILL after 5 s. */
  onunload(): void {
    this.instances?.stopAllNow();
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

  /** G5: start the app if needed, then open one tab on it. A second Open while it starts joins that start and adds no tab. */
  async openProject(slug: string): Promise<void> {
    const outcome = await this.instances.open(slug);
    if (outcome.kind !== "tab") return;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_APP, active: true, state: { slug } });
    await this.app.workspace.revealLeaf(leaf);
  }

  async stopProject(slug: string): Promise<void> {
    await this.instances.stop(slug);
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
