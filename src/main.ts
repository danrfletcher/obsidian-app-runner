import { Notice, Platform, Plugin, type WorkspaceLeaf } from "obsidian";
import { Adoption, type AdoptionDeps } from "./adopt";
import { ProjectCommands, type InternalCommands } from "./commands";
import { realClock } from "./clock";
import { InstanceManager, type InstanceDeps } from "./instance";
import { KillTimer } from "./kill-timer";
import { loopbackGet } from "./loopback-http";
import { ProjectManager } from "./manager";
import { PortPickerModal } from "./port-picker";
import { realLsof } from "./port-discovery";
import { realKill, realProcessTable } from "./process-group";
import { Registry, type RegistryProblem } from "./registry";
import { buildRunningRows } from "./running-list-model";
import { realRuntimeFs } from "./runtime-fs";
import { assertOutsideVault, logPath, registryPath, runtimeDir } from "./runtime-paths";
import { SessionCounter } from "./session-counter";
import { createLogActions, type ShellOpener } from "./show-log";
import { AppRunnerSettingTab, type RunningListHost } from "./settings-tab";
import { SettingsStore } from "./settings-store";
import { readLogTail } from "./stopped-panel";
import { AppRunnerView, isWebviewAvailable, VIEW_TYPE_APP, type ViewHost } from "./webview-view";

export const UNSUPPORTED_PLATFORM_NOTICE = "App Runner works on macOS only, so it did nothing on this computer.";

const PROBLEM_TEXT: Record<RegistryProblem, string> = {
  empty: "it was empty",
  unreadable: "it was not valid JSON",
  "wrong-version": "it was written by a different version of App Runner",
  invalid: "it was not in the expected shape",
};

/** The one notice shown when `running.json` cannot be used (the Added corrupt-file case). Nothing is signalled on the strength of such a file. */
export function registryProblemNotice(problem: RegistryProblem, movedTo: string | null): string {
  const where = movedTo ? `It was moved aside as ${movedTo}.` : "It could not be moved aside and was left where it is.";
  return `App Runner could not use its list of running apps: ${PROBLEM_TEXT[problem]}. ${where} It starts with an empty list and stops nothing because of it.`;
}

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
  sessions!: SessionCounter;
  killTimer!: KillTimer;
  adoption!: Adoption;
  /**
   * G10: set before `onload` by whatever runs the browser poll (a later update). Adoption calls it for apps whose registry
   * entry says a browser session was expected, and waits for it before any stop decision.
   */
  adoptionHooks: Pick<AdoptionDeps, "resumeBrowserPoll"> = {};
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
    // F16: pids, logs and the registry never go inside the git-tracked vault. Refuse to run rather than write there.
    const vaultRoot = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
    if (vaultRoot) {
      try {
        assertOutsideVault(runtime, vaultRoot);
      } catch (e) {
        new Notice(`App Runner did nothing: ${e instanceof Error ? e.message : String(e)}`, 15000);
        return;
      }
    }
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
      registry: new Registry(registryPath(runtime), { onProblem: (problem, movedTo) => notify(registryProblemNotice(problem, movedTo)) }),
      ...this.instanceDeps,
    };
    this.instances = new InstanceManager(deps);
    // G14: Obsidian tabs per project, counted from the leaves' saved view state (loaded or not).
    this.sessions = new SessionCounter(() => this.app.workspace.getLeavesOfType(VIEW_TYPE_APP));
    this.killTimer = new KillTimer({
      clock: deps.clock,
      sessionCount: (slug) => this.sessions.count(slug),
      stateOf: (slug) => this.instances.stateOf(slug),
      isHeld: (slug) => this.instances.isHeld(slug),
      // An app adopted at launch is not judged until restored tabs are counted and the 15 s after layout ready have passed.
      suspended: (slug) => this.adoption?.suspended(slug) ?? false,
      killOnClose: (slug) => this.store.get(slug)?.killOnClose,
      stop: (slug) => this.instances.stop(slug),
      onInstanceChange: (listener) => this.instances.subscribe((e) => listener(e.slug)),
      onSessionChange: (listener) => this.sessions.subscribe(listener),
    });
    this.adoption = new Adoption({
      registry: deps.registry,
      table: deps.table,
      target: this.instances,
      getProject: (slug) => this.store.get(slug),
      sessionCount: (slug) => this.sessions.count(slug),
      killOnClose: (slug) => this.store.get(slug)?.killOnClose,
      clock: deps.clock,
      notify,
      resumeBrowserPoll: this.adoptionHooks.resumeBrowserPoll,
      onSettled: (slug) => this.killTimer.evaluate(slug),
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => this.sessions.refresh()));
    // G10: take back what the last session left running before any restored tab asks for its URL. A failure here must not stop the plugin loading.
    try {
      await this.adoption.adoptAll();
    } catch (e) {
      notify(`App Runner could not check for apps left running: ${e instanceof Error ? e.message : String(e)}`);
    }
    // After adoption on purpose: when the layout is already ready this callback runs at once, and it must find the adopted apps.
    this.app.workspace.onLayoutReady(() => {
      this.sessions.refresh();
      // Restored tabs are counted now; only then does adoption decide what to stop.
      void this.adoption.layoutReady();
    });
    const logs = createLogActions({ runtimeDir: runtime, exists: (file) => deps.fs.exists(file), shell: electronShell, notify });

    const viewHost: ViewHost = {
      getProject: (slug) => this.store.get(slug),
      instanceUrl: (slug) => this.instances.urlOf(slug),
      subscribe: (listener) => this.instances.subscribe(listener),
      // The panel's Start is the Open path; the tab that asked reloads itself when the instance is running (G9).
      start: (slug) => this.instances.open(slug),
      logTail: (slug) => readLogTail(deps.fs, logPath(runtime, slug)),
      sessionsChanged: () => this.sessions.refresh(),
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
    this.manager = new ProjectManager(
      this.store,
      commands,
      this.instances,
      (m) => new Notice(m),
      () => this.refreshTabTitles(),
      // G14: the Kill toggle applies to a running instance at once.
      (slug) => this.killTimer.evaluate(slug),
    );
    this.manager.registerAll();
    const running: RunningListHost = {
      rows: () => buildRunningRows(this.instances.snapshots(), { sessions: (slug) => this.sessions.count(slug), logExists: (slug) => logs.exists(slug) }),
      subscribe: (listener) => {
        const offInstances = this.instances.subscribe(() => listener());
        const offSessions = this.sessions.subscribe(() => listener());
        return () => {
          offInstances();
          offSessions();
        };
      },
      open: (slug) => void this.openProject(slug),
      stop: (slug) => void this.stopProject(slug),
      showLog: (slug) => void logs.show(slug),
    };
    this.addSettingTab(new AppRunnerSettingTab(this.app, this, this.store, this.manager, logs, running));
  }

  /**
   * G15: unloading or disabling the plugin (or Obsidian quitting) never stops an app. Timers and listeners are dropped and
   * nothing is signalled or written: the registry stays as it is, and the next launch adopts what is still running.
   */
  onunload(): void {
    this.killTimer?.dispose();
    this.adoption?.dispose();
    this.sessions?.clearListeners();
    this.instances?.dispose();
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
    this.sessions.refresh();
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
      // A panel redraws so it names the project, or drops Start when the project is gone.
      if (leaf.view instanceof AppRunnerView) void leaf.view.refresh();
    });
  }
}
