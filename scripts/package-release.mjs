import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const DIST_DIR = "dist";
const RELEASE_DIR = "releases";

async function addDirectory(zip, dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await addDirectory(zip, abs, rel);
      continue;
    }
    const data = await readFile(abs);
    zip.file(rel, data);
  }
}

const manifest = JSON.parse(await readFile(path.join(DIST_DIR, "manifest.json"), "utf8"));
const fileName = `SourceD-v${manifest.version}.zip`;

await mkdir(RELEASE_DIR, { recursive: true });

const zip = new JSZip();
await addDirectory(zip, DIST_DIR);

const output = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 }
});

await writeFile(path.join(RELEASE_DIR, fileName), output);
console.log(`Created ${path.join(RELEASE_DIR, fileName)}`);
