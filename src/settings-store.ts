import type { Project, ProjectInput } from "./project";
import { slugForNewProject } from "./slug";
import { isLoopbackUrl, validateProject, realFs, type FieldErrors, type FsProbe } from "./validation";

export const DATA_VERSION = 1;

/**
 * What `data.json` holds: projects, global settings and the vault key. Never a pid, port or log path (runtime state
 * lives outside the vault). Fields this version does not know are kept as read and written back.
 */
export interface PluginData {
  version: number;
  /** Names the runtime directory outside the vault. Generated once, never changed. */
  vaultKey: string;
  settings: Record<string, unknown>;
  projects: Project[];
  [unknown: string]: unknown;
}

/** Where the data lives: `Plugin.loadData` / `saveData` in the real plugin. */
export interface Persistence {
  load(): Promise<unknown>;
  save(data: unknown): Promise<void>;
  /**
   * Copy the data file as it is on disk to a side file and return that file's path, or null when there is no file
   * to copy. Called before a corrupt file would be written over. Throws when the copy cannot be made.
   */
  backup?(): Promise<string | null>;
  /**
   * Whether a data file is on disk. `Plugin.loadData` can answer undefined or null for a file it could not parse
   * (Obsidian 1.15 does for truncated JSON), so when it does, this decides missing from unreadable. Without it a
   * null/undefined answer is taken as a missing file.
   */
  exists?(): Promise<boolean>;
}

export type AddResult = { ok: true; project: Project } | { ok: false; errors: FieldErrors };
export type UpdateResult =
  | { ok: true; project: Project; /** folder, command or URL changed: applies at the next start */ restartRequired: boolean }
  | { ok: false; errors: FieldErrors };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One stored project, with defaults for missing fields; null when it lacks what a project cannot do without. */
function normaliseProject(raw: unknown): Project | null {
  if (!isRecord(raw)) return null;
  const { name, slug, folder, command } = raw;
  if (typeof name !== "string" || typeof slug !== "string" || slug === "") return null;
  if (typeof folder !== "string" || typeof command !== "string") return null;
  return {
    ...raw,
    name,
    slug,
    folder,
    command,
    urlOverride: typeof raw.urlOverride === "string" ? raw.urlOverride : "",
    killOnClose: typeof raw.killOnClose === "boolean" ? raw.killOnClose : true,
    openInBrowser: typeof raw.openInBrowser === "boolean" ? raw.openInBrowser : false,
  };
}

export class SettingsStore {
  private data: PluginData = SettingsStore.defaults("");

  /** The file on disk was unreadable or the wrong shape and has not been backed up yet. */
  private unprotectedCorrupt = false;

  constructor(
    private readonly persistence: Persistence,
    private readonly deps: { fs?: FsProbe; homeDir?: string; newKey?: () => string; notify?: (message: string) => void } = {},
  ) {}

  private static defaults(vaultKey: string): PluginData {
    return { version: DATA_VERSION, vaultKey, settings: {}, projects: [] };
  }

  /**
   * Read data.json. A missing file (nothing read and, when the persistence can tell, no file on disk) gives the
   * defaults, saved at once so the generated vault key is the same on every later load. A corrupt or wrong-shaped
   * file (unreadable JSON, nothing read although the file exists, merge conflict markers, not an object, projects or
   * settings of the wrong type) also gives the defaults in memory, but the file is copied to a side file first and
   * the user is told; if the copy cannot be made nothing is written until the user changes something. A project
   * entry without a name, slug, folder or command, or with a slug already taken, is skipped.
   */
  async load(): Promise<void> {
    let raw: unknown = null;
    let corrupt = false;
    try {
      raw = await this.persistence.load();
    } catch {
      corrupt = true;
    }
    if (!corrupt && (raw === null || raw === undefined) && this.persistence.exists) {
      // Nothing came back. That is a missing file only if there is no file; a file that is there but read as
      // nothing is unreadable. If we cannot tell, assume it is there: never write over what might be the user's data.
      try {
        corrupt = await this.persistence.exists();
      } catch {
        corrupt = true;
      }
    }
    if (raw !== null && raw !== undefined) {
      if (!isRecord(raw) || (raw.projects !== undefined && !Array.isArray(raw.projects)) || (raw.settings !== undefined && !isRecord(raw.settings))) {
        corrupt = true;
      }
    }
    const base = !corrupt && isRecord(raw) ? raw : {};
    const projects: Project[] = [];
    for (const entry of Array.isArray(base.projects) ? base.projects : []) {
      const p = normaliseProject(entry);
      if (p && !projects.some((q) => q.slug === p.slug)) projects.push(p);
    }
    const hadKey = typeof base.vaultKey === "string" && base.vaultKey !== "";
    this.data = {
      ...base,
      version: DATA_VERSION,
      vaultKey: hadKey ? (base.vaultKey as string) : (this.deps.newKey ?? (() => globalThis.crypto.randomUUID()))(),
      settings: isRecord(base.settings) ? base.settings : {},
      projects,
    };
    if (corrupt) {
      this.unprotectedCorrupt = true;
      const backedUp = await this.backUpCorrupt();
      // Only now is it safe to write: the original is in the side file.
      if (backedUp) await this.save();
      return;
    }
    if (!hadKey) await this.save();
  }

