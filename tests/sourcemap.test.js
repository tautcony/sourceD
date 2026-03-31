import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractSourceFiles, versionZipBaseName, parseSourceMap, downloadGroup } from "../src/popup/sourcemap.mjs";

// A minimal valid source map with embedded sources
function makeSourceMap(sources, sourcesContent) {
  return JSON.stringify({
    version: 3,
    file: "bundle.js",
    sources: sources,
    sourcesContent: sourcesContent,
    mappings: "AAAA",
    names: [],
  });
}

// Mock FileReader for blobToDownload
class MockFileReader {
  readAsDataURL() {
    setTimeout(() => {
      this.result = "data:application/zip;base64,AAAA";
      if (this.onloadend) this.onloadend();
    }, 0);
  }
}

beforeEach(() => {
  globalThis.FileReader = MockFileReader;
  chrome.downloads.download = vi.fn((opts, cb) => { if (cb) cb(1); });
});

describe("extractSourceFiles", () => {
  it("extracts source files from a valid source map", () => {
    const content = makeSourceMap(
      ["src/index.js", "src/utils.js"],
      ['console.log("hello");', 'export function add(a,b){return a+b;}'],
    );
    const files = [{ url: "https://example.com/bundle.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe("src/index.js");
    expect(result[0].content).toBe('console.log("hello");');
    expect(result[1].path).toBe("src/utils.js");
    expect(result[1].content).toBe("export function add(a,b){return a+b;}");
  });

  it("filters out non-user source files", () => {
    const content = makeSourceMap(
      ["src/app.js", "@vite/client", "webpack/bootstrap", "data:text/javascript,void 0"],
      ["const x = 1;", "vite code", "webpack code", "data code"],
    );
    const files = [{ url: "https://example.com/bundle.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/app.js");
  });

  it("normalizes webpack:// paths", () => {
    const content = makeSourceMap(
      ["webpack:///src/main.js"],
      ["import App from './App';"],
    );
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/main.js");
  });

  it("normalizes /@fs/ paths", () => {
    const content = makeSourceMap(
      ["/@fs/Users/dev/project/src/components/Button.vue"],
      ["<template><button/></template>"],
    );
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].path).toContain("src/components/Button.vue");
  });

  it("filters out sources starting with vite/", () => {
    const content = makeSourceMap(
      ["vite/client", "src/app.js"],
      ["vite code", "const x = 1;"],
    );
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/app.js");
  });

  it("filters out sources containing (webpack)", () => {
    const content = makeSourceMap(
      ["(webpack)/buildin/module.js", "src/app.js"],
      ["webpack code", "const x = 1;"],
    );
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/app.js");
  });

  it("filters out sources starting with @id/", () => {
    const content = makeSourceMap(
      ["@id/vite-plugin", "src/index.js"],
      ["id code", "const idx = 1;"],
    );
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/index.js");
  });

  it("filters out sources with null char prefix", () => {
    const content = makeSourceMap(
      ["\0invalid-source", "src/real.js"],
      ["bad", "const r = 1;"],
    );
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/real.js");
  });

  it("includes all valid source names even empty ones as unnamed", () => {
    const content = JSON.stringify({
      version: 3, file: "b.js", sources: ["", "src/ok.js"], sourcesContent: ["bad", "ok"], mappings: "AAAA", names: [],
    });
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(2);
    expect(result[1].path).toBe("src/ok.js");
  });

  it("filters out webpack/runtime paths", () => {
    const content = makeSourceMap(
      ["webpack/runtime/define", "src/app.js"],
      ["runtime code", "app code"],
    );
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/app.js");
  });

  it("handles /@fs/ path without known directory", () => {
    const content = makeSourceMap(
      ["/@fs/unknown/random/deep/nested/file.js"],
      ["const f = 1;"],
    );
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(1);
    // Should strip the fs prefix and some leading dirs
    expect(result[0].path).toContain("file.js");
  });

  it("returns empty array for empty files array", () => {
    expect(extractSourceFiles([])).toEqual([]);
  });

  it("skips files with no content", () => {
    const files = [{ url: "test.map", content: null }];
    const result = extractSourceFiles(files);
    expect(result).toEqual([]);
  });

  it("skips invalid source map content gracefully", () => {
    const files = [{ url: "bad.map", content: "not valid json" }];
    const result = extractSourceFiles(files);
    expect(result).toEqual([]);
  });

  it("handles multiple source map files", () => {
    const content1 = makeSourceMap(["src/a.js"], ["const a = 1;"]);
    const content2 = makeSourceMap(["src/b.js"], ["const b = 2;"]);
    const files = [
      { url: "a.js.map", content: content1 },
      { url: "b.js.map", content: content2 },
    ];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.path)).toEqual(["src/a.js", "src/b.js"]);
  });

  it("skips sources with null content", () => {
    const content = makeSourceMap(["src/a.js", "src/b.js"], ["code a", null]);
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/a.js");
  });

  it("strips leading slashes from paths", () => {
    const content = makeSourceMap(["/src/app.js"], ["const x = 1;"]);
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result[0].path).toBe("src/app.js");
  });

  it("strips ./ prefix from paths", () => {
    const content = makeSourceMap(["./src/app.js"], ["const x = 1;"]);
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result[0].path).toBe("src/app.js");
  });

  it("handles webpack ~/ tilde paths", () => {
    const content = makeSourceMap(
      ["webpack:///~/lodash/lodash.js"],
      ["module.exports = {};"],
    );
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    // ~/lodash/lodash.js should become node_modules/lodash/lodash.js
    expect(result).toHaveLength(1);
    expect(result[0].path).toContain("node_modules/lodash/lodash.js");
  });
});

