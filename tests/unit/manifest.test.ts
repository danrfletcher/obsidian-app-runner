import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));

describe("manifest.json", () => {
  const manifest = read("manifest.json");

  it("has the plugin's identity", () => {
    expect(manifest.id).toBe("app-runner");
    expect(manifest.name).toBe("App Runner");
    expect(manifest.minAppVersion).toBe("1.13.0");
    expect(manifest.isDesktopOnly).toBe(true);
  });

  it("has a semver version", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("versions.json maps the manifest version to its minAppVersion", () => {
    const versions = read("versions.json");
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
  });

  it("every versions.json entry is a version to minAppVersion pair", () => {
    for (const [version, min] of Object.entries(read("versions.json"))) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(min).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("package.json carries the same version", () => {
    expect(read("package.json").version).toBe(manifest.version);
  });
});
