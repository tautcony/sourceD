import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPopupPortHandler, createRuntimeMessageHandler, createWebRequestHandler } from "../src/background/runtime-handlers.mjs";

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function makePort(name = "popup") {
  const port = {
    name,
    postMessage: vi.fn(),
    onDisconnect: { addListener: vi.fn((fn) => { port._disconnect = fn; }) },
    onMessage: { addListener: vi.fn((fn) => { port._message = fn; }) },
  };
  return port;
}

describe("background runtime handlers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("covers webRequest filter branches and successful persist flow", () => {
    const chrome = { runtime: { lastError: null }, tabs: { get: vi.fn((id, cb) => cb({ id, url: "https://example.com/app", title: "Ex" })) } };
    const state = { tabSessions: {} };
    const session = { tabId: 1, pageUrl: "https://example.com/app", maps: {} };
    const refreshBadgeForTab = vi.fn();
    const scheduleSessionPersist = vi.fn();
    const handler = createWebRequestHandler({
      chrome,
      state,
      currentSettings: () => ({ detectionEnabled: true }),
      getOrCreateSession: vi.fn(() => session),
      fetchSourceMap: vi.fn((_url, cb) => { state.tabSessions[1] = session; cb("a.map", "content"); }),
      isValidSourceMap: vi.fn(() => true),
      refreshBadgeForTab,
      scheduleSessionPersist,
    });

    handler({ type: "image", url: "https://example.com/app.js", tabId: 1 });
    handler({ type: "script", url: "https://example.com/app.css", tabId: 1 });
    handler({ type: "script", url: "chrome-extension://id/a.js", tabId: 1 });
    handler({ type: "script", url: "https://example.com/app.js", tabId: -1 });
    expect(chrome.tabs.get).not.toHaveBeenCalled();

    handler({ type: "script", url: "https://example.com/app.js", tabId: 1 });
    expect(session.maps).toEqual({ "a.map": "content" });
    expect(refreshBadgeForTab).toHaveBeenCalledWith(1, "https://example.com/app");
    expect(scheduleSessionPersist).toHaveBeenCalledWith(session);
  });

  it("drops fetched maps when the active tab session has changed", () => {
    const chrome = { runtime: { lastError: null }, tabs: { get: vi.fn((id, cb) => cb({ id, url: "https://example.com/app", title: "Ex" })) } };
    const staleSession = { tabId: 1, pageUrl: "https://example.com/app", maps: {} };
    const state = { tabSessions: { 1: { tabId: 1, pageUrl: "https://example.com/other", maps: {} } } };
    const handler = createWebRequestHandler({
      chrome,
      state,
      currentSettings: () => ({ detectionEnabled: true }),
      getOrCreateSession: vi.fn(() => staleSession),
      fetchSourceMap: vi.fn((_url, cb) => cb("a.map", "content")),
      isValidSourceMap: vi.fn(() => true),
      refreshBadgeForTab: vi.fn(),
      scheduleSessionPersist: vi.fn(),
    });

    handler({ type: "script", url: "https://example.com/app.js", tabId: 1 });
    expect(staleSession.maps).toEqual({});
  });

  it("covers popup port non-popup, disconnect, success and error branches", async () => {
    const state = {
      popupPorts: [],
      versionIndex: {
        old: { lastSeenAt: "2026-01-01T00:00:00.000Z" },
        fresh: { lastSeenAt: new Date().toISOString() },
      },
    };
    const handler = createPopupPortHandler({
      state,
      pushSummary: vi.fn(),
      loadVersionFiles: vi.fn(() => Promise.reject(new Error("files exploded"))),
      deleteVersions: vi.fn((ids) => ids[0] === "old" ? Promise.reject(new Error("delete exploded")) : Promise.resolve()),
      removeVersionsFromIndexes: vi.fn(),
      broadcastSummary: vi.fn(),
      refreshBadgeForActiveTab: vi.fn(),
    });

    handler(makePort("other"));
    expect(state.popupPorts).toEqual([]);

    const port = makePort();
    handler(port);
    expect(state.popupPorts).toEqual([port]);
    port._disconnect();
    expect(state.popupPorts).toEqual([]);

    const activePort = makePort();
    handler(activePort);
    activePort._message({ action: "getVersionFiles", versionId: "v1" });
    await flushPromises();
    expect(activePort.postMessage).toHaveBeenCalledWith({ type: "error", action: "getVersionFiles", error: "files exploded" });

    activePort._message({ action: "clearOlderThan7d" });
    await flushPromises();
    expect(activePort.postMessage).toHaveBeenCalledWith({ type: "error", action: "clearOlderThan7d", error: "delete exploded" });
  });

  it("covers popup port success branches", async () => {
    const state = {
      popupPorts: [],
      versionIndex: {
        old: { lastSeenAt: "2026-01-01T00:00:00.000Z" },
        fresh: { lastSeenAt: new Date().toISOString() },
      },
    };
    const handler = createPopupPortHandler({
      state,
      pushSummary: vi.fn(),
      loadVersionFiles: vi.fn(() => Promise.resolve([{ url: "a.map" }])),
      deleteVersions: vi.fn(() => Promise.resolve()),
      removeVersionsFromIndexes: vi.fn(),
      broadcastSummary: vi.fn(),
      refreshBadgeForActiveTab: vi.fn(),
    });

    const port = makePort();
    handler(port);

    port._message({ action: "getVersionFiles", versionId: "v1" });
    await flushPromises();
    expect(port.postMessage).toHaveBeenCalledWith({ type: "versionFiles", versionId: "v1", files: [{ url: "a.map" }] });

    port._message({ action: "clearOlderThan7d" });
    await flushPromises();
  });

  it("covers runtime message handler success and failure matrix", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = { versionIndex: { v1: { id: "v1", createdAt: "c", lastSeenAt: "l", mapCount: 1, byteSize: 1, title: "T" } }, versionsByPage: { "https://example.com/app": ["v1"] } };
    const deps = {
      state,
      canonicalPageUrl: (url) => url.replace("#hash", ""),
      latestVersionForPage: vi.fn((url) => state.versionIndex[state.versionsByPage[url]?.[0]] || null),
      versionLabel: vi.fn(() => "label"),
      totalStorageBytes: vi.fn(() => 5),
      currentSettings: vi.fn(() => ({ detectionEnabled: true })),
      loadVersionFiles: vi.fn(() => Promise.resolve([{ url: "a.map" }])),
      summarizePages: vi.fn(() => [{ pageUrl: "https://example.com/app" }]),
      distributionSummary: vi.fn(() => [{ siteKey: "https://example.com" }]),
      saveSettings: vi.fn(() => Promise.resolve()),
      prunePageHistory: vi.fn(() => Promise.resolve()),
      broadcastSummary: vi.fn(),
      deleteVersions: vi.fn(() => Promise.resolve()),
      removeVersionsFromIndexes: vi.fn(),
      refreshBadgeForActiveTab: vi.fn(),
      deletePageHistoryAndSessions: vi.fn(() => Promise.resolve()),
      deleteSiteHistoryAndSessions: vi.fn(() => Promise.resolve()),
      compactStorageData: vi.fn(() => Promise.reject(new Error("cleanup exploded"))),
      importSourceMapsForPage: vi.fn(() => Promise.resolve({ ok: true })),
      isValidSourceMap: vi.fn((content) => content === "good"),
    };
    const handler = createRuntimeMessageHandler(deps);
    const sendResponse = vi.fn();

    handler({ action: "getDashboardData" }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({
      pages: [{ pageUrl: "https://example.com/app" }],
      distribution: [{ siteKey: "https://example.com" }],
      settings: { detectionEnabled: true },
      totalVersions: 1,
      totalStorageBytes: 5,
    });

    const keepOpen = handler({ action: "getPopupState", pageUrl: "https://example.com/app#hash" }, {}, sendResponse);
    expect(keepOpen).toBe(true);
    await flushPromises();
    expect(sendResponse).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, pageUrl: "https://example.com/app" }));

    handler({ action: "cleanupData" }, {}, sendResponse);
    await flushPromises();
    expect(consoleError).toHaveBeenCalledWith("[SourceD] cleanup failed:", expect.any(Error));
    expect(sendResponse).toHaveBeenLastCalledWith({ ok: false, error: "cleanup exploded" });

    handler({
      action: "importSourceMaps",
      pageUrl: "https://example.com/app",
      title: "Ex",
      files: [{ mapUrl: "good.map", content: "good" }, { mapUrl: "bad.map", content: "bad" }, { name: "none.map" }],
    }, {}, sendResponse);
    await flushPromises();
    expect(deps.importSourceMapsForPage).toHaveBeenCalledWith({
      pageUrl: "https://example.com/app",
      title: "Ex",
      files: [{ mapUrl: "good.map", content: "good" }],
    });
    expect(sendResponse).toHaveBeenLastCalledWith({ ok: true, rejectedFiles: ["bad.map", "none.map"] });

    handler({ action: "unknown" }, {}, sendResponse);
    expect(sendResponse).toHaveBeenLastCalledWith({ ok: false, error: "unknown action" });
  });

  it("covers remaining runtime message branches", async () => {
    const state = {
      versionIndex: {
        v1: { id: "v1", createdAt: "c", lastSeenAt: "l", mapCount: 1, byteSize: 1, title: "T" },
      },
      versionsByPage: {},
    };
    const deps = {
      state,
      canonicalPageUrl: vi.fn((url) => url ? url.replace("#hash", "") : "normalized-empty"),
      latestVersionForPage: vi.fn(() => null),
      versionLabel: vi.fn(() => "label"),
      totalStorageBytes: vi.fn(() => 9),
      currentSettings: vi.fn(() => ({ detectionEnabled: true })),
      loadVersionFiles: vi.fn()
        .mockRejectedValueOnce("files failed")
        .mockResolvedValueOnce([{ url: "popup.map" }]),
      summarizePages: vi.fn(() => []),
      distributionSummary: vi.fn(() => []),
      saveSettings: vi.fn(() => Promise.resolve()),
      prunePageHistory: vi.fn(() => Promise.resolve()),
      broadcastSummary: vi.fn(),
      deleteVersions: vi.fn()
        .mockResolvedValueOnce()
        .mockRejectedValueOnce("delete failed"),
      removeVersionsFromIndexes: vi.fn(),
      refreshBadgeForActiveTab: vi.fn(),
      deletePageHistoryAndSessions: vi.fn().mockRejectedValueOnce("page failed"),
      deleteSiteHistoryAndSessions: vi.fn()
        .mockResolvedValueOnce()
        .mockRejectedValueOnce("site failed"),
      compactStorageData: vi.fn().mockResolvedValueOnce({
        invalidVersions: [{ id: "bad" }],
        stats: { removedVersions: 1, removedMaps: 2, reclaimedBytes: 3, remainingVersions: 4, remainingMaps: 5, remainingBytes: 6 },
      }),
      importSourceMapsForPage: vi.fn().mockRejectedValueOnce("import failed"),
      isValidSourceMap: vi.fn(() => false),
    };
    const handler = createRuntimeMessageHandler(deps);
    const popupStateResponse = vi.fn();
    const versionFilesResponse = vi.fn();
    const updateSettingsResponse = vi.fn();
    const deleteVersionResponse = vi.fn();
    const deletePageResponse = vi.fn();
    const deleteSiteResponse = vi.fn();
    const cleanupResponse = vi.fn();
    const importResponse = vi.fn();

    handler({ action: "getPopupState" }, {}, popupStateResponse);
    expect(popupStateResponse).toHaveBeenCalledWith({
      ok: true,
      pageUrl: "normalized-empty",
      latestVersion: null,
      files: [],
      totalStorageBytes: 9,
      totalVersions: 1,
      settings: { detectionEnabled: true },
    });

    state.versionsByPage["https://example.com/app"] = ["v1"];
    deps.latestVersionForPage.mockReturnValueOnce(state.versionIndex.v1);
    handler({ action: "getPopupState", pageUrl: "https://example.com/app#hash" }, {}, popupStateResponse);
    await flushPromises();
    expect(popupStateResponse).toHaveBeenLastCalledWith({ ok: false, error: "files failed" });

    expect(handler({ action: "getVersionFiles", versionId: "v1" }, {}, versionFilesResponse)).toBe(true);
    await flushPromises();
    expect(versionFilesResponse).toHaveBeenLastCalledWith({ ok: true, files: [{ url: "popup.map" }] });

    expect(handler({ action: "updateSettings", settings: { autoCleanup: false } }, {}, updateSettingsResponse)).toBe(true);
    await flushPromises();
    await flushPromises();
    expect(deps.prunePageHistory).toHaveBeenCalledWith("https://example.com/app", 0, ["https://example.com/app"]);
    expect(updateSettingsResponse).toHaveBeenLastCalledWith({ ok: true, settings: { detectionEnabled: true }, totalVersions: 1 });

    deps.saveSettings.mockRejectedValueOnce("save failed");
    expect(handler({ action: "updateSettings", settings: { autoCleanup: true } }, {}, updateSettingsResponse)).toBe(true);
    await flushPromises();
    expect(updateSettingsResponse).toHaveBeenLastCalledWith({ ok: false, error: "save failed" });

    expect(handler({ action: "deleteVersion", versionId: "v1" }, {}, deleteVersionResponse)).toBe(true);
    await flushPromises();
    expect(deps.removeVersionsFromIndexes).toHaveBeenCalledWith(["v1"]);
    expect(deleteVersionResponse).toHaveBeenLastCalledWith({ ok: true });

    expect(handler({ action: "deleteVersion", versionId: "v1" }, {}, deleteVersionResponse)).toBe(true);
    await flushPromises();
    expect(deleteVersionResponse).toHaveBeenLastCalledWith({ ok: false, error: "delete failed" });

    expect(handler({ action: "deletePageHistory" }, {}, deletePageResponse)).toBe(true);
    await flushPromises();
    expect(deps.deletePageHistoryAndSessions).toHaveBeenCalledWith("normalized-empty");
    expect(deletePageResponse).toHaveBeenLastCalledWith({ ok: false, error: "page failed" });

    expect(handler({ action: "deleteSiteHistory", siteKey: "site-key" }, {}, deleteSiteResponse)).toBe(true);
    await flushPromises();
    expect(deleteSiteResponse).toHaveBeenLastCalledWith({ ok: true });

    expect(handler({ action: "deleteSiteHistory" }, {}, deleteSiteResponse)).toBe(true);
    await flushPromises();
    expect(deps.deleteSiteHistoryAndSessions).toHaveBeenLastCalledWith("");
    expect(deleteSiteResponse).toHaveBeenLastCalledWith({ ok: false, error: "site failed" });

    state.versionIndex = {};
    handler({ action: "cleanupData" }, {}, cleanupResponse);
    expect(cleanupResponse).toHaveBeenLastCalledWith({
      ok: true,
      cleaned: [],
      stats: {
        removedVersions: 0,
        removedMaps: 0,
        reclaimedBytes: 0,
        remainingVersions: 0,
        remainingMaps: 0,
        remainingBytes: 0,
      },
    });

    state.versionIndex = { v1: { id: "v1" } };
    expect(handler({ action: "cleanupData" }, {}, cleanupResponse)).toBe(true);
    await flushPromises();
    expect(cleanupResponse).toHaveBeenLastCalledWith({
      ok: true,
      cleaned: [{ id: "bad" }],
      stats: { removedVersions: 1, removedMaps: 2, reclaimedBytes: 3, remainingVersions: 4, remainingMaps: 5, remainingBytes: 6 },
    });

    expect(handler({
      action: "importSourceMaps",
      pageUrl: "https://example.com/app",
      title: "Example",
      files: undefined,
    }, {}, importResponse)).toBe(true);
    await flushPromises();
    expect(deps.importSourceMapsForPage).toHaveBeenCalledWith({
      pageUrl: "https://example.com/app",
      title: "Example",
      files: [],
    });
    expect(importResponse).toHaveBeenLastCalledWith({
      ok: false,
      error: "import failed",
      rejectedFiles: [],
    });

    deps.importSourceMapsForPage.mockRejectedValueOnce("import failed");
    expect(handler({
      action: "importSourceMaps",
      pageUrl: "https://example.com/app",
      title: "Example",
      files: [{ content: "bad" }],
    }, {}, importResponse)).toBe(true);
    await flushPromises();
    expect(importResponse).toHaveBeenLastCalledWith({
      ok: false,
      error: "import failed",
      rejectedFiles: ["unnamed.map"],
    });
  });
});

