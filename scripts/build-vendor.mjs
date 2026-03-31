import { mkdir } from "node:fs/promises";

// Vendor scripts are no longer needed for page bundles.
// React, ReactDOM, JSZip, source-map-js, and antd are all bundled
// by esbuild via the JSX entry points in build-dist.mjs.
// This script is kept for backward compatibility but is now a no-op.

await mkdir("vendor", { recursive: true });

console.log("Vendor build: all dependencies are now bundled via esbuild entry points.");
