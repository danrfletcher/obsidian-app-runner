import { builtinModules } from "node:module";

/** The esbuild options for main.js, shared by the real build (esbuild.config.mjs) and the bundle checks in tests. */
export function buildOptions({ production }) {
  return {
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    format: "cjs",
    target: "es2022",
    platform: "node",
    logLevel: "info",
    sourcemap: production ? false : "inline",
    minify: production,
    treeShaking: true,
    outfile: "main.js",
  };
}
