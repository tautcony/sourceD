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
    const fakeDb = { objectStoreNames: { contains: () => false }, createObjectStore: vi.fn() };
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
});
