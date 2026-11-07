import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Member } from "./process-group";

/** What is recorded about a running app so Stop only ever signals a group the plugin itself started (F11). */
export interface RegistryEntry {
  slug: string;
  /** The group leader's pid, which is also the process group id. */
  pid: number;
  pgid: number;
  /** Every group member seen so far, each with its start time. */
  members: Member[];
  /** The port the app answered on, or null while it is still starting. */
  port: number | null;
  startedAt: number;
}

export interface RegistryFile {
  version: 1;
  entries: Record<string, RegistryEntry>;
}

/** The two operations the instance code needs. */
export interface RegistryLike {
  set(entry: RegistryEntry): Promise<void>;
  remove(slug: string): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function validEntry(slug: string, v: unknown): v is RegistryEntry {
  return (
    isRecord(v) &&
    v.slug === slug &&
    Number.isInteger(v.pid) &&
    Number.isInteger(v.pgid) &&
    Array.isArray(v.members) &&
    v.members.every((m) => isRecord(m) && Number.isInteger(m.pid) && typeof m.startTime === "string")
  );
}

/**
 * `running.json` in the runtime directory (outside the vault). One entry per project. Changes are applied one after
 * another and written whole to a temporary file that is then renamed, so a crash never leaves half a file. An existing
 * file that cannot be read is moved aside, not overwritten, and the registry starts empty.
 */
export class Registry implements RegistryLike {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async read(): Promise<RegistryFile> {
    let text: string;
    try {
      text = await fsp.readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
      throw e;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && isRecord(parsed.entries)) {
        const entries: Record<string, RegistryEntry> = {};
        for (const [slug, v] of Object.entries(parsed.entries)) if (validEntry(slug, v)) entries[slug] = v;
        return { version: 1, entries };
      }
    } catch {
      // fall through: unreadable
    }
    await fsp.rename(this.file, `${this.file}.corrupt-${Date.now()}`);
    return { version: 1, entries: {} };
  }

  private async write(data: RegistryFile): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }

  set(entry: RegistryEntry): Promise<void> {
    return this.enqueue(async () => {
      const data = await this.read();
      data.entries[entry.slug] = entry;
      await this.write(data);
    });
  }

  remove(slug: string): Promise<void> {
    return this.enqueue(async () => {
      const data = await this.read();
      if (!(slug in data.entries)) return;
      delete data.entries[slug];
      await this.write(data);
    });
  }
}
