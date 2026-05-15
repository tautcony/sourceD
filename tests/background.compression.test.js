import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { encodeBlobContent, decodeBlobContent } from "../src/background/compression.mjs";

const encoder = new TextEncoder();

describe("background compression helpers", () => {
  let originalCompressionStream;
  let originalDecompressionStream;
  let originalBlob;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalCompressionStream = globalThis.CompressionStream;
    originalDecompressionStream = globalThis.DecompressionStream;
    originalBlob = globalThis.Blob;
  });

  afterEach(() => {
    globalThis.CompressionStream = originalCompressionStream;
    globalThis.DecompressionStream = originalDecompressionStream;
    globalThis.Blob = originalBlob;
  });

  it("falls back to identity for empty content", async () => {
    globalThis.CompressionStream = class {
      constructor() {
        throw new Error("should not be called");
      }
    };

    await expect(encodeBlobContent("")).resolves.toEqual({
      content: "",
      compression: "identity",
      storedByteSize: 0,
      contentByteSize: 0,
    });
  });

  it("falls back to identity and warns when gzip compression throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.CompressionStream = class {
      constructor() {
        throw new Error("gzip boom");
      }
    };

    const result = await encodeBlobContent("hello world");
    expect(result).toEqual({
      content: "hello world",
      compression: "identity",
      storedByteSize: 11,
      contentByteSize: 11,
    });
    expect(warn).toHaveBeenCalledWith("[SourceD] gzip compression failed:", expect.any(Error));
  });

  it("uses stream fallback path and keeps identity when compressed bytes are not smaller", async () => {
    globalThis.Blob = undefined;
    globalThis.CompressionStream = class {
      constructor() {
        this._chunks = [];
        this.writable = {
          getWriter: () => ({
            write: async (bytes) => {
              this._chunks.push(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
              this._chunks.push("skip-non-bytes");
              this._chunks.push(new Uint8Array(0));
            },
            close: async () => {},
          }),
        };
        this.readable = {
          getReader: () => {
            let index = 0;
            return {
              read: async () => {
                if (index >= this._chunks.length) return { done: true, value: undefined };
                const value = this._chunks[index++];
                return { done: false, value };
              },
            };
          },
        };
      }
    };

    const result = await encodeBlobContent("abc");
    expect(result.compression).toBe("identity");
    expect(result.content).toBe("abc");
    expect(result.storedByteSize).toBe(3);
  });

  it("decodes identity content from ArrayBuffer", async () => {
    const bytes = encoder.encode("plain");
    const content = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(content).set(bytes);
    await expect(decodeBlobContent({ compression: "identity", content })).resolves.toBe("plain");
  });

  it("returns stringified content for non-binary records", async () => {
    await expect(decodeBlobContent({ compression: "gzip", content: { value: 1 } })).resolves.toBe("[object Object]");
  });

  it("uses raw text fallback when gzip decompression is unavailable but payload parses as JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.DecompressionStream = undefined;
    const rawText = ")]}'\n{\"ok\":true}";

    await expect(decodeBlobContent({
      compression: "gzip",
      content: encoder.encode(rawText),
    })).resolves.toBe(rawText);

    expect(warn).toHaveBeenCalledWith("[SourceD] gzip decompression unavailable; using raw blob text fallback");
  });

  it("throws when gzip decompression is unavailable and payload is not JSON", async () => {
    globalThis.DecompressionStream = undefined;
    await expect(decodeBlobContent({
      compression: "gzip",
      content: encoder.encode("not-json"),
    })).rejects.toThrow("gzip decompression unavailable");
  });

  it("logs warning and returns raw text when runtime decompression fails for JSON payload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.DecompressionStream = class {
      constructor() {
        throw new Error("decompress fail");
      }
    };

    const rawText = "{\"safe\":1}";
    await expect(decodeBlobContent({
      compression: "gzip",
      content: encoder.encode(rawText),
    })).resolves.toBe(rawText);

    expect(warn).toHaveBeenCalledWith("[SourceD] gzip decompression failed:", expect.any(Error));
  });

  it("rethrows decompression errors for non-JSON payloads", async () => {
    globalThis.DecompressionStream = class {
      constructor() {
        throw new Error("decompress fail");
      }
    };

    await expect(decodeBlobContent({
      compression: "gzip",
      content: encoder.encode("broken"),
    })).rejects.toThrow("decompress fail");
  });

  it("throws for unsupported compression type", async () => {
    await expect(decodeBlobContent({
      compression: "brotli",
      content: encoder.encode("x"),
    })).rejects.toThrow("Unsupported compression type: brotli");
  });

  it("returns null for null/missing record or null content", async () => {
    await expect(decodeBlobContent(null)).resolves.toBeNull();
    await expect(decodeBlobContent(undefined)).resolves.toBeNull();
    await expect(decodeBlobContent({ content: null })).resolves.toBeNull();
    await expect(decodeBlobContent({ content: undefined })).resolves.toBeNull();
  });
});