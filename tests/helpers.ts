import type { FolderKind, FsProbe } from "../src/validation";
import type { ProjectInput } from "../src/project";
import type { Persistence } from "../src/settings-store";

/** A fake file system: paths listed as dirs are directories, as files are files, anything else is missing. */
export function fakeFs(dirs: string[] = ["/work/live-captions", "/work/build-dashboard", "/work/other"], files: string[] = []): FsProbe {
  return {
    kind(p): FolderKind {
      if (dirs.includes(p)) return "dir";
      if (files.includes(p)) return "file";
      return "missing";
    },
  };
}

/** data.json in memory, with the JSON round trip a real file has. */
export function memoryPersistence(initial: unknown = null): Persistence & { current: unknown; saves: number } {
  const p = {
    current: initial,
    saves: 0,
    async load() {
      return p.current === null ? null : JSON.parse(JSON.stringify(p.current));
    },
    async save(data: unknown) {
      p.saves++;
      p.current = JSON.parse(JSON.stringify(data));
    },
  };
  return p;
}

export function input(over: Partial<ProjectInput> = {}): ProjectInput {
  return {
    name: "Live Captions",
    folder: "/work/live-captions",
    command: "npm run start",
    urlOverride: "",
    killOnClose: true,
    openInBrowser: false,
    ...over,
  };
}
