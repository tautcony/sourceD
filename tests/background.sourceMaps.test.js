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

  it("respects a custom maxBytes limit passed to fetchTextWithLimits", async () => {
    const customMax = 10;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: () => String(customMax + 1) },
      text: () => Promise.resolve("ignored"),
    });
    await expect(fetchTextWithLimits("https://example.com/small-limit.js", undefined, customMax)).rejects.toThrow("response too large");
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

  it("honours custom fetchDelayMs, fetchTimeoutMs, and maxMapBytes from getSettings", async () => {
    const state = { pendingSourceMapFetches: new Set() };
    const callback = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Custom delay of 100ms — should NOT fire at 50ms, should fire at 100ms
    const getSettings = vi.fn(() => ({ fetchDelayMs: 100, fetchTimeoutMs: 500, maxMapBytes: 20 }));
    const fetchSourceMap = createSourceMapFetcher(state, getSettings);

    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      headers: { get: () => "8" },
      text: () => Promise.resolve("console.log(1)"),
    }));

    fetchSourceMap("https://example.com/delay-test.js", callback);
    await vi.advanceTimersByTimeAsync(50);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Custom maxMapBytes of 20 — content-length of 21 should be rejected
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "21" },
      text: () => Promise.resolve("ignored"),
    });
    fetchSourceMap("https://example.com/big-for-limit.js", callback);
    await vi.advanceTimersByTimeAsync(100);
    expect(warn).toHaveBeenCalledWith("[SourceD] js fetch error:", expect.any(Error));

    // Custom fetchTimeoutMs of 500 — stalled fetch should abort at 500ms
    warn.mockClear();
    globalThis.fetch = vi.fn((_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    fetchSourceMap("https://example.com/stall-custom.js", callback);
    await vi.advanceTimersByTimeAsync(600);
    expect(warn).toHaveBeenCalledWith("[SourceD] js fetch error:", expect.anything());
  });
});
