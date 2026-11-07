import { logPath } from "./runtime-paths";

/** The system calls Show log makes: Electron's `shell` in the real plugin. */
export interface ShellOpener {
  /** Open with the default app. Resolves to "" on success, or an error message (Electron's `shell.openPath`). */
  openPath(file: string): Promise<string>;
  showItemInFolder(file: string): void;
}

export interface LogActions {
  /** Whether the project has a log file now. Show log is disabled when it does not (G17). */
  exists(slug: string): boolean;
  show(slug: string): Promise<void>;
}

/**
 * G17: open the log in the system app; when no app is set for it, or it cannot be opened, reveal it in Finder. Only
 * the file is opened: there is no live log view (F3). Does nothing when there is no log.
 */
export function createLogActions(opts: { runtimeDir: string; exists(file: string): boolean; shell: ShellOpener; notify(message: string): void }): LogActions {
  return {
    exists: (slug) => opts.exists(logPath(opts.runtimeDir, slug)),
    async show(slug) {
      const file = logPath(opts.runtimeDir, slug);
      if (!opts.exists(file)) {
        opts.notify("There is no log yet. Start the app to create one.");
        return;
      }
      let failure = "";
      try {
        failure = await opts.shell.openPath(file);
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
      if (failure !== "") opts.shell.showItemInFolder(file);
    },
  };
}
