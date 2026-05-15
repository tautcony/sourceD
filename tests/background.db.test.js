import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbModule from "../src/background/db.mjs";
import { state } from "../src/background/shared.mjs";

function requestStub() {
  return { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
}

describe("background db adapters", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    state.dbPromise = null;
    state.storageReadyPromise = null;
  });

  it("handles open success, error and blocked cases", async () => {
    const openReq = requestStub();
    const fakeDb = { objectStoreNames: { contains: (name) => name === "sourceMaps" }, createObjectStore: vi.fn(), deleteObjectStore: vi.fn(), version: 3 };
    openReq.result = fakeDb;
    globalThis.indexedDB = {
      open: vi.fn(() => {
        queueMicrotask(() => {
          openReq.onupgradeneeded?.();
          openReq.onsuccess?.();
        });
        return openReq;
      }),
    };

    await expect(dbModule.getDb()).resolves.toBe(fakeDb);
    expect(fakeDb.createObjectStore).toHaveBeenCalledTimes(3);
    expect(fakeDb.deleteObjectStore).toHaveBeenCalledWith("sourceMaps");

    state.dbPromise = null;
    const errReq = requestStub();
    errReq.error = new Error("open exploded");
    globalThis.indexedDB.open = vi.fn(() => {
      queueMicrotask(() => errReq.onerror?.());
      return errReq;
    });
    await expect(dbModule.getDb()).rejects.toThrow("open exploded");

    state.dbPromise = null;
    const blockedReq = requestStub();
    globalThis.indexedDB.open = vi.fn(() => {
      queueMicrotask(() => blockedReq.onblocked?.());
      return blockedReq;
    });
    await expect(dbModule.getDb()).rejects.toThrow("indexedDB open blocked");
  });

  it("covers ensureStorageReady success and reset-on-failure", async () => {
    const rebuildIndexes = vi.spyOn(await import("../src/background/shared.mjs"), "rebuildIndexes");
    const refreshBadge = vi.spyOn(await import("../src/background/shared.mjs"), "refreshBadgeForActiveTab").mockImplementation(() => {});
    const successReq = (result) => {
      const req = { result, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    };
    const fakeDb = {
      objectStoreNames: { contains: () => true },
      createObjectStore: vi.fn(),
      transaction: vi.fn((store) => ({
        objectStore: vi.fn(() => ({
          getAll: vi.fn(() => successReq(store === "pageVersions" ? [{ id: "v1" }] : [{ id: "b1" }])),
        })),
      })),
    };
    const openReq = requestStub();
    openReq.result = fakeDb;
    globalThis.indexedDB = {
      open: vi.fn(() => {
        queueMicrotask(() => openReq.onsuccess?.());
        return openReq;
      }),
    };

    await expect(dbModule.ensureStorageReady()).resolves.toEqual(fakeDb);
    expect(rebuildIndexes).toHaveBeenCalledWith([{ id: "v1" }], [{ id: "b1" }]);
    expect(fakeDb.transaction).toHaveBeenCalledTimes(2);
    expect(fakeDb.transaction).not.toHaveBeenCalledWith("versionMaps", expect.anything());
    expect(refreshBadge).toHaveBeenCalled();

    state.dbPromise = null;
    state.storageReadyPromise = null;
    const errReq = requestStub();
    errReq.error = new Error("ready fail");
    globalThis.indexedDB.open = vi.fn(() => {
      queueMicrotask(() => errReq.onerror?.());
      return errReq;
    });
    await expect(dbModule.ensureStorageReady()).rejects.toThrow("ready fail");
    expect(state.storageReadyPromise).toBeNull();
  });

  it("covers raw store readers success and failure branches", async () => {
    const successReq = (result) => {
      const req = { result, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    };
    const errorReq = () => {
      const req = { result: null, error: new Error("req fail"), onsuccess: null, onerror: null };
      queueMicrotask(() => req.onerror?.());
      return req;
    };

    const successDb = {
      transaction: vi.fn((store) => ({
        objectStore: vi.fn(() => ({
          getAll: vi.fn(() => successReq([{ id: store }])),
          get: vi.fn((key) => successReq(key === "v1::a.map" ? "raw" : { content: "blob" })),
        })),
      })),
    };

    await expect(dbModule.listAllVersionsRaw(successDb)).resolves.toEqual([{ id: "pageVersions" }]);
    await expect(dbModule.listAllBlobsRaw(successDb)).resolves.toEqual([{ id: "mapBlobs" }]);
    await expect(dbModule.loadStoredMapEntriesRaw(successDb, [])).resolves.toEqual([]);
    await expect(dbModule.loadStoredMapEntriesRaw(successDb, [{ id: "v1", mapUrls: ["a.map"] }])).resolves.toEqual([
      { key: "v1::a.map", meta: { id: "v1", mapUrls: ["a.map"] }, mapUrl: "a.map", value: "raw" },
    ]);
    await expect(dbModule.loadVersionRefsRaw(successDb, null)).resolves.toEqual([]);
    await expect(dbModule.loadVersionRefsRaw(successDb, { id: "v1", pageUrl: "https://example.com", siteKey: "https://example.com", mapUrls: ["a.map"] })).resolves.toEqual([
      expect.objectContaining({
        versionId: "v1",
        mapUrl: "a.map",
        siteKey: "https://example.com",
        mapHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        blobId: expect.stringMatching(/^https:\/\/example\.com::[0-9a-f]{64}$/),
        rawContent: "raw",
      }),
    ]);
    await expect(dbModule.loadBlobContentsRaw(successDb, [null])).resolves.toEqual({});

    const errorDb = {
      transaction: vi.fn(() => ({
        objectStore: vi.fn(() => ({
          getAll: vi.fn(() => errorReq()),
          get: vi.fn(() => errorReq()),
        })),
      })),
    };

    await expect(dbModule.listAllVersionsRaw(errorDb)).rejects.toThrow("req fail");
    await expect(dbModule.listAllBlobsRaw(errorDb)).rejects.toThrow("req fail");
    await expect(dbModule.loadStoredMapEntriesRaw(errorDb, [{ id: "v1", mapUrls: ["a.map"] }])).rejects.toThrow("req fail");
    await expect(dbModule.loadVersionRefsRaw(errorDb, { id: "v1", pageUrl: "https://example.com", mapUrls: ["a.map"] })).rejects.toThrow("req fail");
    await expect(dbModule.loadBlobContentsRaw(errorDb, ["blob"])).rejects.toThrow("req fail");
  });

  it("loadVersionRefsRaw reads stored object refs and skips null values", async () => {
    const objectRef = { mapUrl: "a.map", blobId: "site::hash", byteSize: 10, mapHash: "hash" };
    const successDb = {
      transaction: vi.fn(() => ({
        objectStore: vi.fn(() => ({
          get: vi.fn((key) => {
            const req = { result: null, error: null, onsuccess: null, onerror: null };
            queueMicrotask(() => {
              // "v1::a.map" → stored object ref (not string); "v1::b.map" → null (missing)
              req.result = key === "v1::a.map" ? objectRef : null;
              req.onsuccess?.();
            });
            return req;
          }),
        })),
      })),
    };

    // Stored as object ref (not string) → uses `else if (value != null)` path
    const refs = await dbModule.loadVersionRefsRaw(successDb, {
      id: "v1",
      pageUrl: "https://example.com",
      siteKey: "https://example.com",
      mapUrls: ["a.map", "b.map"],
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe(objectRef);

    // Empty mapUrls → fast-path empty resolve
    const empty = await dbModule.loadVersionRefsRaw(successDb, { id: "v1", mapUrls: [] });
    expect(empty).toEqual([]);
  });

  it("loadBlobContentsRaw deduplicates blobIds and skips blobs without content", async () => {
    const successDb = {
      transaction: vi.fn(() => ({
        objectStore: vi.fn(() => ({
          get: vi.fn((blobId) => {
            const req = { result: null, error: null, onsuccess: null, onerror: null };
            queueMicrotask(() => {
              // "blob-a" has no content, "blob-b" has content
              if (blobId === "blob-a") req.result = { id: "blob-a", compression: "identity", content: null };
              else if (blobId === "blob-b") req.result = { id: "blob-b", compression: "identity", content: "hello" };
              req.onsuccess?.();
            });
            return req;
          }),
        })),
      })),
    };

    // Duplicate blobIds → deduplication, only 1 store.get call per unique id
    const result = await dbModule.loadBlobContentsRaw(successDb, ["blob-b", "blob-b", "blob-a"]);
    // blob-a has null content → skipped; blob-b has content
    expect(result["blob-b"]).toBe("hello");
    expect("blob-a" in result).toBe(false);

    // All duplicates → ids array is empty → fast path resolve
    const result2 = await dbModule.loadBlobContentsRaw(successDb, ["blob-b", "blob-b"]);
    expect(result2["blob-b"]).toBe("hello");
  });

  it("getDb onupgradeneeded records fromVersion from req.transaction.db.version", async () => {
    const fakeDb = {
      objectStoreNames: { contains: () => true },
      createObjectStore: vi.fn(),
      deleteObjectStore: vi.fn(),
      version: 4,
    };
    const openReq = {
      result: fakeDb,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
      transaction: { db: { version: 3 } },
    };
    globalThis.indexedDB = {
      open: vi.fn(() => {
        queueMicrotask(() => {
          openReq.onupgradeneeded?.();
          openReq.onsuccess?.();
        });
        return openReq;
      }),
    };

    state.dbPromise = null;
    await dbModule.getDb();
    // state.lastDbMaintenance.fromVersion should use the transaction.db.version (3)
    expect(state.lastDbMaintenance?.fromVersion).toBe(3);
  });
});
