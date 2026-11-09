import type { Project } from "./project";
import { openCommandId, stopCommandId } from "./slug";

export const POP_OUT_COMMAND_ID = "pop-out-current-tab";
export const POP_OUT_COMMAND_NAME = "Pop out current App Runner tab to browser";

/** The part of Obsidian's Plugin that command registration uses. */
export interface CommandHost {
  addCommand(command: { id: string; name: string; callback: () => void }): unknown;
  /** Public since Obsidian 1.7.2. Used when the internal registry cannot be reached. */
  removeCommand?(id: string): void;
}

/** Obsidian's internal command registry (`app.commands`). Not part of the public API: every use is best effort. */
export interface InternalCommands {
  commands?: Record<string, unknown>;
  removeCommand?(fullId: string): void;
}

export interface CommandActions {
  open(slug: string): void;
  stop(slug: string): void;
  popOutCurrentTab(): void;
}

/**
 * G4: two commands per project, `open-<slug>` and `stop-<slug>`, plus one global pop-out command. Ids come from the
 * slug fixed at creation, so a rename re-labels the commands and never moves them (E12).
 */
export class ProjectCommands {
  constructor(
    private readonly host: CommandHost,
    private readonly pluginId: string,
    private readonly actions: CommandActions,
    private readonly internal: () => InternalCommands | undefined,
  ) {}

  registerGlobal(): void {
    this.host.addCommand({ id: POP_OUT_COMMAND_ID, name: POP_OUT_COMMAND_NAME, callback: () => this.actions.popOutCurrentTab() });
  }

  /** Add the project's two commands. Calling it again with a new name replaces the labels under the same ids. */
  register(project: Project): void {
    const slug = project.slug;
    this.host.addCommand({ id: openCommandId(slug), name: `Open ${project.name}`, callback: () => this.actions.open(slug) });
    this.host.addCommand({ id: stopCommandId(slug), name: `Stop ${project.name}`, callback: () => this.actions.stop(slug) });
  }

  /**
   * G3: take the project's commands out of the palette now. Through the internal registry when it can be reached, else
   * the public `removeCommand`; if neither works the commands are gone after a reload. Returns how many were removed.
   */
  unregister(slug: string): number {
    let removed = 0;
    for (const id of [openCommandId(slug), stopCommandId(slug)]) if (this.removeOne(id)) removed++;
    return removed;
  }

  private removeOne(id: string): boolean {
    const fullId = `${this.pluginId}:${id}`;
    try {
      const registry = this.internal();
      if (registry && typeof registry.removeCommand === "function") {
        registry.removeCommand(fullId);
        return true;
      }
      if (registry?.commands && fullId in registry.commands) {
        delete registry.commands[fullId];
        return true;
      }
      if (typeof this.host.removeCommand === "function") {
        this.host.removeCommand(id);
        return true;
      }
    } catch {
      // Best effort: the command is gone after a reload.
    }
    return false;
  }
}