describe("versionZipBaseName", () => {
  it("generates basename from files and version info", () => {
    const files = [{ page: { url: "https://example.com/app" } }];
    const version = { label: "v1.0.0", createdAt: "2026-01-15T10:30:00Z" };
    const result = versionZipBaseName(files, version);
    expect(result).toContain("example.com");
    expect(result).toContain("v1.0.0");
    expect(result).toContain("2026-01-15");
  });

  it("handles missing page url", () => {
    const files = [{}];
    const version = { label: "test", createdAt: "2026-01-01T00:00:00Z" };
    const result = versionZipBaseName(files, version);
    expect(result).toContain("sourced");
  });

  it("handles empty files array", () => {
    const version = { label: "test", createdAt: "2026-01-01T00:00:00Z" };
    const result = versionZipBaseName([], version);
    expect(result).toContain("sourced");
  });

  it("handles null version", () => {
    const files = [{ page: { url: "https://example.com" } }];
    const result = versionZipBaseName(files, null);
    expect(result).toContain("example.com");
    expect(result).toContain("version");
  });

  it("handles version without createdAt", () => {
    const files = [{ page: { url: "https://example.com" } }];
    const version = { label: "v2" };
    const result = versionZipBaseName(files, version);
    expect(result).toContain("unknown-time");
  });
});

describe("parseSourceMap", () => {
  it("downloads a zip with extracted source files", async () => {
    const content = makeSourceMap(["src/index.js"], ['console.log("hello");']);
    await parseSourceMap("bundle.js.map", content);
    expect(chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "bundle.js.map.zip" }),
      expect.any(Function),
    );
  });

  it("does not download when no extractable sources", async () => {
    const content = makeSourceMap(["webpack/bootstrap"], ["bootstrap code"]);
    chrome.downloads.download = vi.fn();
    await parseSourceMap("bundle.js.map", content);
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });

  it("extracts multiple sources into zip", async () => {
    const content = makeSourceMap(
      ["src/a.js", "src/b.js"],
      ["const a = 1;", "const b = 2;"],
    );
    await parseSourceMap("multi.js.map", content);
    expect(chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "multi.js.map.zip" }),
      expect.any(Function),
    );
  });
});

