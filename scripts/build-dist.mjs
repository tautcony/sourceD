import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const DIST_DIR = "dist";

const BUNDLES_DIR = "bundles";

// Bundle JSX pages with esbuild (output to root bundles/ for dev loading)
const commonOptions = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome110"],
  define: { "process.env.NODE_ENV": '"production"' },
  jsx: "automatic",
  minify: true,
  logLevel: "info",
};

await mkdir(BUNDLES_DIR, { recursive: true });
await Promise.all([
  build({
    ...commonOptions,
    entryPoints: ["src/background/index.js"],
    outfile: `${BUNDLES_DIR}/background.js`,
  }),
  build({
    ...commonOptions,
    entryPoints: ["src/popup/entry.jsx"],
    outfile: `${BUNDLES_DIR}/popup.js`,
  }),
  build({
    ...commonOptions,
    entryPoints: ["src/dashboard/entry.jsx"],
    outfile: `${BUNDLES_DIR}/dashboard.js`,
  }),
  build({
    ...commonOptions,
    entryPoints: ["src/options/entry.jsx"],
    outfile: `${BUNDLES_DIR}/options.js`,
  }),
]);

// Static assets to copy into dist
const COPY_TARGETS = [
  "_locales",
  "images",
  "bundles",
  "manifest.json",
  "dashboard.html",
  "options.html",
  "popup.html",
  "README.md",
  "LICENSE"
];

await rm(DIST_DIR, { recursive: true, force: true });
await mkdir(DIST_DIR, { recursive: true });

for (const target of COPY_TARGETS) {
  await cp(target, `${DIST_DIR}/${target}`, { recursive: true });
}
