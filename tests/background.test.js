import { beforeEach, describe, expect, it, vi } from "vitest";

function createChromeMock() {
  const listeners = {
    onMessage: null,
    onBeforeRequest: null,
    onConnect: null,
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
          addListener: vi.fn((fn) => {
            listeners.onConnect = fn;
          }),
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
      cleanupLegacyDataTables: vi.fn(() => Promise.resolve({ changed: false, summary: "Legacy data tables already clean" })),
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
      runCleanupTasks: vi.fn(() => Promise.resolve({ ok: true, error: null, cleaned: [], stats: { removedVersions: 0, removedMaps: 0, reclaimedBytes: 0, remainingVersions: 0, remainingMaps: 0, remainingBytes: 0 }, steps: [] })),
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

  it("does not register listeners if settings loading fails", async () => {
    const { chrome } = createChromeMock();
    globalThis.chrome = chrome;

    vi.doMock("../src/background/storage.mjs", () => ({
      broadcastSummary: vi.fn(),
      cleanupLegacyDataTables: vi.fn(() => Promise.resolve({ changed: false, summary: "Legacy data tables already clean" })),
      compactStorageData: vi.fn(),
      currentSettings: vi.fn(() => ({ detectionEnabled: true })),
      deletePageHistoryAndSessions: vi.fn(),
      deleteSiteHistoryAndSessions: vi.fn(),
      deleteVersions: vi.fn(),
      distributionSummary: vi.fn(() => []),
      ensureStorageReady: vi.fn(() => Promise.resolve()),
      importSourceMapsForPage: vi.fn(),
      loadSettings: vi.fn(() => Promise.reject(new Error("settings exploded"))),
      loadVersionFiles: vi.fn(() => Promise.resolve([])),
      prunePageHistory: vi.fn(() => Promise.resolve()),
      pushSummary: vi.fn(),
      removeVersionsFromIndexes: vi.fn(),
      runCleanupTasks: vi.fn(() => Promise.resolve({ ok: true, error: null, cleaned: [], stats: { removedVersions: 0, removedMaps: 0, reclaimedBytes: 0, remainingVersions: 0, remainingMaps: 0, remainingBytes: 0 }, steps: [] })),
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
    await expect(runtime.initializeRuntime()).rejects.toThrow("settings exploded");
    expect(chrome.webRequest.onBeforeRequest.addListener).not.toHaveBeenCalled();
  });

  it("captures clearAll ids before async deletion and reports failures to the popup", async () => {
    const { chrome, listeners } = createChromeMock();
    globalThis.chrome = chrome;

    let resolveDelete;
    const deleteVersions = vi.fn(() => new Promise((resolve) => {
      resolveDelete = resolve;
    }));
    const removeVersionsFromIndexes = vi.fn();
    const broadcastSummary = vi.fn();

    vi.doMock("../src/background/storage.mjs", async () => {
      const actual = await vi.importActual("../src/background/storage.mjs");
      return {
        ...actual,
        broadcastSummary,
        cleanupLegacyDataTables: vi.fn(() => Promise.resolve({ changed: false, summary: "Legacy data tables already clean" })),
        compactStorageData: vi.fn(),
        currentSettings: vi.fn(() => ({ detectionEnabled: true })),
        deletePageHistoryAndSessions: vi.fn(),
        deleteSiteHistoryAndSessions: vi.fn(),
        deleteVersions,
        distributionSummary: vi.fn(() => []),
        ensureStorageReady: vi.fn(() => Promise.resolve()),
        importSourceMapsForPage: vi.fn(),
        loadSettings: vi.fn(() => Promise.resolve({ detectionEnabled: true })),
        loadVersionFiles: vi.fn(() => Promise.resolve([])),
        prunePageHistory: vi.fn(() => Promise.resolve()),
        pushSummary: vi.fn(),
        removeVersionsFromIndexes,
        runCleanupTasks: vi.fn(() => Promise.resolve({ ok: true, error: null, cleaned: [], stats: { removedVersions: 0, removedMaps: 0, reclaimedBytes: 0, remainingVersions: 0, remainingMaps: 0, remainingBytes: 0 }, steps: [] })),
        saveSettings: vi.fn(() => Promise.resolve()),
        summarizePages: vi.fn(() => []),
        totalStorageBytes: vi.fn(() => 0),
      };
    });

    vi.doMock("../src/background/sessions.mjs", () => ({
      cleanupTabSession: vi.fn(),
      fetchSourceMap: vi.fn(),
      getOrCreateSession: vi.fn(),
      isValidSourceMap: vi.fn(() => true),
      scheduleSessionPersist: vi.fn(),
    }));

    const runtime = await import("../src/background/runtime.mjs");
    const shared = await import("../src/background/shared.mjs");

    runtime.registerRuntimeListeners();

    const port = {
      name: "popup",
      postMessage: vi.fn(),
      onDisconnect: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((fn) => {
          port._listener = fn;
        }),
      },
    };

    listeners.onConnect(port);
    shared.state.versionIndex = {
      first: { id: "first", lastSeenAt: "2026-01-01T00:00:00.000Z" },
      second: { id: "second", lastSeenAt: "2026-01-01T00:00:00.000Z" },
    };

    port._listener({ action: "clearAll" });
    shared.state.versionIndex.third = { id: "third", lastSeenAt: "2026-01-01T00:00:00.000Z" };
    resolveDelete();
    await flushPromises();

    expect(deleteVersions).toHaveBeenCalledWith(["first", "second"]);
    expect(removeVersionsFromIndexes).toHaveBeenCalledWith(["first", "second"]);
    expect(broadcastSummary).toHaveBeenCalled();

    deleteVersions.mockImplementationOnce(() => Promise.reject(new Error("delete exploded")));
    port._listener({ action: "clearAll" });
    await flushPromises();

    expect(port.postMessage).toHaveBeenCalledWith({
      type: "error",
      action: "clearAll",
      error: "delete exploded",
    });
  });

  it("returns popup state for current page and latest version files", async () => {
    const { chrome, listeners } = createChromeMock();
    globalThis.chrome = chrome;

    vi.doMock("../src/background/storage.mjs", () => ({
      broadcastSummary: vi.fn(),
      cleanupLegacyDataTables: vi.fn(() => Promise.resolve({ changed: false, summary: "Legacy data tables already clean" })),
      compactStorageData: vi.fn(),
      currentSettings: vi.fn(() => ({ detectionEnabled: true })),
      deletePageHistoryAndSessions: vi.fn(),
      deleteSiteHistoryAndSessions: vi.fn(),
      deleteVersions: vi.fn(),
      distributionSummary: vi.fn(() => []),
      ensureStorageReady: vi.fn(() => Promise.resolve()),
      importSourceMapsForPage: vi.fn(),
      loadSettings: vi.fn(() => Promise.resolve({ detectionEnabled: true })),
      loadVersionFiles: vi.fn(() => Promise.resolve([{ url: "a.map", content: "{}" }])),
      prunePageHistory: vi.fn(() => Promise.resolve()),
      pushSummary: vi.fn(),
      removeVersionsFromIndexes: vi.fn(),
      runCleanupTasks: vi.fn(() => Promise.resolve({ ok: true, error: null, cleaned: [], stats: { removedVersions: 0, removedMaps: 0, reclaimedBytes: 0, remainingVersions: 0, remainingMaps: 0, remainingBytes: 0 }, steps: [] })),
      saveSettings: vi.fn(() => Promise.resolve()),
      summarizePages: vi.fn(() => []),
      totalStorageBytes: vi.fn(() => 12),
    }));

    vi.doMock("../src/background/sessions.mjs", () => ({
      cleanupTabSession: vi.fn(),
      fetchSourceMap: vi.fn(),
      getOrCreateSession: vi.fn(),
      isValidSourceMap: vi.fn(() => true),
      scheduleSessionPersist: vi.fn(),
    }));

    const shared = await import("../src/background/shared.mjs");
    shared.state.versionIndex = {
      v1: {
        id: "v1",
        pageUrl: "https://example.com/app",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-02T00:00:00.000Z",
        mapCount: 1,
        byteSize: 12,
        title: "Example",
      },
    };
    shared.state.versionsByPage = { "https://example.com/app": ["v1"] };

    await import("../src/background/runtime.mjs").then((mod) => mod.registerRuntimeListeners());
    const sendResponse = vi.fn();

    const keepOpen = listeners.onMessage({ action: "getPopupState", pageUrl: "https://example.com/app#hash" }, {}, sendResponse);
    expect(keepOpen).toBe(true);
    await flushPromises();

    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      pageUrl: "https://example.com/app",
      files: [{ url: "a.map", content: "{}" }],
      totalStorageBytes: 12,
    }));
  });

  it("covers dashboard and mutation message handlers", async () => {
    const { chrome, listeners } = createChromeMock();
    globalThis.chrome = chrome;

    const broadcastSummary = vi.fn();
    const compactStorageData = vi.fn(() => Promise.resolve({
      invalidVersions: [{ id: "stale", pageUrl: "https://example.com/app", reason: "all_maps_missing", mapCount: 1 }],
      stats: { removedVersions: 1, removedMaps: 1, reclaimedBytes: 12, remainingVersions: 0, remainingMaps: 0, remainingBytes: 0 },
    }));
    const deleteVersions = vi.fn(() => Promise.resolve());
    const deletePageHistoryAndSessions = vi.fn(() => Promise.resolve());
    const deleteSiteHistoryAndSessions = vi.fn(() => Promise.resolve());
    const importSourceMapsForPage = vi.fn(() => Promise.resolve({ ok: true, reusedExisting: false, importedCount: 1 }));
    const loadVersionFiles = vi.fn(() => Promise.resolve([{ url: "b.map", content: "{}" }]));
    const summarizePages = vi.fn(() => [{ pageUrl: "https://example.com/app" }]);
    const distribution = [{ siteKey: "https://example.com" }];
    const removeVersionsFromIndexes = vi.fn();
    const runCleanupTasks = vi.fn(() => Promise.resolve({
      ok: true,
      error: null,
      cleaned: [{ id: "stale", pageUrl: "https://example.com/app", reason: "all_maps_missing", mapCount: 1 }],
      stats: { removedVersions: 1, removedMaps: 1, reclaimedBytes: 12, remainingVersions: 0, remainingMaps: 0, remainingBytes: 0, upgradedRefs: 4, upgradedVersions: 1 },
      steps: [
        { id: "compact-storage", label: "Compact storage data", ok: true, changed: true, summary: "Compacted storage records: 1 versions, 1 maps, 12 bytes reclaimed, upgraded 4 refs across 1 versions" },
        { id: "cleanup-data-tables", label: "Cleanup legacy data tables", ok: true, changed: true, summary: "Removed 1 legacy data tables", removedTables: ["sourceMaps"] },
      ],
    }));

    vi.doMock("../src/background/storage.mjs", () => ({
      broadcastSummary,
      cleanupLegacyDataTables: vi.fn(() => Promise.resolve({ changed: true, summary: "Removed 1 legacy data tables", removedTables: ["sourceMaps"] })),
      compactStorageData,
      currentSettings: vi.fn(() => ({ detectionEnabled: true })),
      deletePageHistoryAndSessions,
      deleteSiteHistoryAndSessions,
      deleteVersions,
      distributionSummary: vi.fn(() => distribution),
      ensureStorageReady: vi.fn(() => Promise.resolve()),
      importSourceMapsForPage,
      loadSettings: vi.fn(() => Promise.resolve({ detectionEnabled: true })),
      loadVersionFiles,
      prunePageHistory: vi.fn(() => Promise.resolve()),
      pushSummary: vi.fn(),
      removeVersionsFromIndexes,
      runCleanupTasks,
      saveSettings: vi.fn(() => Promise.resolve()),
      summarizePages,
      totalStorageBytes: vi.fn(() => 99),
    }));

    vi.doMock("../src/background/sessions.mjs", () => ({
      cleanupTabSession: vi.fn(),
      fetchSourceMap: vi.fn(),
      getOrCreateSession: vi.fn(),
      isValidSourceMap: vi.fn((raw) => raw === "valid-map"),
      scheduleSessionPersist: vi.fn(),
    }));

    const shared = await import("../src/background/shared.mjs");
    shared.state.versionIndex = { v1: { id: "v1", lastSeenAt: "2026-01-01T00:00:00.000Z" } };
    shared.state.versionsByPage = { "https://example.com/app": ["v1"] };

    await import("../src/background/runtime.mjs").then((mod) => mod.registerRuntimeListeners());

    const dashboardResponse = vi.fn();
    listeners.onMessage({ action: "getDashboardData" }, {}, dashboardResponse);
    expect(dashboardResponse).toHaveBeenCalledWith({
      pages: [{ pageUrl: "https://example.com/app" }],
      distribution,
      settings: { detectionEnabled: true },
      totalVersions: 1,
      totalStorageBytes: 99,
    });

    const versionFilesResponse = vi.fn();
    const keepFiles = listeners.onMessage({ action: "getVersionFiles", versionId: "v1" }, {}, versionFilesResponse);
    expect(keepFiles).toBe(true);
    await flushPromises();
    expect(versionFilesResponse).toHaveBeenCalledWith({ ok: true, files: [{ url: "b.map", content: "{}" }] });

    const deleteResponse = vi.fn();
    listeners.onMessage({ action: "deleteVersion", versionId: "v1" }, {}, deleteResponse);
    await flushPromises();
    expect(deleteVersions).toHaveBeenCalledWith(["v1"]);
    expect(removeVersionsFromIndexes).toHaveBeenCalledWith(["v1"]);
    expect(deleteResponse).toHaveBeenCalledWith({ ok: true });

    const pageDeleteResponse = vi.fn();
    listeners.onMessage({ action: "deletePageHistory", pageUrl: "https://example.com/app#hash" }, {}, pageDeleteResponse);
    await flushPromises();
    expect(deletePageHistoryAndSessions).toHaveBeenCalledWith("https://example.com/app");
    expect(pageDeleteResponse).toHaveBeenCalledWith({ ok: true });

    const siteDeleteResponse = vi.fn();
    listeners.onMessage({ action: "deleteSiteHistory", siteKey: "https://example.com" }, {}, siteDeleteResponse);
    await flushPromises();
    expect(deleteSiteHistoryAndSessions).toHaveBeenCalledWith("https://example.com");
    expect(siteDeleteResponse).toHaveBeenCalledWith({ ok: true });

    const cleanupResponse = vi.fn();
    const keepCleanup = listeners.onMessage({ action: "cleanupData" }, {}, cleanupResponse);
    expect(keepCleanup).toBe(true);
    await flushPromises();
    expect(cleanupResponse).toHaveBeenCalledWith({
      ok: true,
      error: null,
      cleaned: [{ id: "stale", pageUrl: "https://example.com/app", reason: "all_maps_missing", mapCount: 1 }],
      stats: { removedVersions: 1, removedMaps: 1, reclaimedBytes: 12, remainingVersions: 0, remainingMaps: 0, remainingBytes: 0, upgradedRefs: 4, upgradedVersions: 1 },
      steps: [
        { id: "compact-storage", label: "Compact storage data", ok: true, changed: true, summary: "Compacted storage records: 1 versions, 1 maps, 12 bytes reclaimed, upgraded 4 refs across 1 versions" },
        { id: "cleanup-data-tables", label: "Cleanup legacy data tables", ok: true, changed: true, summary: "Removed 1 legacy data tables", removedTables: ["sourceMaps"] },
      ],
    });

    const importResponse = vi.fn();
    const keepImport = listeners.onMessage({
      action: "importSourceMaps",
      pageUrl: "https://example.com/app",
      title: "Example",
      files: [
        { mapUrl: "valid.map", content: "valid-map" },
        { mapUrl: "bad.map", content: "invalid" },
        { name: "unnamed.map", content: "" },
      ],
    }, {}, importResponse);
    expect(keepImport).toBe(true);
    await flushPromises();
    expect(importSourceMapsForPage).toHaveBeenCalledWith({
      pageUrl: "https://example.com/app",
      title: "Example",
      files: [{ mapUrl: "valid.map", content: "valid-map" }],
    });
    expect(importResponse).toHaveBeenCalledWith({
      ok: true,
      reusedExisting: false,
      importedCount: 1,
      rejectedFiles: ["bad.map", "unnamed.map"],
    });
  });

  it("returns empty cleanup stats and propagates popup/import failures", async () => {
    const { chrome, listeners } = createChromeMock();
    globalThis.chrome = chrome;

    vi.doMock("../src/background/storage.mjs", () => ({
      broadcastSummary: vi.fn(),
      cleanupLegacyDataTables: vi.fn(() => Promise.resolve({ changed: false, summary: "Legacy data tables already clean" })),
      compactStorageData: vi.fn(() => Promise.reject(new Error("cleanup exploded"))),
      currentSettings: vi.fn(() => ({ detectionEnabled: true })),
      deletePageHistoryAndSessions: vi.fn(() => Promise.reject(new Error("page exploded"))),
      deleteSiteHistoryAndSessions: vi.fn(() => Promise.reject(new Error("site exploded"))),
      deleteVersions: vi.fn(() => Promise.reject(new Error("delete exploded"))),
      distributionSummary: vi.fn(() => []),
      ensureStorageReady: vi.fn(() => Promise.resolve()),
      importSourceMapsForPage: vi.fn(() => Promise.reject(new Error("import exploded"))),
      loadSettings: vi.fn(() => Promise.resolve({ detectionEnabled: true })),
      loadVersionFiles: vi.fn(() => Promise.reject(new Error("files exploded"))),
      prunePageHistory: vi.fn(() => Promise.resolve()),
      pushSummary: vi.fn(),
      removeVersionsFromIndexes: vi.fn(),
      runCleanupTasks: vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          error: null,
          cleaned: [],
          stats: {
            removedVersions: 0,
            removedMaps: 0,
            reclaimedBytes: 0,
            remainingVersions: 0,
            remainingMaps: 0,
            remainingBytes: 0,
            upgradedRefs: 0,
            upgradedVersions: 0,
          },
          steps: [{ id: "cleanup-data-tables", label: "Cleanup legacy data tables", ok: true, changed: false, summary: "Legacy data tables already clean" }],
        }),
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

    const shared = await import("../src/background/shared.mjs");
    shared.state.versionIndex = {};
    shared.state.versionsByPage = {};

    await import("../src/background/runtime.mjs").then((mod) => mod.registerRuntimeListeners());

    const cleanupResponse = vi.fn();
    listeners.onMessage({ action: "cleanupData" }, {}, cleanupResponse);
    await flushPromises();
    expect(cleanupResponse).toHaveBeenCalledWith({
      ok: true,
      error: null,
      cleaned: [],
      stats: {
        removedVersions: 0,
        removedMaps: 0,
        reclaimedBytes: 0,
        remainingVersions: 0,
        remainingMaps: 0,
        remainingBytes: 0,
        upgradedRefs: 0,
        upgradedVersions: 0,
      },
      steps: [{ id: "cleanup-data-tables", label: "Cleanup legacy data tables", ok: true, changed: false, summary: "Legacy data tables already clean" }],
    });

    const popupState = vi.fn();
    listeners.onMessage({ action: "getPopupState", pageUrl: "https://example.com/app" }, {}, popupState);
    expect(popupState).toHaveBeenCalledWith(expect.objectContaining({ latestVersion: null, ok: true }));

    shared.state.versionIndex = {
      v1: { id: "v1", pageUrl: "https://example.com/app", createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", mapCount: 1, byteSize: 1, title: "Example" },
    };
    shared.state.versionsByPage = { "https://example.com/app": ["v1"] };

    const popupError = vi.fn();
    listeners.onMessage({ action: "getPopupState", pageUrl: "https://example.com/app" }, {}, popupError);
    await flushPromises();
    expect(popupError).toHaveBeenCalledWith({ ok: false, error: "files exploded" });

    const importError = vi.fn();
    listeners.onMessage({
      action: "importSourceMaps",
      pageUrl: "https://example.com/app",
      title: "Example",
      files: [{ mapUrl: "valid.map", content: "valid" }],
    }, {}, importError);
    await flushPromises();
    expect(importError).toHaveBeenCalledWith({ ok: false, error: "import exploded", rejectedFiles: [] });
  });

  it("returns updateSettings failures to the sender", async () => {
    const { chrome, listeners } = createChromeMock();
    globalThis.chrome = chrome;

    vi.doMock("../src/background/storage.mjs", () => ({
      broadcastSummary: vi.fn(),
      cleanupLegacyDataTables: vi.fn(() => Promise.resolve({ changed: false, summary: "Legacy data tables already clean" })),
      compactStorageData: vi.fn(),
      currentSettings: vi.fn(() => ({ detectionEnabled: true })),
      deletePageHistoryAndSessions: vi.fn(),
      deleteSiteHistoryAndSessions: vi.fn(),
      deleteVersions: vi.fn(),
      distributionSummary: vi.fn(() => []),
      ensureStorageReady: vi.fn(() => Promise.resolve()),
      importSourceMapsForPage: vi.fn(() => Promise.resolve({ ok: true })),
      loadSettings: vi.fn(() => Promise.resolve({ detectionEnabled: true })),
      loadVersionFiles: vi.fn(() => Promise.resolve([])),
      prunePageHistory: vi.fn(() => Promise.resolve()),
      pushSummary: vi.fn(),
      removeVersionsFromIndexes: vi.fn(),
      runCleanupTasks: vi.fn(() => Promise.resolve({ ok: true, error: null, cleaned: [], stats: { removedVersions: 0, removedMaps: 0, reclaimedBytes: 0, remainingVersions: 0, remainingMaps: 0, remainingBytes: 0 }, steps: [] })),
      saveSettings: vi.fn(() => Promise.reject(new Error("settings exploded"))),
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
    const keepOpen = listeners.onMessage({ action: "updateSettings", settings: { detectionEnabled: false } }, {}, sendResponse);
    expect(keepOpen).toBe(true);
    await flushPromises();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "settings exploded" });
  });

  it("accepts script requests even when the url is .mjs or extensionless", async () => {
    const { chrome, listeners } = createChromeMock();
    globalThis.chrome = chrome;

    const fetchSourceMap = vi.fn();
    const getOrCreateSession = vi.fn(() => ({ tabId: 7, pageUrl: "https://example.com/app", maps: {} }));

    chrome.tabs.get = vi.fn((tabId, cb) => cb({ id: tabId, url: "https://example.com/app", title: "Example" }));

    vi.doMock("../src/background/storage.mjs", () => ({
      broadcastSummary: vi.fn(),
      cleanupLegacyDataTables: vi.fn(() => Promise.resolve({ changed: false, summary: "Legacy data tables already clean" })),
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
      runCleanupTasks: vi.fn(() => Promise.resolve({ ok: true, error: null, cleaned: [], stats: { removedVersions: 0, removedMaps: 0, reclaimedBytes: 0, remainingVersions: 0, remainingMaps: 0, remainingBytes: 0 }, steps: [] })),
      saveSettings: vi.fn(() => Promise.resolve()),
      summarizePages: vi.fn(() => []),
      totalStorageBytes: vi.fn(() => 0),
    }));

    vi.doMock("../src/background/sessions.mjs", () => ({
      cleanupTabSession: vi.fn(),
      fetchSourceMap,
      getOrCreateSession,
      isValidSourceMap: vi.fn(() => true),
      scheduleSessionPersist: vi.fn(),
    }));

    await import("../src/background/runtime.mjs").then((mod) => mod.registerRuntimeListeners());

    listeners.onBeforeRequest({ type: "script", url: "https://cdn.example.com/app.mjs", tabId: 7 });
    listeners.onBeforeRequest({ type: "script", url: "https://cdn.example.com/assets/runtime", tabId: 7 });

    expect(fetchSourceMap).toHaveBeenCalledWith("https://cdn.example.com/app.mjs", expect.any(Function));
    expect(fetchSourceMap).toHaveBeenCalledWith("https://cdn.example.com/assets/runtime", expect.any(Function));
  });

  it("propagates getVersionFiles, delete and cleanup failures", async () => {
    const { chrome, listeners } = createChromeMock();
    globalThis.chrome = chrome;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.doMock("../src/background/storage.mjs", () => ({
      broadcastSummary: vi.fn(),
      cleanupLegacyDataTables: vi.fn(() => Promise.resolve({ changed: false, summary: "Legacy data tables already clean" })),
      compactStorageData: vi.fn(() => Promise.reject(new Error("cleanup exploded"))),
      currentSettings: vi.fn(() => ({ detectionEnabled: true })),
      deletePageHistoryAndSessions: vi.fn(() => Promise.resolve()),
      deleteSiteHistoryAndSessions: vi.fn(() => Promise.resolve()),
      deleteVersions: vi.fn(() => Promise.reject(new Error("delete exploded"))),
      distributionSummary: vi.fn(() => []),
      ensureStorageReady: vi.fn(() => Promise.resolve()),
      importSourceMapsForPage: vi.fn(() => Promise.resolve({ ok: true })),
      loadSettings: vi.fn(() => Promise.resolve({ detectionEnabled: true })),
      loadVersionFiles: vi.fn(() => Promise.reject(new Error("files exploded"))),
      prunePageHistory: vi.fn(() => Promise.resolve()),
      pushSummary: vi.fn(),
      removeVersionsFromIndexes: vi.fn(),
      runCleanupTasks: vi.fn(() => Promise.reject(new Error("cleanup exploded"))),
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

    const shared = await import("../src/background/shared.mjs");
    shared.state.versionIndex = { v1: { id: "v1", lastSeenAt: "2026-01-01T00:00:00.000Z" } };

    await import("../src/background/runtime.mjs").then((mod) => mod.registerRuntimeListeners());

    const filesResponse = vi.fn();
    listeners.onMessage({ action: "getVersionFiles", versionId: "v1" }, {}, filesResponse);
    await flushPromises();
    expect(filesResponse).toHaveBeenCalledWith({ ok: false, error: "files exploded" });

    const deleteResponse = vi.fn();
    listeners.onMessage({ action: "deleteVersion", versionId: "v1" }, {}, deleteResponse);
    await flushPromises();
    expect(deleteResponse).toHaveBeenCalledWith({ ok: false, error: "delete exploded" });

    const cleanupResponse = vi.fn();
    const keepOpen = listeners.onMessage({ action: "cleanupData" }, {}, cleanupResponse);
    expect(keepOpen).toBe(true);
    await flushPromises();
    expect(consoleError).toHaveBeenCalledWith("[SourceD] cleanup failed:", expect.any(Error));
    expect(cleanupResponse).toHaveBeenCalledWith({
      ok: false,
      error: "cleanup exploded",
      cleaned: [],
      stats: {
        removedVersions: 0,
        removedMaps: 0,
        reclaimedBytes: 0,
        remainingVersions: 0,
        remainingMaps: 0,
        remainingBytes: 0,
      },
      steps: [],
    });
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
    const mapHash = await shared.hashString(mapContent);

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

  it("keeps a new version visible in memory when post-persist pruning fails", async () => {
    vi.doMock("../src/background/storage.mjs", async () => {
      const actual = await vi.importActual("../src/background/storage.mjs");
      return {
        ...actual,
        broadcastSummary: vi.fn(),
        currentSettings: vi.fn(() => ({ autoCleanup: true })),
        persistVersionState: vi.fn(() => Promise.resolve()),
        prunePageHistory: vi.fn(() => Promise.reject(new Error("prune exploded"))),
      };
    });

    const shared = await import("../src/background/shared.mjs");
    const sessions = await import("../src/background/sessions.mjs");

    shared.state.versionIndex = {};
    shared.state.versionsByPage = {};
    shared.state.tabSessions = {};

    const session = {
      tabId: 9,
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

    await expect(sessions.upsertSessionVersion(session)).rejects.toThrow("prune exploded");

    expect(session.versionId).toBeTruthy();
    expect(shared.state.versionIndex[session.versionId]).toBeTruthy();
    expect(shared.state.versionsByPage["https://example.com/app"]).toContain(session.versionId);
  });

  it("detects hash collisions before deduplicating blobs", async () => {
    vi.doMock("../src/background/shared.mjs", async () => {
      const actual = await vi.importActual("../src/background/shared.mjs");
      return {
        ...actual,
        hashString: vi.fn(() => "collision"),
      };
    });

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

    const sessions = await import("../src/background/sessions.mjs");

    await expect(sessions.buildSessionArtifacts({
      pageUrl: "https://example.com/app",
      maps: {
        "https://example.com/a.map": "first",
        "https://example.com/b.map": "second",
      },
    })).rejects.toThrow("hash collision detected");
  });

  it("defers session persistence while storage compaction is in progress", async () => {
    vi.useFakeTimers();

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

    shared.state.storageCompactionInProgress = true;
    shared.state.versionIndex = {};
    shared.state.versionsByPage = {};

    const session = {
      tabId: 3,
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

    sessions.scheduleSessionPersist(session);
    vi.advanceTimersByTime(1400);
    await flushPromises();
    expect(storage.persistVersionState).not.toHaveBeenCalled();

    shared.state.storageCompactionInProgress = false;
    vi.advanceTimersByTime(1400);
    await flushPromises();
    expect(storage.persistVersionState).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
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

  it("rejects blocked IndexedDB openings", async () => {
    const shared = await import("../src/background/shared.mjs");
    shared.state.dbPromise = null;

    globalThis.indexedDB = {
      open: vi.fn(() => {
        const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => {
          req.onblocked?.();
        });
        return req;
      }),
    };

    const storage = await import("../src/background/storage.mjs");

    await expect(storage.getDb()).rejects.toThrow("indexedDB open blocked");
  });
});

describe("fetchSourceMap regressions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  it("times out stalled fetches", async () => {
    globalThis.fetch = vi.fn((_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    }));

    const shared = await import("../src/background/shared.mjs");
    const sessions = await import("../src/background/sessions.mjs");
    const callback = vi.fn();

    sessions.fetchSourceMap("https://example.com/app.js", callback);
    await vi.advanceTimersByTimeAsync(30300);

    expect(callback).not.toHaveBeenCalled();
    expect(shared.state.pendingSourceMapFetches.size).toBeLessThanOrEqual(1);
  });

  it("rejects oversized source map responses", async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url.endsWith(".js")) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => "128" },
          text: () => Promise.resolve("//# sourceMappingURL=https://example.com/app.js.map"),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: { get: () => String(51 * 1024 * 1024) },
        text: () => Promise.resolve("{}"),
      });
    });

    const sessions = await import("../src/background/sessions.mjs");
    const callback = vi.fn();

    sessions.fetchSourceMap("https://example.com/app.js", callback);
    await vi.advanceTimersByTimeAsync(300);

    expect(callback).not.toHaveBeenCalled();
  });

  it("decodes inline UTF-8 source maps correctly", async () => {
    const inlineMap = '{"version":3,"sources":["src/中文.js"],"sourcesContent":["console.log(\\"你好\\")"]}';
    const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(inlineMap)));

    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      headers: { get: () => "128" },
      text: () => Promise.resolve(`//# sourceMappingURL=data:application/json;base64,${base64}`),
    }));

    const sessions = await import("../src/background/sessions.mjs");
    const callback = vi.fn();

    sessions.fetchSourceMap("https://example.com/app.js", callback);
    await vi.advanceTimersByTimeAsync(300);

    expect(callback).toHaveBeenCalledWith("https://example.com/app.js.map", inlineMap);
  });

  it("deduplicates concurrent fetches for the same script url while notifying all waiters", async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url.endsWith(".js")) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => "128" },
          text: () => Promise.resolve("//# sourceMappingURL=https://example.com/app.js.map"),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: { get: () => "16" },
        text: () => Promise.resolve('{"version":3}'),
      });
    });

    const sessions = await import("../src/background/sessions.mjs");
    const callbackA = vi.fn();
    const callbackB = vi.fn();

    sessions.fetchSourceMap("https://example.com/app.js", callbackA);
    sessions.fetchSourceMap("https://example.com/app.js", callbackB);
    await vi.advanceTimersByTimeAsync(300);

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(callbackA).toHaveBeenCalledTimes(1);
    expect(callbackB).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
