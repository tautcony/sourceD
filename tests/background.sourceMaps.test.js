import { beforeEach, describe, expect, it, vi } from "vitest";
import { base64ToUtf8, createSourceMapFetcher, fetchTextWithLimits, resolveSourceMapUrl } from "../src/background/sourceMaps.mjs";

describe("background sourceMaps", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  it("decodes utf8 base64 and resolves relative urls", () => {
    const raw = '{"msg":"你好"}';
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(raw)));
    expect(base64ToUtf8(encoded)).toBe(raw);
    expect(resolveSourceMapUrl("https://example.com/js/app.js", "./app.js.map")).toBe("https://example.com/js/app.js.map");
    expect(resolveSourceMapUrl("https://example.com/js/app.js", "https://cdn.test/app.js.map")).toBe("https://cdn.test/app.js.map");
  });

  it("enforces response size by content-length and actual bytes", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => String(51 * 1024 * 1024) },
        text: () => Promise.resolve("ignored"),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "1" },
        text: () => Promise.resolve("small"),
      });

    await expect(fetchTextWithLimits("https://example.com/big.js", undefined)).rejects.toThrow("response too large");

    const OriginalTextEncoder = globalThis.TextEncoder;
    globalThis.TextEncoder = class {
      encode() {
        return { length: 51 * 1024 * 1024 };
      }
    };
    try {
      await expect(fetchTextWithLimits("https://example.com/actual-big.js", undefined)).rejects.toThrow("response too large");
    } finally {
      globalThis.TextEncoder = OriginalTextEncoder;
    }
  });

  it("covers fetcher guard rails and error branches", async () => {
    const state = { pendingSourceMapFetches: new Set() };
    const callback = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: false,
      headers: { get: () => "0" },
      text: () => Promise.resolve(""),
    }));

    const fetchSourceMap = createSourceMapFetcher(state);
    fetchSourceMap("https://example.com/nope.js", callback);
    fetchSourceMap("https://example.com/nope.js", callback);
    await vi.advanceTimersByTimeAsync(300);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();

    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      headers: { get: () => "8" },
      text: () => Promise.resolve("console.log(1)"),
    }));
    fetchSourceMap("https://example.com/no-map.js", callback);
    await vi.advanceTimersByTimeAsync(300);
    expect(callback).not.toHaveBeenCalled();

    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      headers: { get: () => "8" },
      text: () => Promise.resolve("//# sourceMappingURL=data:application/json;base64,%%%"),
    }));
    fetchSourceMap("https://example.com/bad-inline.js", callback);
    await vi.advanceTimersByTimeAsync(300);
    expect(warn).toHaveBeenCalledWith("[SourceD] inline map decode error:", expect.anything());

    globalThis.fetch = vi.fn((url) => {
      if (url.endsWith(".js")) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => "8" },
          text: () => Promise.resolve("//# sourceMappingURL=./app.js.map"),
        });
      }
      return Promise.reject(new Error("map exploded"));
    });
    fetchSourceMap("https://example.com/app.js", callback);
    await vi.advanceTimersByTimeAsync(300);
    expect(warn).toHaveBeenCalledWith("[SourceD] map fetch error:", expect.any(Error));

    globalThis.fetch = vi.fn((_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    fetchSourceMap("https://example.com/stall.js", callback);
    await vi.advanceTimersByTimeAsync(30_300);
    expect(warn).toHaveBeenCalledWith("[SourceD] js fetch error:", expect.anything());
    expect(state.pendingSourceMapFetches.size).toBeLessThanOrEqual(1);
  });
});