  /** Copy the corrupt file aside and tell the user. Returns true when the copy exists. */
  private async backUpCorrupt(): Promise<boolean> {
    const notify = this.deps.notify ?? (() => {});
    try {
      if (!this.persistence.backup) throw new Error("no backup available");
      const path = await this.persistence.backup();
      this.unprotectedCorrupt = false;
      notify(
        path
          ? `App Runner could not read its settings file. A copy is saved as ${path}, and it starts with no projects.`
          : "App Runner could not read its settings file, and it starts with no projects.",
      );
      return true;
    } catch {
      notify(
        "App Runner could not read its settings file and could not back it up. It starts with no projects, and the file is left alone until you change a setting.",
      );
      return false;
    }
  }

  async save(): Promise<void> {
    // A corrupt file that could not be copied aside at load: try again before it is written over.
    if (this.unprotectedCorrupt) {
      try {
        await this.persistence.backup?.();
        this.unprotectedCorrupt = false;
      } catch {
        // The user has now changed something on purpose; write it.
      }
    }
    return this.persistence.save(this.data);
  }

  get vaultKey(): string {
    return this.data.vaultKey;
  }

  get projects(): readonly Project[] {
    return this.data.projects;
  }

  get(slug: string): Project | undefined {
    return this.data.projects.find((p) => p.slug === slug);
  }

  private ctx(editingSlug?: string) {
    return { fs: this.deps.fs ?? realFs, existing: this.data.projects, editingSlug, homeDir: this.deps.homeDir };
  }

  /**
   * G1. Validation and the insert happen before the first await, so a second call made while the save is still
   * pending already sees the project and is rejected as a duplicate: two quick Add clicks make one project.
   */
  async add(input: ProjectInput): Promise<AddResult> {
    const checked = validateProject(input, this.ctx());
    if (!checked.ok) return checked;
    const slug = slugForNewProject(checked.value.name, this.data.projects.map((p) => p.slug));
    const project: Project = { ...checked.value, slug };
    this.data.projects.push(project);
    await this.save();
    return { ok: true, project };
  }

  /**
   * G2. Name, folder, command, URL and both toggles are replaced; the slug is kept, so command ids stay put. Fields
   * on the stored project that this version does not know are kept.
   */
  async update(slug: string, input: ProjectInput): Promise<UpdateResult> {
    const index = this.data.projects.findIndex((p) => p.slug === slug);
    if (index < 0) return { ok: false, errors: { name: "This project no longer exists" } };
    const checked = validateProject(input, this.ctx(slug));
    if (!checked.ok) return checked;
    const before = this.data.projects[index];
    const project: Project = { ...before, ...checked.value, slug };
    this.data.projects[index] = project;
    await this.save();
    const restartRequired =
      before.folder !== project.folder || before.command !== project.command || before.urlOverride !== project.urlOverride;
    return { ok: true, project, restartRequired };
  }

  /** The Kill and Open-in-browser toggles take effect at once in stored settings (G2). */
  async setToggle(slug: string, key: "killOnClose" | "openInBrowser", value: boolean): Promise<Project | undefined> {
    const index = this.data.projects.findIndex((p) => p.slug === slug);
    if (index < 0) return undefined;
    this.data.projects[index] = { ...this.data.projects[index], [key]: value };
    await this.save();
    return this.data.projects[index];
  }

  /**
   * E3: remember the port the user picked as the project's URL override. Only a loopback URL is stored (F6); anything
   * else is refused and nothing changes.
   */
  async setUrlOverride(slug: string, url: string): Promise<Project | undefined> {
    const index = this.data.projects.findIndex((p) => p.slug === slug);
    if (index < 0 || !isLoopbackUrl(url)) return undefined;
    this.data.projects[index] = { ...this.data.projects[index], urlOverride: url.trim() };
    await this.save();
    return this.data.projects[index];
  }

  async remove(slug: string): Promise<Project | undefined> {
    const index = this.data.projects.findIndex((p) => p.slug === slug);
    if (index < 0) return undefined;
    const [removed] = this.data.projects.splice(index, 1);
    await this.save();
    return removed;
  }
}
