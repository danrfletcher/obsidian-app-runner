import AppRunnerPlugin from "../src/main";
import type { InstanceDeps } from "../src/instance";
import type { AppRunnerSettingTab } from "../src/settings-tab";
import { VIEW_TYPE_APP } from "../src/webview-view";
import { FakeBrowser } from "./browser-fakes";
import { WorkspaceLeaf, type FakeNode, type Plugin as MockPlugin } from "./obsidian-mock";
import type { FakeWorld } from "./process-fakes";

export type MockedPlugin = AppRunnerPlugin & Pick<MockPlugin, "commands" | "views" | "settingTabs" | "stored" | "forbiddenCalls">;

export interface LaunchOptions {
  /** Slugs of App Runner tabs Obsidian restores from the saved workspace (their views are not loaded). */
  restoredTabs?: string[];
  /** Replace the registry the plugin uses (a real file, for example). */
  registry?: InstanceDeps["registry"];
  /** The vault's base path as the adapter reports it. */
  vaultBasePath?: string;
  runtimeDir?: string;
  vaultKey?: string;
  /** Runs on the plugin before `onload`: swap `loadData`/`saveData`, for example. */
  configure?: (plugin: MockedPlugin) => void;
  /** Use this file system for logs instead of the world's in-memory one. */
  runtimeFs?: InstanceDeps["fs"];
  /** The browser the poll sees. Default: the default browser is Brave and it is not running, so no tab is ever read. */
  browser?: FakeBrowser;
  /** Wait for the launch check for apps left running before returning (default). False: return as `onload` does, with the check still going. */
  waitForAdoption?: boolean;
}

/**
 * The real plugin class started against a FakeWorld, with the Obsidian workspace reduced to a list of leaves. Calling
 * `launch` again on the same world (and registry) is "Obsidian restarted": everything in memory is new, the processes
 * and the registry are what the last session left.
 */
export async function launch(world: FakeWorld, opts: LaunchOptions = {}) {
  const leaves: WorkspaceLeaf[] = [];
  for (const slug of opts.restoredTabs ?? []) {
    const l = new WorkspaceLeaf();
    l.viewState = { type: VIEW_TYPE_APP, state: { slug } };
    leaves.push(l);
  }
  const handlers = new Map<string, () => void>();
  let layoutReady: (() => void) | undefined;
  /** As in Obsidian, detaching a leaf takes it out of the workspace and the layout changes. */
  const attached = (l: WorkspaceLeaf): WorkspaceLeaf => {
    l.detach = () => {
      l.detached = true;
      const at = leaves.indexOf(l);
      if (at >= 0) leaves.splice(at, 1);
      handlers.get("layout-change")?.();
    };
    return l;
  };
  for (const l of leaves) attached(l);
  const workspace = {
    /** The view Obsidian reports as the active tab; tests set it. */
    activeView: null as unknown,
    getLeaf: () => {
      const l = attached(new WorkspaceLeaf());
      leaves.push(l);
      return l;
    },
    revealLeaf: async () => {},
    getActiveViewOfType: (cls: new (...a: never[]) => unknown) => (workspace.activeView instanceof cls ? workspace.activeView : null),
    getLeavesOfType: (type: string) => leaves.filter((l) => l.viewState?.type === type),
    on: (name: string, cb: () => void) => {
      handlers.set(name, cb);
      return {};
    },
    onLayoutReady: (cb: () => void) => void (layoutReady = cb),
  };
  const adapter = opts.vaultBasePath ? { getBasePath: () => opts.vaultBasePath } : {};
  const plugin = new AppRunnerPlugin({ workspace, commands: { commands: {} }, vault: { adapter } } as never, { id: "app-runner", dir: "plugins/app-runner" } as never) as MockedPlugin;
  const { spawn, table, lsof, kill, http, clock, fs, registry, openExternal } = world.deps();
  plugin.instanceDeps = { spawn, table, lsof, kill, http, clock, fs: opts.runtimeFs ?? fs, registry: opts.registry ?? registry, openExternal, runtimeDir: opts.runtimeDir ?? "/runtime/k" };
  plugin.stored = { vaultKey: opts.vaultKey ?? "k", projects: [...world.projects.values()] };
  const browser = opts.browser ?? new FakeBrowser();
  plugin.browserDeps = browser.deps(); // a test never reaches the real osascript, plutil or lsappinfo
  opts.configure?.(plugin);
  await plugin.onload();
  if (opts.waitForAdoption !== false) await plugin.adopted; // onload does not wait for the launch check; most tests want the apps it adopts
  const tab = plugin.settingTabs[0] as AppRunnerSettingTab;
  return {
    plugin,
    browser,
    leaves,
    workspace,
    tab,
    layoutChange: () => handlers.get("layout-change")!(),
    /** Obsidian has restored its layout. */
    layoutReady: () => layoutReady!(),
    rows() {
      const section = (tab.containerEl as unknown as FakeNode).children[0];
      return section.settings.map((s) => ({ name: s.name, desc: s.desc, buttons: s.buttons }));
    },
  };
}

export type Launched = Awaited<ReturnType<typeof launch>>;
