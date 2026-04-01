import { beforeEach, describe, expect, it, vi } from "vitest";

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve());
}

function createRequest(result, error = null) {
  const req = { result, error, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    if (error) req.onerror?.();
    else req.onsuccess?.();
  });
  return req;
}

function createInMemoryDb() {
  const stores = {
    pageVersions: new Map(),
    versionMaps: new Map(),
    mapBlobs: new Map(),
  };

  function objectStore(name) {
    const store = stores[name];
    return {
      getAll: () => createRequest(Array.from(store.values())),
      get: (key) => createRequest(store.get(key)),
      put: (value, key) => {
        const recordKey = key ?? value.id;
        store.set(recordKey, value);
        return createRequest(value);
      },
      delete: (key) => {
        store.delete(key);
        return createRequest(undefined);
      },
      clear: () => {
        store.clear();
        return createRequest(undefined);
      },
    };
  }

  return {
    stores,
    objectStoreNames: {
      contains(name) {
        return Object.prototype.hasOwnProperty.call(stores, name);
      },
    },
    createObjectStore(name) {
      if (!stores[name]) stores[name] = new Map();
      return objectStore(name);
    },
    transaction(storeNames) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      const tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore(name) {
          if (!names.includes(name)) {
            throw new Error(`unexpected store ${name}`);
          }
          return objectStore(name);
        },
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
}

describe("background shared helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    if (!chrome.runtime) chrome.runtime = {};
    chrome.runtime.lastError = null;
    if (!chrome.action) chrome.action = {};
    if (!chrome.tabs) chrome.tabs = {};
    chrome.action.setBadgeText = vi.fn();
    chrome.tabs.get = vi.fn();
    chrome.tabs.query = vi.fn();
  });

  it("handles badge API promise rejection and thrown errors", async () => {
    const shared = await import("../src/background/shared.mjs");

    chrome.action.setBadgeText = vi.fn(() => Promise.reject(new Error("tab gone")));
    shared.setBadgeText(2, 3);
    await flushPromises();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "2", tabId: 3 });

    chrome.action.setBadgeText = vi.fn(() => {
      throw new Error("sync fail");
    });
    expect(() => shared.setBadgeText(0)).not.toThrow();
  });

  it("covers shared index and badge helpers", async () => {
    const shared = await import("../src/background/shared.mjs");

    expect(shared.canonicalPageUrl("https://example.com/app#hash")).toBe("https://example.com/app");
    expect(shared.canonicalPageUrl("not a url")).toBe("not a url");
    expect(shared.pageSiteKey("https://example.com/app")).toBe("https://example.com");
    expect(shared.pageSiteKey("not a url")).toBe("not a url");
    expect(shared.mapStoreKey("v1", "a.map")).toBe("v1::a.map");
    expect(shared.blobStoreKey("https://example.com", "abc")).toBe("https://example.com::abc");
    expect(shared.buildSignatureFromRefs([
      { mapUrl: "b.map", mapHash: "2" },
      { mapUrl: "a.map", mapHash: "1" },
    ])).toBe("a.map#1|b.map#2");
    expect(shared.toBlobMeta(null)).toBeNull();

    shared.state.versionIndex = {
      old: { id: "old", pageUrl: "https://example.com/app", createdAt: "2026-01-01T00:00:00.000Z", mapCount: 1 },
      fresh: { id: "fresh", pageUrl: "https://example.com/app", createdAt: "2026-02-01T00:00:00.000Z", mapCount: 3 },
    };
    shared.state.versionsByPage = { "https://example.com/app": ["old", "fresh"] };
    shared.sortPageVersions("https://example.com/app");
    expect(shared.ensurePageBucket("https://example.com/app")).toEqual(["fresh", "old"]);
    expect(shared.latestVersionForPage("https://example.com/app").id).toBe("fresh");
    expect(shared.pageMapCount("https://example.com/app")).toBe(3);
    expect(shared.pageMapCount("https://none.test")).toBe(0);

    shared.state.tabSessions = { 7: { maps: { a: "1", b: "2" } } };
    expect(shared.sessionMapCount(7)).toBe(2);
    expect(shared.sessionMapCount(8)).toBe(0);

    shared.refreshBadgeForTab(7);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "2", tabId: 7 });

    shared.state.tabSessions = {};
    shared.refreshBadgeForTab(9, "https://example.com/app#hash");
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "3", tabId: 9 });

    chrome.tabs.get = vi.fn((tabId, cb) => cb(null));
    shared.refreshBadgeForTab(10);
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "", tabId: 10 });

    chrome.tabs.get = vi.fn((tabId, cb) => cb({ id: tabId, url: "https://example.com/app#part" }));
    shared.refreshBadgeForTab(11);
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "3", tabId: 11 });

    chrome.tabs.query = vi.fn((_opts, cb) => cb([]));
    shared.refreshBadgeForActiveTab();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });

    chrome.tabs.query = vi.fn((_opts, cb) => cb([{ id: 11, url: "https://example.com/app" }]));
    shared.refreshBadgeForActiveTab();
    expect(chrome.tabs.get).toHaveBeenCalled();
  });

  it("rebuilds indexes from stored versions and blobs", async () => {
    const shared = await import("../src/background/shared.mjs");
    shared.rebuildIndexes(
      [
        { id: "v2", pageUrl: "https://example.com/a", createdAt: "2026-02-01T00:00:00.000Z" },
        { id: "v1", pageUrl: "https://example.com/a", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      [
        { id: "blob-1", siteKey: "https://example.com", mapHash: "h1", byteSize: 10, createdAt: "2026-01-01T00:00:00.000Z", refCount: 2 },
      ],
    );

    expect(shared.state.versionsByPage["https://example.com/a"]).toEqual(["v2", "v1"]);
    expect(shared.state.blobIndex["blob-1"]).toEqual({
      id: "blob-1",
      siteKey: "https://example.com",
      mapHash: "h1",
      byteSize: 10,
      createdAt: "2026-01-01T00:00:00.000Z",
      refCount: 2,
    });
  });

  it("hashString returns a 64-char hex SHA-256 digest", async () => {
    const shared = await import("../src/background/shared.mjs");

    const hash = await shared.hashString("hello");
    expect(typeof hash).toBe("string");
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);

    const hash2 = await shared.hashString("hello");
    expect(hash2).toBe(hash);

    const hashOther = await shared.hashString("world");
    expect(hashOther).not.toBe(hash);
    expect(hashOther).toHaveLength(64);
  });
});

