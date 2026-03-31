import { describe, it, expect } from "vitest";
import {
  i18nMessage, sanitizeFilename, sanitizePath, fileSizeIEC,
  parseFileName, sourceMapTreePath, uiLocale, formatTime,
} from "../src/shared/utils.mjs";

describe("i18nMessage", () => {
  it("returns chrome.i18n message for known key", () => {
    expect(i18nMessage("popupHeaderTitle")).toBe("SourceD");
  });

  it("returns key as fallback for unknown key", () => {
    expect(i18nMessage("nonExistentKey")).toBe("nonExistentKey");
  });

  it("passes substitutions through", () => {
    expect(i18nMessage("popupStoredVersions", ["5"])).toBe("5 versions");
  });
});

describe("sanitizeFilename", () => {
  it("strips illegal characters", () => {
    expect(sanitizeFilename('file<>:"/\\|?*.js')).toBe("file_________.js");
  });

  it("returns unnamed for empty string", () => {
    expect(sanitizeFilename("")).toBe("unnamed");
  });

  it("returns unnamed for null/undefined", () => {
    expect(sanitizeFilename(null)).toBe("unnamed");
    expect(sanitizeFilename(undefined)).toBe("unnamed");
  });

  it("truncates long filenames", () => {
    const long = "a".repeat(250) + ".txt";
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toMatch(/\.txt$/);
  });

  it("strips leading/trailing dots and spaces", () => {
    expect(sanitizeFilename("...file...")).toBe("file");
  });
});

describe("sanitizePath", () => {
  it("cleans each segment", () => {
    expect(sanitizePath("src/utils/helper.js")).toBe("src/utils/helper.js");
  });

  it("returns unnamed for empty", () => {
    expect(sanitizePath("")).toBe("unnamed");
    expect(sanitizePath(null)).toBe("unnamed");
  });
});

describe("fileSizeIEC", () => {
  it("returns 0 Bytes for 0", () => {
    expect(fileSizeIEC(0)).toBe("0 Bytes");
  });

  it("formats bytes without decimals", () => {
    expect(fileSizeIEC(512)).toBe("512 Bytes");
  });

  it("formats kilobytes", () => {
    expect(fileSizeIEC(1024)).toBe("1.00 KB");
  });

  it("formats megabytes", () => {
    expect(fileSizeIEC(1048576)).toBe("1.00 MB");
  });

  it("formats gigabytes", () => {
    expect(fileSizeIEC(1073741824)).toBe("1.00 GB");
  });

  it("handles fractional sizes", () => {
    expect(fileSizeIEC(1536)).toBe("1.50 KB");
  });
});

describe("parseFileName", () => {
  it("extracts filename from path", () => {
    expect(parseFileName("src/utils/helper.js")).toBe("helper.js");
  });

  it("handles single filename", () => {
    expect(parseFileName("file.js")).toBe("file.js");
  });

  it("handles empty", () => {
    expect(parseFileName("")).toBe("");
  });
});

describe("sourceMapTreePath", () => {
  it("splits URL into host + path segments", () => {
    const result = sourceMapTreePath("https://example.com/assets/main.js.map");
    expect(result).toEqual(["example.com", "assets", "main.js.map"]);
  });

  it("handles URL with no path", () => {
    const result = sourceMapTreePath("https://example.com/");
    expect(result[0]).toBe("example.com");
    expect(result[1]).toBe("index.map");
  });

  it("handles query string", () => {
    const result = sourceMapTreePath("https://example.com/app.js.map?v=123");
    expect(result[result.length - 1]).toContain("v=123");
  });

  it("handles non-URL paths gracefully", () => {
    const result = sourceMapTreePath("relative/path/file.map");
    expect(result).toContain("file.map");
  });
});

describe("uiLocale", () => {
  it("returns en-US for English", () => {
    expect(uiLocale()).toBe("en-US");
  });
});

describe("formatTime", () => {
  it("formats a valid ISO string", () => {
    const result = formatTime("2026-01-15T10:30:00Z");
    expect(result).toMatch(/\d{2}/);
    expect(result.length).toBeGreaterThan(4);
  });

  it("returns Unknown for null input", () => {
    expect(formatTime(null)).toBe("Unknown");
  });

  it("returns Unknown for empty string", () => {
    expect(formatTime("")).toBe("Unknown");
  });
});

describe("branch coverage helpers", () => {
  it("i18nMessage falls back to key when getMessage returns empty", () => {
    const orig = chrome.i18n.getMessage;
    chrome.i18n.getMessage = () => "";
    expect(i18nMessage("someKey")).toBe("someKey");
    chrome.i18n.getMessage = orig;
  });

  it("uiLocale returns zh-CN for zh language", () => {
    const orig = chrome.i18n.getUILanguage;
    chrome.i18n.getUILanguage = () => "zh-CN";
    expect(uiLocale()).toBe("zh-CN");
    chrome.i18n.getUILanguage = orig;
  });

  it("uiLocale falls back to en when getUILanguage returns empty", () => {
    const orig = chrome.i18n.getUILanguage;
    chrome.i18n.getUILanguage = () => "";
    expect(uiLocale()).toBe("en-US");
    chrome.i18n.getUILanguage = orig;
  });

  it("sanitizeFilename returns unnamed when only dots/spaces", () => {
    expect(sanitizeFilename("...")).toBe("unnamed");
    expect(sanitizeFilename("   ")).toBe("unnamed");
  });

  it("sanitizeFilename truncates long name without extension", () => {
    const longNoExt = "a".repeat(250);
    const result = sanitizeFilename(longNoExt);
    expect(result.length).toBe(200);
    expect(result).toBe("a".repeat(200));
  });

  it("sanitizePath returns unnamed for empty path after filter", () => {
    // path segments that are "." or ".." are filtered out
    // but sanitizeFilename converts them to other strings,
    // so use a pure empty path to trigger the fallback
    expect(sanitizePath("")).toBe("unnamed");
    expect(sanitizePath(null)).toBe("unnamed");
  });

  it("sourceMapTreePath handles URL with empty pathname", () => {
    // URL with host only, no trailing slash
    const result = sourceMapTreePath("https://example.com");
    expect(result[0]).toBe("example.com");
  });

  it("sourceMapTreePath hits host fallback for non-HTTP URL with empty pathname", () => {
    // Custom scheme URL has empty pathname (not "/"), triggering sanitizeFilename(host) fallback
    const result = sourceMapTreePath("custom://myhost");
    expect(result[0]).toBe("myhost");
    // Second element should be sanitizeFilename("myhost")
    expect(result[1]).toBe("myhost");
  });

  it("sanitizeFilename returns unnamed when input is empty", () => {
    expect(sanitizeFilename(null)).toBe("unnamed");
  });

  it("sanitizeFilename returns unnamed when input becomes empty after sanitization", () => {
    expect(sanitizeFilename("...")).toBe("unnamed");
  });

  it("sanitizePath logs a warning when input is empty", () => {
    expect(sanitizePath(null)).toBe("unnamed");
  });

  it("sanitizePath collapses parent segments back to root", () => {
    expect(sanitizePath("../../app/node_modules/svelte/src/version.js")).toBe(
      "app/node_modules/svelte/src/version.js",
    );
  });

  it("sanitizePath removes intermediate parent segments", () => {
    expect(sanitizePath("a/../b.js")).toBe("b.js");
  });

  it("sanitizePath keeps root-level names when parent appears first", () => {
    expect(sanitizePath("../a.js")).toBe("a.js");
  });
});
