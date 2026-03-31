import {
  canonicalPageUrl,
  latestVersionForPage,
  refreshBadgeForActiveTab,
  refreshBadgeForTab,
  state,
  versionLabel,
} from "./shared.mjs";
import {
  broadcastSummary,
  compactStorageData,
  currentSettings,
  deletePageHistoryAndSessions,
  deleteSiteHistoryAndSessions,
  deleteVersions,
  distributionSummary,
  ensureStorageReady,
  importSourceMapsForPage,
  loadSettings,
  loadVersionFiles,
  prunePageHistory,
  pushSummary,
  removeVersionsFromIndexes,
  saveSettings,
  summarizePages,
  totalStorageBytes,
} from "./storage.mjs";
import {
  cleanupTabSession,
  fetchSourceMap,
  getOrCreateSession,
  isValidSourceMap,
  scheduleSessionPersist,
} from "./sessions.mjs";

export function registerRuntimeListeners() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    cleanupTabSession(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "loading") {
      cleanupTabSession(tabId);
      if (tab && tab.url) refreshBadgeForTab(tabId, tab.url);
      return;
    }

    if (changeInfo.url) {
      cleanupTabSession(tabId);
      refreshBadgeForTab(tabId, changeInfo.url);
    } else if (changeInfo.title && state.tabSessions[tabId]) {
      state.tabSessions[tabId].title = changeInfo.title;
    } else if (changeInfo.status === "complete" && state.tabSessions[tabId] && currentSettings().detectionEnabled) {
      scheduleSessionPersist(state.tabSessions[tabId]);
      refreshBadgeForTab(tabId, tab && tab.url);
    }
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    refreshBadgeForTab(activeInfo.tabId);
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    refreshBadgeForActiveTab();
  });

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.type !== "script") return;
      if (!/\.js(\?.*)?$/.test(details.url)) return;
      if (/^chrome-extension:\/\//.test(details.url)) return;
      if (details.tabId == null || details.tabId < 0) return;
      if (!currentSettings().detectionEnabled) return;

      chrome.tabs.get(details.tabId, (tab) => {
        if (chrome.runtime.lastError || !tab || !tab.url) return;
        const session = getOrCreateSession(tab);

        fetchSourceMap(details.url, (mapUrl, content) => {
          if (!isValidSourceMap(content)) return;
          session.maps[mapUrl] = content;
          refreshBadgeForTab(session.tabId, session.pageUrl);
          scheduleSessionPersist(session);
        });
      });
    },
    { urls: ["<all_urls>"] },
  );

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "popup") return;

    state.popupPorts.push(port);
    pushSummary(port);

    port.onDisconnect.addListener(() => {
      state.popupPorts = state.popupPorts.filter((item) => item !== port);
    });

    port.onMessage.addListener((msg) => {
      if (msg.action === "getVersionFiles") {
        loadVersionFiles(msg.versionId).then((files) => {
          port.postMessage({ type: "versionFiles", versionId: msg.versionId, files });
        });
      } else if (msg.action === "clearAll") {
        deleteVersions(Object.keys(state.versionIndex)).then(() => {
          removeVersionsFromIndexes(Object.keys(state.versionIndex));
          broadcastSummary();
        });
      } else if (msg.action === "clearOlderThan7d") {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const removeIds = Object.keys(state.versionIndex).filter((id) => {
          return new Date(state.versionIndex[id].lastSeenAt).getTime() < cutoff;
        });
        deleteVersions(removeIds).then(() => {
          removeVersionsFromIndexes(removeIds);
          refreshBadgeForActiveTab();
          broadcastSummary();
        });
      }
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "getPopupState") {
      const pageUrl = canonicalPageUrl(message.pageUrl || "");
      const latest = latestVersionForPage(pageUrl);

      if (!latest) {
        sendResponse({
          ok: true,
          pageUrl,
          latestVersion: null,
          files: [],
          totalStorageBytes: totalStorageBytes(),
          totalVersions: Object.keys(state.versionIndex).length,
          settings: currentSettings(),
        });
        return;
      }

      loadVersionFiles(latest.id).then((files) => {
        sendResponse({
          ok: true,
          pageUrl,
          latestVersion: {
            id: latest.id,
            label: versionLabel(latest, 0, (state.versionsByPage[pageUrl] || []).length),
            createdAt: latest.createdAt,
            lastSeenAt: latest.lastSeenAt,
            mapCount: latest.mapCount,
            byteSize: latest.byteSize,
            title: latest.title,
          },
          files,
          totalStorageBytes: totalStorageBytes(),
          totalVersions: Object.keys(state.versionIndex).length,
          settings: currentSettings(),
        });
      }).catch((err) => {
        sendResponse({
          ok: false,
          error: err && err.message ? err.message : String(err),
        });
      });
      return true;
    }

    if (message.action === "getDashboardData") {
      sendResponse({
        pages: summarizePages(),
        distribution: distributionSummary(),
        settings: currentSettings(),
        totalVersions: Object.keys(state.versionIndex).length,
        totalStorageBytes: totalStorageBytes(),
      });
      return;
    }

    if (message.action === "getVersionFiles") {
      loadVersionFiles(message.versionId).then((files) => {
        sendResponse({ ok: true, files });
      }).catch((err) => {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      });
      return true;
    }

    if (message.action === "updateSettings") {
      saveSettings(message.settings)
        .then(() => {
          const tasks = Object.keys(state.versionsByPage).map(prunePageHistory);
          return Promise.all(tasks);
        })
        .then(() => {
          broadcastSummary();
          sendResponse({
            ok: true,
            settings: currentSettings(),
            totalVersions: Object.keys(state.versionIndex).length,
          });
        });
      return true;
    }

    if (message.action === "deleteVersion") {
      deleteVersions([message.versionId]).then(() => {
        removeVersionsFromIndexes([message.versionId]);
        refreshBadgeForActiveTab();
        broadcastSummary();
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.action === "deletePageHistory") {
      const targetPageUrl = canonicalPageUrl(message.pageUrl || "");
      deletePageHistoryAndSessions(targetPageUrl).then(() => {
        broadcastSummary();
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.action === "deleteSiteHistory") {
      deleteSiteHistoryAndSessions(message.siteKey || "").then(() => {
        broadcastSummary();
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.action === "cleanupData") {
      if (Object.keys(state.versionIndex).length === 0) {
        sendResponse({
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
        return;
      }

      compactStorageData().then((storageState) => {
        broadcastSummary();
        sendResponse({
          ok: true,
          cleaned: storageState.invalidVersions,
          stats: storageState.stats,
        });
      }).catch((err) => {
        console.error("[SourceD] cleanup failed:", err);
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      });
      return true;
    }

    if (message.action === "importSourceMaps") {
      const rawFiles = Array.isArray(message.files) ? message.files : [];
      const acceptedFiles = [];
      const rejectedFiles = [];

      rawFiles.forEach((file) => {
        const content = typeof file?.content === "string" ? file.content : "";
        const mapUrl = String(file?.mapUrl || "").trim();
        if (!mapUrl || !content || !isValidSourceMap(content)) {
          rejectedFiles.push(mapUrl || file?.name || "unnamed.map");
          return;
        }
        acceptedFiles.push({ mapUrl, content });
      });

      importSourceMapsForPage({
        pageUrl: message.pageUrl,
        title: message.title,
        files: acceptedFiles,
      }).then((result) => {
        broadcastSummary();
        sendResponse(Object.assign({}, result, {
          rejectedFiles,
        }));
      }).catch((err) => {
        sendResponse({
          ok: false,
          error: err && err.message ? err.message : String(err),
          rejectedFiles,
        });
      });
      return true;
    }
  });
}

export function initializeRuntime() {
  chrome.action.setBadgeText({ text: "" });
  registerRuntimeListeners();
  return Promise.all([ensureStorageReady(), loadSettings()]);
}
