import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import type { LogFs } from "./spawn";

/** The file-system operations the instance code needs, so tests can fake them. */
export interface RuntimeFs extends LogFs {
  isDirectory(p: string): boolean;
  exists(p: string): boolean;
  /** The last `bytes` bytes of a file as text; empty when the file is missing or unreadable. */
  readTail(file: string, bytes: number): Promise<string>;
  removeFile(file: string): Promise<void>;
}

export const realRuntimeFs: RuntimeFs = {
  mkdirSync: (dir, options) => fs.mkdirSync(dir, options),
  openSync: (file, flags) => fs.openSync(file, flags),
  closeSync: (fd) => fs.closeSync(fd),
  isDirectory(p) {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  exists(p) {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  async readTail(file, bytes) {
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(file, "r");
      const { size } = await handle.stat();
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } catch {
      return "";
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
  async removeFile(file) {
    await fsp.rm(file, { force: true });
  },
};
