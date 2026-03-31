import { beforeEach, describe, expect, it, vi } from "vitest";

function createChromeMock() {
  const listeners = {
    onMessage: null,
    onBeforeRequest: null,
  };

  return {
    listeners,
    chrome: {
      runtime: {
        lastError: null,
        onMessage: {
          addListener: vi.fn((fn) => {
            listeners.onMessage = fn;
          }),
        },
        onConnect: {
          addListener: vi.fn(),
        },
      },
      tabs: {
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onActivated: { addListener: vi.fn() },
        get: vi.fn(),
        query: vi.fn(),
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: { addListener: vi.fn() },
      },
      webRequest: {
        onBeforeRequest: {
          addListener: vi.fn((fn) => {
            listeners.onBeforeRequest = fn;
          }),
        },
      },
      action: {
        setBadgeText: vi.fn(),
      },
      storage: {
        local: {
          get: vi.fn(),
          set: vi.fn(),
        },
      },
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("background runtime regressions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("../src/background/storage.mjs");
    vi.doUnmock("../src/background/sessions.mjs");
  });

  it("responds with an error when updateSettings fails", async () => {
    const { chrome, listeners } = createChromeMock();
    globalThis.chrome = chrome;

    vi.doMock("../src/background/storage.mjs", () => ({
      broadcastSummary: vi.fn(),
      compactStorageData: vi.fn(),
      currentSettings: vi.fn(() => ({ detectionEnabled: true })),
      deletePageHistoryAndSessions: vi.fn(),
      deleteSiteHistoryAndSessions: vi.fn(),
      deleteVersions: vi.fn(),
      distributionSummary: vi.fn(() => []),
      ensureStorageReady: vi.fn(() => Promise.resolve()),
      importSourceMapsForPage: vi.fn(),
      loadSettings: vi.fn(() => Promise.resolve({ detectionEnabled: true })),
      loadVersionFiles: vi.fn(() => Promise.resolve([])),
      prunePageHistory: vi.fn(() => Promise.resolve()),
      pushSummary: vi.fn(),
      removeVersionsFromIndexes: vi.fn(),
      saveSettings: vi.fn(() => Promise.reject(new Error("save exploded"))),
      summarizePages: vi.fn(() => []),
      totalStorageBytes: vi.fn(() => 0),
    }));

    vi.doMock("../src/background/sessions.mjs", () => ({
      cleanupTabSession: vi.fn(),
      fetchSourceMap: vi.fn(),
      getOrCreateSession: vi.fn(),
      isValidSourceMap: vi.fn(() => true),
      scheduleSessionPersist: vi.fn(),
    }));

    await import("../src/background/runtime.mjs").then((mod) => mod.registerRuntimeListeners());

    const sendResponse = vi.fn();
    const keepChannel = listeners.onMessage(
      { action: "updateSettings", settings: { detectionEnabled: false } },
      {},
      sendResponse,
    );

    expect(keepChannel).toBe(true);
    await flushPromises();

    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: "save exploded",
    });
  });

  it("does not register request listeners before settings finish loading", async () => {
    const { chrome } = createChromeMock();
    globalThis.chrome = chrome;

    let resolveSettings;
    const loadSettings = vi.fn(() => new Promise((resolve) => {
      resolveSettings = resolve;
    }));
    const ensureStorageReady = vi.fn(() => Promise.resolve());

    vi.doMock("../src/background/storage.mjs", () => ({
      broadcastSummary: vi.fn(),
      compactStorageData: vi.fn(),
      currentSettings: vi.fn(() => ({ detectionEnabled: true })),
      deletePageHistoryAndSessions: vi.fn(),
      deleteSiteHistoryAndSessions: vi.fn(),
      deleteVersions: vi.fn(),
      distributionSummary: vi.fn(() => []),
      ensureStorageReady,
      importSourceMapsForPage: vi.fn(),
      loadSettings,
      loadVersionFiles: vi.fn(() => Promise.resolve([])),
      prunePageHistory: vi.fn(() => Promise.resolve()),
      pushSummary: vi.fn(),
      removeVersionsFromIndexes: vi.fn(),
      saveSettings: vi.fn(() => Promise.resolve()),
      summarizePages: vi.fn(() => []),
      totalStorageBytes: vi.fn(() => 0),
    }));

    vi.doMock("../src/background/sessions.mjs", () => ({
      cleanupTabSession: vi.fn(),
      fetchSourceMap: vi.fn(),
      getOrCreateSession: vi.fn(),
      isValidSourceMap: vi.fn(() => true),
      scheduleSessionPersist: vi.fn(),
    }));

    const runtime = await import("../src/background/runtime.mjs");
    const initPromise = runtime.initializeRuntime();

    expect(chrome.webRequest.onBeforeRequest.addListener).not.toHaveBeenCalled();

    resolveSettings({ detectionEnabled: false });
    await initPromise;

    expect(chrome.webRequest.onBeforeRequest.addListener).toHaveBeenCalledTimes(1);
  });
});

