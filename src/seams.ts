import type { Project } from "./project";

/**
 * Seams the next PRs fill. In this PR nothing is ever running and removing a project has no runtime files to clean up.
 */
export interface RuntimeSeams {
  /** PR-2 fills this: is the project's app running (or starting)? */
  isRunning(slug: string): boolean;
  /** PR-2 stops the app, PR-2/PR-4 remove its registry entry and log file. A no-op until then. */
  removeRuntime(project: Project): Promise<void>;
}

export const stubSeams: RuntimeSeams = {
  isRunning: () => false,
  removeRuntime: async () => {},
};
