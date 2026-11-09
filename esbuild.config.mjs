import esbuild from "esbuild";
import { buildOptions } from "./build-options.mjs";

const production = process.argv[2] === "production";
const context = await esbuild.context(buildOptions({ production }));

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
