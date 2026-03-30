import { mkdir, copyFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("vendor", { recursive: true });

await Promise.all([
  copyFile("node_modules/jszip/dist/jszip.js", "vendor/jszip.js"),
  copyFile("node_modules/lodash/lodash.js", "vendor/lodash.js")
]);

await Promise.all([
  build({
    entryPoints: ["node_modules/source-map-js/source-map.js"],
    bundle: true,
    format: "iife",
    globalName: "sourceMap",
    outfile: "vendor/source-map.js",
    platform: "browser",
    target: ["chrome110"],
    logLevel: "info"
  }),
  build({
    entryPoints: ["node_modules/react/index.js"],
    bundle: true,
    format: "iife",
    globalName: "React",
    outfile: "vendor/react.js",
    platform: "browser",
    target: ["chrome110"],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "info"
  }),
  build({
    entryPoints: ["node_modules/react-dom/client.js"],
    bundle: true,
    format: "iife",
    globalName: "ReactDOM",
    outfile: "vendor/react-dom.js",
    platform: "browser",
    target: ["chrome110"],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "info"
  })
]);