describe("background session helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("covers version-owned update and session lifecycle helpers", async () => {
    vi.doMock("../src/background/storage.mjs", async () => {
      const actual = await vi.importActual("../src/background/storage.mjs");
      return {
        ...actual,
        broadcastSummary: vi.fn(),
        currentSettings: vi.fn(() => ({ autoCleanup: true })),
        persistVersionState: vi.fn(() => Promise.resolve()),
        prunePageHistory: vi.fn(() => Promise.resolve()),
      };
    });

    const shared = await import("../src/background/shared.mjs");
    const sessions = await import("../src/background/sessions.mjs");
    const storage = await import("../src/background/storage.mjs");

    shared.state.versionIndex = {
      owned: {
        id: "owned",
        pageUrl: "https://example.com/app",
        siteKey: "https://example.com",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        signature: "https://example.com/app.js.map#abc",
        mapUrls: ["https://example.com/app.js.map"],
      },
    };
    shared.state.versionsByPage = { "https://example.com/app": ["owned"] };
    shared.state.tabSessions = {};

    const mapHash = await shared.hashString("map-content");
    const stableSession = {
      tabId: 1,
      pageUrl: "https://example.com/app",
      title: "Example",
      maps: { "https://example.com/app.js.map": "map-content" },
      versionId: "owned",
      versionOwned: true,
      signature: "https://example.com/app.js.map#" + mapHash,
      timer: null,
    };
    await sessions.upsertSessionVersion(stableSession);
    expect(storage.persistVersionState).not.toHaveBeenCalled();

    stableSession.signature = "old-signature";
    await sessions.upsertSessionVersion(stableSession);
    expect(storage.persistVersionState).toHaveBeenCalled();
    expect(storage.prunePageHistory).toHaveBeenCalledWith("https://example.com/app");

    const created = sessions.getOrCreateSession({ id: 5, url: "https://example.com/demo#x", title: "" });
    expect(created.pageUrl).toBe("https://example.com/demo");
    expect(created.title).toBe("https://example.com/demo");
    const reused = sessions.getOrCreateSession({ id: 5, url: "https://example.com/demo", title: "Demo" });
    expect(reused).toBe(created);
    expect(reused.title).toBe("Demo");

    const timer = setTimeout(() => {}, 1000);
    shared.state.tabSessions[9] = { timer };
    sessions.cleanupTabSession(9);
    expect(shared.state.tabSessions[9]).toBeUndefined();
    sessions.cleanupTabSession(999);
  });

  it("covers fetchSourceMap non-happy branches and source map validation", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sessions = await import("../src/background/sessions.mjs");

    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: false,
      headers: { get: () => "0" },
      text: () => Promise.resolve(""),
    }));
    const callback = vi.fn();
    sessions.fetchSourceMap("https://example.com/miss.js", callback);
    await vi.advanceTimersByTimeAsync(300);
    expect(callback).not.toHaveBeenCalled();

    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      headers: { get: () => "10" },
      text: () => Promise.resolve("console.log('no map');"),
    }));
    sessions.fetchSourceMap("https://example.com/no-map.js", callback);
    await vi.advanceTimersByTimeAsync(300);
    expect(callback).not.toHaveBeenCalled();

    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      headers: { get: () => "10" },
      text: () => Promise.resolve("//# sourceMappingURL=data:application/json;base64,%%%"),
    }));
    sessions.fetchSourceMap("https://example.com/bad-inline.js", callback);
    await vi.advanceTimersByTimeAsync(300);
    expect(warn).toHaveBeenCalledWith("[SourceD] inline map decode error:", expect.anything());

    globalThis.fetch = vi.fn((url) => {
      if (url.endsWith(".js")) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => "64" },
          text: () => Promise.resolve("//# sourceMappingURL=./app.js.map"),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: { get: () => "0" },
        text: () => Promise.resolve(""),
      });
    });
    sessions.fetchSourceMap("https://example.com/assets/app.js", callback);
    await vi.advanceTimersByTimeAsync(300);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com/assets/app.js.map",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    expect(sessions.isValidSourceMap(")]}'{\"version\":3,\"sources\":[\"a\"],\"sourcesContent\":[\"code\"]}")).toBe(true);
    expect(sessions.isValidSourceMap("{\"version\":3,\"sources\":[],\"sourcesContent\":[]}")).toBe(false);
    expect(sessions.isValidSourceMap("nope")).toBe(false);
    vi.useRealTimers();
  });

  it("covers new-version persist without cleanup and scheduled warning paths", async () => {
    vi.useFakeTimers();
    vi.doMock("../src/background/storage.mjs", async () => {
      const actual = await vi.importActual("../src/background/storage.mjs");
      return {
        ...actual,
        broadcastSummary: vi.fn(),
        currentSettings: vi.fn(() => ({ autoCleanup: false })),
        persistVersionState: vi.fn(() => Promise.reject("persist failed")),
        prunePageHistory: vi.fn(() => Promise.resolve()),
      };
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shared = await import("../src/background/shared.mjs");
    const sessions = await import("../src/background/sessions.mjs");
    const storage = await import("../src/background/storage.mjs");

    chrome.action.setBadgeText = vi.fn();
    shared.state.versionIndex = {};
    shared.state.versionsByPage = {};
    shared.state.tabSessions = {};

    const newSession = {
      tabId: 11,
      pageUrl: "https://example.com/new",
      title: "New",
      maps: { "a.map": "content-a" },
      versionId: null,
      versionOwned: false,
      signature: null,
      timer: null,
    };

    await expect(sessions.upsertSessionVersion(newSession)).rejects.toBe("persist failed");
    expect(storage.prunePageHistory).not.toHaveBeenCalled();

    const scheduledSession = {
      tabId: 12,
      pageUrl: "https://example.com/new",
      title: "New",
      maps: { "a.map": "content-a" },
      versionId: null,
      versionOwned: false,
      signature: null,
      timer: null,
    };
    shared.state.storageCompactionInProgress = true;
    sessions.scheduleSessionPersist(scheduledSession);
    const firstTimer = scheduledSession.timer;
    await vi.advanceTimersByTimeAsync(1400);
    expect(scheduledSession.timer).not.toBe(firstTimer);

    shared.state.storageCompactionInProgress = false;
    await vi.advanceTimersByTimeAsync(1400);
    // advanceTimersByTimeAsync fires the timer but does not await the full async
    // chain inside the timer callback (hashString + persistVersionState rejection).
    // Three additional microtask-flush rounds ensure the SHA-256 digest resolves,
    // buildSessionArtifacts completes, persistVersionState rejects, and the .catch()
    // handler runs – so console.warn is recorded before the assertion.
    await flushPromises();
    await flushPromises();
    await flushPromises();
    expect(warn).toHaveBeenCalledWith("[SourceD] version save failed:", "persist failed");
    vi.useRealTimers();
  });

  it("covers owned-version updates when auto cleanup is disabled", async () => {
    vi.doMock("../src/background/storage.mjs", async () => {
      const actual = await vi.importActual("../src/background/storage.mjs");
      return {
        ...actual,
        broadcastSummary: vi.fn(),
        currentSettings: vi.fn(() => ({ autoCleanup: false })),
        persistVersionState: vi.fn(() => Promise.resolve()),
        prunePageHistory: vi.fn(() => Promise.resolve()),
      };
    });

    const shared = await import("../src/background/shared.mjs");
    const sessions = await import("../src/background/sessions.mjs");
    const storage = await import("../src/background/storage.mjs");

    shared.state.versionIndex = {
      owned: {
        id: "owned",
        pageUrl: "https://example.com/app",
        siteKey: "https://example.com",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        signature: "old-signature",
        mapUrls: ["https://example.com/app.js.map"],
      },
    };
    shared.state.versionsByPage = { "https://example.com/app": ["owned"] };

    const session = {
      tabId: 1,
      pageUrl: "https://example.com/app",
      title: "Example",
      maps: { "https://example.com/app.js.map": "map-content" },
      versionId: "owned",
      versionOwned: true,
      signature: "old-signature",
      timer: null,
    };

    await expect(sessions.upsertSessionVersion(session)).resolves.toBeUndefined();
    expect(storage.persistVersionState).toHaveBeenCalled();
    expect(storage.prunePageHistory).not.toHaveBeenCalled();
  });
});

