import type { ProjectCommands } from "./commands";
import type { Project, ProjectInput } from "./project";
import type { RuntimeSeams } from "./seams";
import type { AddResult, SettingsStore, UpdateResult } from "./settings-store";

export type DeleteOutcome = "deleted" | "cancelled" | "missing";

/** Settings changes that also have to reach the command palette, the open tabs and the user. */
export class ProjectManager {
  constructor(
    private readonly store: SettingsStore,
    private readonly commands: ProjectCommands,
    private readonly seams: RuntimeSeams,
    private readonly notify: (message: string) => void,
    /** Called after a rename so open tabs can refresh their title. */
    private readonly onChanged: () => void = () => {},
    /** Called after a project's settings change (a toggle or an edit) so a running app's rules apply at once (G14). */
    private readonly onSettingsChanged: (slug: string) => void = () => {},
    /** Called after a project is deleted so its open tabs can close (G3). */
    private readonly onDeleted: (slug: string) => void = () => {},
  ) {}

  /** Register commands for every stored project and the global one. Called once at load. */
  registerAll(): void {
    this.commands.registerGlobal();
    for (const p of this.store.projects) this.commands.register(p);
  }

  async add(input: ProjectInput): Promise<AddResult> {
    const result = await this.store.add(input);
    if (result.ok) this.commands.register(result.project);
    return result;
  }

  /** G2. A rename re-labels the commands under the same ids. A running project is told the change waits for the next start. */
  async edit(slug: string, input: ProjectInput): Promise<UpdateResult> {
    const before = this.store.get(slug);
    const result = await this.store.update(slug, input);
    if (!result.ok) return result;
    if (before && before.name !== result.project.name) this.commands.register(result.project);
    if (result.restartRequired && this.seams.isRunning(slug)) {
      this.notify(`${result.project.name} is running: the new folder, command or URL applies the next time it starts.`);
    }
    this.onChanged();
    this.onSettingsChanged(slug);
    return result;
  }

  async setToggle(slug: string, key: "killOnClose" | "openInBrowser", value: boolean): Promise<void> {
    await this.store.setToggle(slug, key, value);
    this.onSettingsChanged(slug);
  }

  /**
   * G3. A running project is only deleted after `confirmStopAndDelete` resolves true; the seam then stops it and
   * removes its runtime files. Then its commands, its settings row and its open tabs go.
   */
  async delete(slug: string, confirmStopAndDelete: (project: Project) => Promise<boolean>): Promise<DeleteOutcome> {
    const project = this.store.get(slug);
    if (!project) return "missing";
    if (this.seams.isRunning(slug) && !(await confirmStopAndDelete(project))) return "cancelled";
    await this.seams.removeRuntime(project);
    this.commands.unregister(slug);
    await this.store.remove(slug);
    this.onChanged();
    this.onDeleted(slug);
    return "deleted";
  }
}
