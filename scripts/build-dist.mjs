import { cp, mkdir, rm } from "node:fs/promises";

const DIST_DIR = "dist";
const COPY_TARGETS = [
  "_locales",
  "images",
  "styles",
  "src",
  "vendor",
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