describe("downloadGroup", () => {
  it("downloads a batch zip of source files", async () => {
    const content = makeSourceMap(["src/app.js"], ["const app = 1;"]);
    const files = [{ url: "https://example.com/bundle.js.map", content }];
    await downloadGroup(files);
    expect(chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: expect.stringContaining(".zip"),
      }),
      expect.any(Function),
    );
  });

  it("uses custom zip base name when provided", async () => {
    const content = makeSourceMap(["src/app.js"], ["const app = 1;"]);
    const files = [{ url: "test.map", content }];
    await downloadGroup(files, null, "custom-name");
    expect(chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "custom-name.zip" }),
      expect.any(Function),
    );
  });

  it("does nothing for empty files array", async () => {
    chrome.downloads.download = vi.fn();
    await downloadGroup([]);
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });

  it("does nothing for null files", async () => {
    chrome.downloads.download = vi.fn();
    await downloadGroup(null);
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });

  it("skips files with missing content and no contentMap", async () => {
    chrome.downloads.download = vi.fn();
    const files = [{ url: "no-content.map" }];
    await downloadGroup(files);
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });

  it("uses contentMap when file content is missing", async () => {
    const content = makeSourceMap(["src/util.js"], ["export default {};"]);
    const files = [{ url: "util.map" }];
    const contentMap = { "util.map": content };
    await downloadGroup(files, contentMap);
    expect(chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: expect.stringContaining(".zip") }),
      expect.any(Function),
    );
  });

  it("handles files with page url", async () => {
    const content = makeSourceMap(["src/main.js"], ["main();"]);
    const files = [{ url: "main.map", content, page: { url: "https://mysite.com/app" } }];
    await downloadGroup(files);
    expect(chrome.downloads.download).toHaveBeenCalled();
  });

  it("works with pathPrefix in downloadGroup batch", async () => {
    const content = makeSourceMap(["src/app.js"], ["const app = 1;"]);
    const files = [{ url: "test.map", content }];
    await downloadGroup(files, null, "prefixed");
    expect(chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "prefixed.zip" }),
      expect.any(Function),
    );
  });

  it("handles source with path segments containing dots and double dots", async () => {
    const content = makeSourceMap(["./src/../src/./index.js"], ['console.log("clean");']);
    const files = [{ url: "map.js.map", content }];
    const result = extractSourceFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].path).toContain("index.js");
  });

  it("downloadGroup with mixed filtered and valid sources covers appendFilesToZip branches", async () => {
    // Source map with both filtered (webpack/bootstrap) and valid sources
    const content = makeSourceMap(
      ["webpack/bootstrap", "src/app.js", "webpack/runtime/thing"],
      ["bootstrap code", "const app = 1;", "runtime code"],
    );
    const files = [{ url: "mix.map", content }];
    await downloadGroup(files, null, "mixtest");
    expect(chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "mixtest.zip" }),
      expect.any(Function),
    );
  });

  it("downloadGroup with source having null sourceContent covers content guard", async () => {
    // Source map where a source has no content (sourcesContent entry is null)
    const content = JSON.stringify({
      version: 3, file: "b.js",
      sources: ["src/a.js", "src/b.js"],
      sourcesContent: [null, "const b = 2;"],
      mappings: "AAAA", names: [],
    });
    const files = [{ url: "partial.map", content }];
    await downloadGroup(files, null, "partial");
    expect(chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "partial.zip" }),
      expect.any(Function),
    );
  });

  it("parseSourceMap filters non-user sources and null content", async () => {
    const content = JSON.stringify({
      version: 3, file: "c.js",
      sources: ["webpack/bootstrap", "src/ok.js", "src/nodata.js"],
      sourcesContent: ["boot", "const ok = 1;", null],
      mappings: "AAAA", names: [],
    });
    await parseSourceMap("filter.js.map", content);
    expect(chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "filter.js.map.zip" }),
      expect.any(Function),
    );
  });

  it("extractSourceFiles handles source map with null values in sources array", () => {
    // source-map-js converts null to string "null", so the isUserSourceFile check doesn't filter it
    const content = JSON.stringify({
      version: 3, file: "d.js",
      sources: [null, "src/valid.js"],
      sourcesContent: ["null content", "valid content"],
      mappings: "AAAA", names: [],
    });
    const files = [{ url: "null-source.map", content }];
    const result = extractSourceFiles(files);
    // Both sources are present since null becomes "null" string
    expect(result).toHaveLength(2);
    expect(result[1].path).toBe("src/valid.js");
  });
});