describe("background runtime wiring and entry", () => {
  it("covers registerRuntimeListeners lifecycle branches and initializeRuntime", async () => {
    vi.resetModules();
    const listeners = {};
    globalThis.chrome = {
      runtime: {
        onConnect: { addListener: vi.fn((fn) => { listeners.connect = fn; }) },
        onMessage: { addListener: vi.fn((fn) => { listeners.message = fn; }) },
      },
      tabs: {
        onRemoved: { addListener: vi.fn((fn) => { listeners.removed = fn; }) },
        onUpdated: { addListener: vi.fn((fn) => { listeners.updated = fn; }) },
        onActivated: { addListener: vi.fn((fn) => { listeners.activated = fn; }) },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: { addListener: vi.fn((fn) => { listeners.focus = fn; }) },
      },
      webRequest: {
        onBeforeRequest: { addListener: vi.fn((fn) => { listeners.request = fn; }) },
      },
      action: { setBadgeText: vi.fn() },
    };

    vi.doMock("../src/background/storage.mjs", () => ({
      broadcastSummary: vi.fn(),
      compactStorageData: vi.fn(),
      currentSettings: vi.fn(() => ({ detectionEnabled: true })),
      deletePageHistoryAndSessions: vi.fn(),
      deleteSiteHistoryAndSessions: vi.fn(),
      deleteVersions: vi.fn(),
      distributionSummary: vi.fn(),
      ensureStorageReady: vi.fn(() => Promise.resolve("db")),
      importSourceMapsForPage: vi.fn(),
      loadSettings: vi.fn(() => Promise.resolve("settings")),
      loadVersionFiles: vi.fn(),
      prunePageHistory: vi.fn(),
      pushSummary: vi.fn(),
      removeVersionsFromIndexes: vi.fn(),
      saveSettings: vi.fn(),
      summarizePages: vi.fn(),
      totalStorageBytes: vi.fn(() => 0),
    }));
    const cleanupTabSession = vi.fn();
    const scheduleSessionPersist = vi.fn();
    vi.doMock("../src/background/sessions.mjs", () => ({
      cleanupTabSession,
      fetchSourceMap: vi.fn(),
      getOrCreateSession: vi.fn(),
      isValidSourceMap: vi.fn(() => true),
      scheduleSessionPersist,
    }));

    const shared = await import("../src/background/shared.mjs");
    const refreshBadgeForTab = vi.spyOn(shared, "refreshBadgeForTab").mockImplementation(() => {});
    const refreshBadgeForActiveTab = vi.spyOn(shared, "refreshBadgeForActiveTab").mockImplementation(() => {});
    shared.state.tabSessions = { 1: { title: "old" }, 2: { title: "x" } };

    const runtime = await import("../src/background/runtime.mjs");
    runtime.registerRuntimeListeners();

    listeners.removed(1);
    expect(cleanupTabSession).toHaveBeenCalledWith(1);

    listeners.updated(1, { status: "loading" }, { url: "https://example.com" });
    expect(refreshBadgeForTab).toHaveBeenCalledWith(1, "https://example.com");

    listeners.updated(1, { url: "https://example.com/next" }, {});
    expect(refreshBadgeForTab).toHaveBeenCalledWith(1, "https://example.com/next");

    listeners.updated(1, { title: "new" }, {});
    expect(shared.state.tabSessions[1].title).toBe("new");

    listeners.updated(2, { status: "complete" }, { url: "https://example.com/done" });
    expect(scheduleSessionPersist).toHaveBeenCalledWith(shared.state.tabSessions[2]);

    listeners.activated({ tabId: 3 });
    expect(refreshBadgeForTab).toHaveBeenCalledWith(3);

    listeners.focus(-1);
    listeners.focus(1);
    expect(refreshBadgeForActiveTab).toHaveBeenCalled();

    await expect(runtime.initializeRuntime()).resolves.toEqual(["db", "settings"]);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });

  it("logs init failures from background entry", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("../src/background/runtime.mjs", () => ({
      initializeRuntime: vi.fn(() => Promise.reject(new Error("init exploded"))),
    }));

    await import("../src/background/index.js");
    await flushPromises();
    expect(warn).toHaveBeenCalledWith("[SourceD] init failed:", "init exploded");
  });
});
