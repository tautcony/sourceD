import { mkdir, copyFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("vendor", { recursive: true });

await Promise.all([
  copyFile("node_modules/jszip/dist/jszip.js", "vendor/jszip.js"),
  copyFile("node_modules/tiny-react/index.js", "vendor/tiny-react.js"),
  copyFile("node_modules/lodash/lodash.js", "vendor/lodash.js")
]);

await build({
  entryPoints: ["node_modules/source-map-js/source-map.js"],
  bundle: true,
  format: "iife",
  globalName: "sourceMap",
  outfile: "vendor/source-map.js",
  platform: "browser",
  target: ["chrome110"],
  logLevel: "info"
});