describe("session persistence regressions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("../src/background/storage.mjs");
    vi.doUnmock("../src/background/sessions.mjs");
  });

  it("refreshes lastSeenAt when reusing an existing matching version", async () => {
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

    vi.doUnmock("../src/background/sessions.mjs");

    const shared = await import("../src/background/shared.mjs");
    const sessions = await import("../src/background/sessions.mjs");
    const storage = await import("../src/background/storage.mjs");
    const mapContent = "hello world";
    const mapHash = shared.hashString(mapContent);

    shared.state.versionIndex = {
      existing: {
        id: "existing",
        pageUrl: "https://example.com/app",
        siteKey: "https://example.com",
        title: "Example",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        signature: `https://example.com/app.js.map#${mapHash}`,
        mapUrls: ["https://example.com/app.js.map"],
        mapCount: 1,
        fileCount: 1,
        byteSize: 10,
        tabId: 1,
      },
    };
    shared.state.versionsByPage = {
      "https://example.com/app": ["existing"],
    };
    shared.state.tabSessions = {};

    const session = {
      tabId: 1,
      pageUrl: "https://example.com/app",
      title: "Example",
      maps: {
        "https://example.com/app.js.map": mapContent,
      },
      versionId: null,
      versionOwned: false,
      signature: null,
      timer: null,
    };

    await sessions.upsertSessionVersion(session);

    expect(storage.persistVersionState).toHaveBeenCalledTimes(1);
    const nextMeta = storage.persistVersionState.mock.calls[0][0];
    expect(nextMeta.id).toBe("existing");
    expect(new Date(nextMeta.lastSeenAt).getTime()).toBeGreaterThan(new Date("2026-01-01T00:00:00.000Z").getTime());
  });

  it("does not leave a new version in memory when persistence fails", async () => {
    vi.doMock("../src/background/storage.mjs", async () => {
      const actual = await vi.importActual("../src/background/storage.mjs");
      return {
        ...actual,
        broadcastSummary: vi.fn(),
        currentSettings: vi.fn(() => ({ autoCleanup: false })),
        persistVersionState: vi.fn(() => Promise.reject(new Error("persist exploded"))),
        prunePageHistory: vi.fn(() => Promise.resolve()),
      };
    });

    vi.doUnmock("../src/background/sessions.mjs");

    const shared = await import("../src/background/shared.mjs");
    const sessions = await import("../src/background/sessions.mjs");

    shared.state.versionIndex = {};
    shared.state.versionsByPage = {};
    shared.state.tabSessions = {};

    const session = {
      tabId: 7,
      pageUrl: "https://example.com/app",
      title: "Example",
      maps: {
        "https://example.com/app.js.map": "hello world",
      },
      versionId: null,
      versionOwned: false,
      signature: null,
      timer: null,
    };

    await expect(sessions.upsertSessionVersion(session)).rejects.toThrow("persist exploded");
    expect(Object.keys(shared.state.versionIndex)).toEqual([]);
    expect(shared.state.versionsByPage["https://example.com/app"] || []).toEqual([]);
  });
});

describe("storage compaction regressions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("../src/background/storage.mjs");
    vi.doUnmock("../src/background/sessions.mjs");
  });

  it("keeps partially recoverable versions during compaction", async () => {
    const storage = await import("../src/background/storage.mjs");

    const meta = {
      id: "v1",
      pageUrl: "https://example.com/app",
      siteKey: "https://example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
      mapUrls: ["https://example.com/a.map", "https://example.com/b.map"],
    };

    const mapValues = {
      "v1::https://example.com/a.map": {
        versionId: "v1",
        mapUrl: "https://example.com/a.map",
        siteKey: "https://example.com",
        mapHash: "hash-a",
        blobId: "https://example.com::hash-a",
        byteSize: 8,
      },
      "v1::https://example.com/b.map": {
        versionId: "v1",
        mapUrl: "https://example.com/b.map",
        siteKey: "https://example.com",
        mapHash: "hash-b",
        blobId: "https://example.com::missing",
        byteSize: 8,
      },
    };
    const blobs = [
      {
        id: "https://example.com::hash-a",
        siteKey: "https://example.com",
        mapHash: "hash-a",
        content: "map-a",
        createdAt: "2026-01-01T00:00:00.000Z",
        refCount: 1,
      },
    ];

    const db = {
      transaction: vi.fn((storeName) => ({
        objectStore: vi.fn(() => {
          if (storeName === "versionMaps") {
            return {
              get: vi.fn((key) => {
                const req = { result: mapValues[key] ?? null, onsuccess: null, onerror: null };
                queueMicrotask(() => {
                  if (req.onsuccess) req.onsuccess();
                });
                return req;
              }),
            };
          }

          return {
            getAll: vi.fn(() => {
              const req = { result: blobs, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                if (req.onsuccess) req.onsuccess();
              });
              return req;
            }),
          };
        }),
      })),
    };

    const result = await storage.buildCompactedStorageState(db, [meta]);

    expect(result.invalidVersions).toEqual([]);
    expect(result.desiredRefs).toHaveLength(1);
    expect(result.desiredRefs[0].value.mapUrl).toBe("https://example.com/a.map");
  });
});
