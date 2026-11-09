import type { Project } from "./project";

/**
 * What the project manager asks of the process side. `InstanceManager` (instance.ts) is the real one; `stubSeams` is
 * for tests and for anything that has no process control.
 */
export interface RuntimeSeams {
  /** Is the project's app starting, running or stopping? */
  isRunning(slug: string): boolean;
  /** Stop the app if there is one, then remove its registry entry and log file (G3). */
  removeRuntime(project: Project): Promise<void>;
}

export const stubSeams: RuntimeSeams = {
  isRunning: () => false,
  removeRuntime: async () => {},
};