describe("background storage helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("../src/background/storage.mjs");
    if (!chrome.storage) chrome.storage = {};
    if (!chrome.storage.local) chrome.storage.local = {};
    chrome.storage.local.get = vi.fn((_keys, cb) => cb({ settings: { retentionDays: 7 } }));
    chrome.storage.local.set = vi.fn((_payload, cb) => cb());
  });

  it("loads and saves settings with defaults", async () => {
    const storage = await import("../src/background/storage.mjs");
    const settings = await storage.loadSettings();
    expect(settings).toEqual({
      retentionDays: 7,
      maxVersionsPerPage: 10,
      autoCleanup: true,
      detectionEnabled: true,
    });

    await storage.saveSettings({ detectionEnabled: false });
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ detectionEnabled: false }),
      }),
      expect.any(Function),
    );
  });

  it("covers import, summary, prune, clear and delete helpers", async () => {
    const shared = await import("../src/background/shared.mjs");
    const storage = await import("../src/background/storage.mjs");
    const db = createInMemoryDb();

    chrome.tabs.query = vi.fn((_opts, cb) => cb([]));
    chrome.action = { setBadgeText: vi.fn() };
    shared.state.dbPromise = null;
    shared.state.storageReadyPromise = null;
    globalThis.indexedDB = {
      open: vi.fn(() => {
        const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req;
      }),
    };

    shared.state.settings = { retentionDays: 30, maxVersionsPerPage: 1, autoCleanup: true, detectionEnabled: true };
    shared.state.versionIndex = {
      older: {
        id: "older",
        pageUrl: "https://example.com/app",
        siteKey: "https://example.com",
        title: "Older",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        mapUrls: ["a.map"],
        mapCount: 1,
        byteSize: 5,
        signature: "sig-older",
      },
    };
    shared.state.versionsByPage = { "https://example.com/app": ["older"] };
    shared.state.popupPorts = [
      { postMessage: vi.fn() },
      { postMessage: vi.fn(() => { throw new Error("disconnect"); }) },
    ];
    shared.state.tabSessions = {
      1: { pageUrl: "https://example.com/app", timer: setTimeout(() => {}, 1000), maps: { a: "1" }, versionId: "older", versionOwned: true, signature: "sig" },
      2: { pageUrl: "https://example.com/other", timer: null, maps: { b: "2" }, versionId: "other", versionOwned: true, signature: "sig2" },
    };
    shared.state.blobIndex = {
      "https://example.com::h1": { id: "https://example.com::h1", siteKey: "https://example.com", byteSize: 5, refCount: 1 },
    };

    const port = { postMessage: vi.fn() };
    storage.pushSummary(port);
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "summary" }));
    expect(() => storage.broadcastSummary()).not.toThrow();

    await expect(storage.importSourceMapsForPage({ pageUrl: "", files: [] })).rejects.toThrow("pageUrl is required");
    await expect(storage.importSourceMapsForPage({ pageUrl: "https://example.com/app", files: [] })).rejects.toThrow("No source map files were provided");
    await expect(storage.importSourceMapsForPage({
      pageUrl: "https://example.com/app",
      files: [{ mapUrl: " ", content: "" }],
    })).rejects.toThrow("No valid source map files were provided");

    const created = await storage.importSourceMapsForPage({
      pageUrl: "https://example.com/app",
      files: [{ mapUrl: "a.map", content: "same" }],
    });
    expect(created.reusedExisting).toBe(false);

    const second = await storage.importSourceMapsForPage({
      pageUrl: "https://example.com/app",
      files: [{ mapUrl: "a.map", content: "same" }],
    });
    expect(second.reusedExisting).toBe(true);

    expect(storage.summarizePages()).toHaveLength(1);
    expect(storage.distributionSummary()).toEqual(expect.arrayContaining([
      expect.objectContaining({ siteKey: "https://example.com", mapCount: expect.any(Number), byteSize: expect.any(Number) }),
    ]));
    expect(storage.totalStorageBytes()).toBeGreaterThan(0);

    await storage.prunePageHistory("https://none.test");

    shared.state.versionIndex.newer = {
      id: "newer",
      pageUrl: "https://example.com/app",
      siteKey: "https://example.com",
      title: "Newer",
      createdAt: "2026-03-01T00:00:00.000Z",
      lastSeenAt: "2026-03-01T00:00:00.000Z",
      mapUrls: ["b.map"],
      mapCount: 1,
      byteSize: 5,
      signature: "sig-newer",
    };
    shared.state.versionsByPage["https://example.com/app"] = ["newer", "older"];
    await expect(storage.prunePageHistory("https://example.com/app")).resolves.toBeUndefined();

    expect(() => storage.clearSessionsForPage("https://example.com/app")).not.toThrow();
    expect(() => storage.clearSessionsForSiteKey("https://example.com")).not.toThrow();

    await expect(storage.deletePageHistoryAndSessions("https://example.com/app")).resolves.toBeUndefined();
    await expect(storage.deleteSiteHistoryAndSessions("https://example.com")).resolves.toBeUndefined();
  });

  it("covers raw storage readers and blob fallback helpers", async () => {
    const storage = await import("../src/background/storage.mjs");
    const shared = await import("../src/background/shared.mjs");
    const db = createInMemoryDb();

    shared.state.dbPromise = null;
    shared.state.storageReadyPromise = null;
    globalThis.indexedDB = {
      open: vi.fn(() => {
        const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req;
      }),
    };

    const meta = {
      id: "v1",
      pageUrl: "https://example.com/app",
      siteKey: "https://example.com",
      title: "Example",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      mapUrls: ["a.map", "b.map"],
      mapCount: 2,
      byteSize: 8,
      signature: "sig",
      tabId: 3,
    };
    db.stores.pageVersions.set("v1", meta);
    db.stores.versionMaps.set("v1::a.map", "raw-map-a");
    db.stores.versionMaps.set("v1::b.map", {
      versionId: "v1",
      mapUrl: "b.map",
      siteKey: "https://example.com",
      mapHash: "hash-b",
      blobId: "https://example.com::hash-b",
      byteSize: 4,
    });
    db.stores.mapBlobs.set("https://example.com::hash-b", {
      id: "https://example.com::hash-b",
      siteKey: "https://example.com",
      mapHash: "hash-b",
      content: "blob-map-b",
      createdAt: "2026-01-01T00:00:00.000Z",
      refCount: 1,
    });

    await storage.ensureStorageReady();
    expect((await storage.listAllVersionsRaw(db)).length).toBe(1);
    expect((await storage.listAllBlobsRaw(db)).length).toBe(1);

    const refs = await storage.loadVersionRefsRaw(db, meta);
    expect(refs).toHaveLength(2);
    expect(refs.some((item) => item.rawContent === "raw-map-a")).toBe(true);
    expect(await storage.loadVersionRefsRaw(db, null)).toEqual([]);

    const storedEntries = await storage.loadStoredMapEntriesRaw(db, [meta]);
    expect(storedEntries).toHaveLength(2);

    const blobContents = await storage.loadBlobContentsRaw(db, [null, "https://example.com::hash-b", "https://example.com::hash-b"]);
    expect(blobContents).toEqual({ "https://example.com::hash-b": "blob-map-b" });
    expect(await storage.loadBlobContentsRaw(db, [])).toEqual({});

    shared.state.versionIndex = { v1: meta };
    expect(await storage.loadVersionFiles("missing")).toEqual([]);
  });

  it("covers index removal and compaction stats", async () => {
    const storage = await import("../src/background/storage.mjs");
    const shared = await import("../src/background/shared.mjs");
    const db = createInMemoryDb();

    chrome.tabs.query = vi.fn((_opts, cb) => cb([]));
    chrome.action = { setBadgeText: vi.fn() };
    globalThis.indexedDB = {
      open: vi.fn(() => {
        const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req;
      }),
    };
    shared.state.dbPromise = null;
    shared.state.storageReadyPromise = null;
    shared.state.versionIndex = {
      v2: {
        id: "v2",
        pageUrl: "https://example.com/app",
        siteKey: "https://example.com",
        title: "Example",
        createdAt: "2026-02-01T00:00:00.000Z",
        lastSeenAt: "2026-02-01T00:00:00.000Z",
        mapUrls: ["c.map"],
        mapCount: 1,
        byteSize: 5,
        signature: "sig-v2",
      },
      extra: { id: "extra", pageUrl: "https://example.com/app" },
    };
    shared.state.versionsByPage = { "https://example.com/app": ["v2", "extra"] };
    expect(() => storage.removeVersionsFromIndexes(["v2"])).not.toThrow();

    db.stores.pageVersions.clear();
    db.stores.versionMaps.clear();
    db.stores.mapBlobs.clear();
    db.stores.pageVersions.set("bad", {
      id: "bad",
      pageUrl: "https://example.com/bad",
      siteKey: "https://example.com",
      title: "Bad",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      mapUrls: ["missing.map"],
    });
    db.stores.pageVersions.set("good", {
      id: "good",
      pageUrl: "https://example.com/good",
      siteKey: "https://example.com",
      title: "Good",
      createdAt: "2026-02-01T00:00:00.000Z",
      lastSeenAt: "2026-02-01T00:00:00.000Z",
      mapUrls: ["good.map"],
      mapCount: 1,
      byteSize: 6,
      signature: "sig-good",
    });
    db.stores.versionMaps.set("good::good.map", "good-map");

    shared.state.storageReadyPromise = null;
    shared.state.versionIndex = {};
    shared.state.versionsByPage = {};
    shared.state.blobIndex = {};
    await storage.ensureStorageReady();

    const compacted = await storage.compactStorageData();
    expect(compacted).toEqual(expect.objectContaining({
      invalidVersions: expect.any(Array),
      stats: expect.objectContaining({
        remainingVersions: expect.any(Number),
        remainingMaps: expect.any(Number),
      }),
    }));
    expect(shared.state.storageCompactionInProgress).toBe(false);
  });

  it("covers persist/delete refcount paths, compaction builder branches, and session clearing", async () => {
    const storage = await import("../src/background/storage.mjs");
    const shared = await import("../src/background/shared.mjs");
    const db = createInMemoryDb();

    chrome.tabs.query = vi.fn((_opts, cb) => cb([]));
    chrome.action = { setBadgeText: vi.fn() };
    globalThis.indexedDB = {
      open: vi.fn(() => {
        const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req;
      }),
    };

    shared.state.dbPromise = null;
    shared.state.storageReadyPromise = null;
    shared.state.versionIndex = {};
    shared.state.versionsByPage = {};
    shared.state.tabSessions = {
      1: { pageUrl: "https://example.com/app", timer: setTimeout(() => {}, 1000), maps: { a: "1" }, versionId: "v1", versionOwned: true, signature: "sig" },
      2: { pageUrl: "https://another.test/app", timer: setTimeout(() => {}, 1000), maps: { b: "2" }, versionId: "v2", versionOwned: true, signature: "sig2" },
    };

    await storage.ensureStorageReady();
    shared.state.blobIndex = {
      blob1: { id: "blob1", siteKey: "https://example.com", mapHash: "h1", byteSize: 7, createdAt: "2026-01-01T00:00:00.000Z", refCount: 2 },
    };

    const previousMeta = {
      id: "v1",
      pageUrl: "https://example.com/app",
      siteKey: "https://example.com",
      title: "Old",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      mapUrls: ["a.map"],
      mapCount: 1,
      byteSize: 7,
      signature: "sig-old",
    };
    db.stores.pageVersions.set("v1", previousMeta);
    db.stores.versionMaps.set("v1::a.map", {
      versionId: "v1",
      mapUrl: "a.map",
      siteKey: "https://example.com",
      mapHash: "h1",
      blobId: "blob1",
      byteSize: 7,
    });
    db.stores.mapBlobs.set("blob1", {
      id: "blob1",
      siteKey: "https://example.com",
      mapHash: "h1",
      byteSize: 7,
      content: "old-map",
      createdAt: "2026-01-01T00:00:00.000Z",
      refCount: 2,
    });
    shared.state.versionIndex.v1 = previousMeta;
    shared.state.versionsByPage["https://example.com/app"] = ["v1"];

    const nextMeta = {
      ...previousMeta,
      title: "New",
      lastSeenAt: "2026-03-01T00:00:00.000Z",
      mapUrls: ["b.map"],
      signature: "sig-new",
    };
    const nextRefs = [{
      versionId: "v1",
      mapUrl: "b.map",
      siteKey: "https://example.com",
      mapHash: "h1",
      blobId: "blob1",
      byteSize: 7,
    }];
    await expect(storage.persistVersionState(nextMeta, nextRefs, {}, previousMeta)).resolves.toBeUndefined();
    expect(db.stores.versionMaps.has("v1::a.map")).toBe(false);
    expect(db.stores.versionMaps.get("v1::b.map")).toEqual(expect.objectContaining({ mapUrl: "b.map" }));
    expect(shared.state.blobIndex.blob1.refCount).toBe(2);

    await expect(storage.deleteVersions(["v1"])).resolves.toBeUndefined();
    expect(shared.state.blobIndex.blob1.refCount).toBe(1);

    const compactMeta = {
      id: "keep",
      pageUrl: "https://example.com/app",
      siteKey: "https://example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
      mapUrls: ["raw.map", "record.map", "missing.map"],
    };
    const compacted = await storage.buildCompactedStorageState({
      transaction: () => ({
        objectStore: (name) => ({
          getAll: () => createRequest(name === "mapBlobs" ? [{
            id: "blob-existing",
            siteKey: "https://example.com",
            mapHash: "hash-existing",
            content: "record-content",
            createdAt: "2026-01-01T00:00:00.000Z",
          }] : []),
          get: (key) => createRequest({
            "keep::raw.map": "raw-content",
            "keep::record.map": { mapHash: "hash-existing", blobId: "blob-existing" },
            "keep::missing.map": { mapHash: "missing-hash", blobId: "blob-missing" },
          }[key]),
        }),
      }),
    }, [compactMeta, {
      id: "drop",
      pageUrl: "https://example.com/drop",
      siteKey: "https://example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      mapUrls: ["gone.map"],
    }]);
    expect(compacted.desiredRefs).toHaveLength(2);
    expect(compacted.desiredBlobs).toHaveLength(2);
    expect(compacted.invalidVersions).toEqual([
      expect.objectContaining({ id: "drop", reason: "all_maps_missing" }),
    ]);

    const refreshBadgeForTab = vi.spyOn(shared, "refreshBadgeForTab").mockImplementation(() => {});
    storage.clearSessionsForPage("https://example.com/app");
    expect(shared.state.tabSessions[1]).toEqual(expect.objectContaining({
      maps: {},
      versionId: null,
      versionOwned: false,
      signature: null,
    }));
    expect(refreshBadgeForTab).toHaveBeenCalledWith(1, "https://example.com/app");

    storage.clearSessionsForSiteKey("https://another.test");
    expect(shared.state.tabSessions[2]).toEqual(expect.objectContaining({
      maps: {},
      versionId: null,
      versionOwned: false,
      signature: null,
    }));
    expect(refreshBadgeForTab).toHaveBeenCalledWith(2, "https://another.test/app");
  });

  it("covers storage summary branches and import without auto cleanup", async () => {
    const storage = await import("../src/background/storage.mjs");
    const shared = await import("../src/background/shared.mjs");
    const refreshBadgeForActiveTab = vi.spyOn(shared, "refreshBadgeForActiveTab").mockImplementation(() => {});
    const prunePageHistory = vi.spyOn(storage, "prunePageHistory").mockResolvedValue();

    shared.state.settings = { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: false, detectionEnabled: true };
    shared.state.versionIndex = {
      pageA: {
        id: "pageA",
        pageUrl: "https://example.com/a",
        siteKey: "https://example.com",
        title: "A",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        mapCount: 1,
        byteSize: 1,
        signature: "sig-a",
      },
    };
    shared.state.versionsByPage = {
      "https://example.com/a": ["pageA"],
    };
    shared.state.blobIndex = {
      "blob-only": { id: "blob-only", siteKey: "https://blob-only.test", byteSize: 5, refCount: 1 },
    };

    expect(storage.distributionSummary()).toEqual(expect.arrayContaining([
      expect.objectContaining({ siteKey: "https://blob-only.test", versionCount: 0, mapCount: 1, byteSize: 5 }),
    ]));

    const result = await storage.importSourceMapsForPage({
      pageUrl: "https://example.com/import#hash",
      title: " Imported ",
      files: [
        { mapUrl: "b.map", content: "bbb" },
        { mapUrl: "a.map", content: "aaa" },
      ],
    });
    expect(result).toEqual(expect.objectContaining({ ok: true, reusedExisting: false, importedCount: 2, skippedCount: 0 }));
    expect(shared.state.versionIndex[result.versionId]).toEqual(expect.objectContaining({
      pageUrl: "https://example.com/import",
      title: "Imported",
      mapUrls: ["a.map", "b.map"],
    }));
    expect(prunePageHistory).not.toHaveBeenCalled();
    expect(refreshBadgeForActiveTab).toHaveBeenCalled();

    shared.state.versionsByPage["https://example.com/b"] = ["pageB"];
    shared.state.versionIndex.pageB = {
      id: "pageB",
      pageUrl: "https://example.com/b",
      siteKey: "https://example.com",
      title: "B",
      createdAt: "2026-02-01T00:00:00.000Z",
      lastSeenAt: "2026-02-01T00:00:00.000Z",
      mapCount: 1,
      byteSize: 1,
      signature: "sig-b",
    };
    expect(storage.summarizePages().map((item) => item.pageUrl)).toEqual(expect.arrayContaining([
      "https://example.com/import",
      "https://example.com/b",
    ]));
  });
});
