import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Project, ProjectInput } from "./project";

export type FolderKind = "dir" | "file" | "missing";

/** The one thing validation needs from the file system, so tests can fake it. */
export interface FsProbe {
  kind(absolutePath: string): FolderKind;
}

export const realFs: FsProbe = {
  kind(p) {
    try {
      return fs.statSync(p).isDirectory() ? "dir" : "file";
    } catch {
      return "missing";
    }
  },
};

export const MAX_NAME_LENGTH = 80;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Only an http(s) URL on 127.0.0.1, localhost or [::1], with no credentials, is ever shown or opened (F6, F8). */
export function isLoopbackUrl(raw: string): boolean {
  return loopbackUrlError(raw) === null;
}

/** null when `raw` is an acceptable loopback URL, otherwise the reason. */
export function loopbackUrlError(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "Enter a full URL such as http://127.0.0.1:8957";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "The URL must start with http:// or https://";
  if (!LOOPBACK_HOSTS.has(url.hostname)) return "Only loopback addresses are allowed: 127.0.0.1, localhost or [::1]";
  if (url.username !== "" || url.password !== "") return "The URL must not contain a user name or password";
  return null;
}

export function nameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

export type FieldErrors = Partial<Record<"name" | "folder" | "command" | "urlOverride", string>>;

export interface ValidationContext {
  fs: FsProbe;
  existing: readonly Project[];
  /** The slug of the project being edited: its own name is not a duplicate of itself. */
  editingSlug?: string;
  homeDir?: string;
}

export type ValidationResult = { ok: true; value: ProjectInput } | { ok: false; errors: FieldErrors };

/** `~` and `~/x` become the home folder; anything else must already be absolute. Returns null when it is not absolute. */
export function resolveFolder(raw: string, homeDir: string): string | null {
  let p = raw.trim();
  if (p === "~") p = homeDir;
  else if (p.startsWith("~/")) p = path.join(homeDir, p.slice(2));
  if (!path.isAbsolute(p)) return null;
  return path.resolve(p);
}

/** G1: folder exists and is a directory, command non-empty and one line, name unique, override a loopback URL. */
export function validateProject(input: ProjectInput, ctx: ValidationContext): ValidationResult {
  const errors: FieldErrors = {};

  const name = input.name.trim();
  if (name === "") errors.name = "Enter a name";
  else if (name.length > MAX_NAME_LENGTH) errors.name = `Use ${MAX_NAME_LENGTH} characters or fewer`;
  else {
    const key = nameKey(name);
    if (ctx.existing.some((p) => p.slug !== ctx.editingSlug && nameKey(p.name) === key)) {
      errors.name = "A project with this name already exists";
    }
  }

  let folder = input.folder.trim();
  if (folder === "") errors.folder = "Enter the project folder";
  else {
    const resolved = resolveFolder(folder, ctx.homeDir ?? os.homedir());
    if (resolved === null) errors.folder = "Enter an absolute path (or one starting with ~/)";
    else {
      const kind = ctx.fs.kind(resolved);
      if (kind === "missing") errors.folder = "This folder does not exist";
      else if (kind === "file") errors.folder = "This path is a file, not a folder";
      else folder = resolved;
    }
  }

  const command = input.command.trim();
  if (command === "") errors.command = "Enter the start command";
  else if (/[\r\n]/.test(command)) errors.command = "Use a single-line command";

  const urlOverride = input.urlOverride.trim();
  if (urlOverride !== "") {
    const reason = loopbackUrlError(urlOverride);
    if (reason !== null) errors.urlOverride = reason;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { name, folder, command, urlOverride, killOnClose: input.killOnClose, openInBrowser: input.openInBrowser },
  };
}
