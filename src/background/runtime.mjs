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
import {
  createPopupPortHandler,
  createRuntimeMessageHandler,
  createWebRequestHandler,
} from "./runtime-handlers.mjs";

export function registerRuntimeListeners() {
  const handleWebRequest = createWebRequestHandler({
    chrome,
    state,
    currentSettings,
    getOrCreateSession,
    fetchSourceMap,
    isValidSourceMap,
    refreshBadgeForTab,
    scheduleSessionPersist,
  });
  const handlePopupPort = createPopupPortHandler({
    state,
    pushSummary,
    loadVersionFiles,
    deleteVersions,
    removeVersionsFromIndexes,
    broadcastSummary,
    refreshBadgeForActiveTab,
  });
  const handleRuntimeMessage = createRuntimeMessageHandler({
    state,
    canonicalPageUrl,
    latestVersionForPage,
    versionLabel,
    totalStorageBytes,
    currentSettings,
    loadVersionFiles,
    summarizePages,
    distributionSummary,
    saveSettings,
    prunePageHistory,
    broadcastSummary,
    deleteVersions,
    removeVersionsFromIndexes,
    refreshBadgeForActiveTab,
    deletePageHistoryAndSessions,
    deleteSiteHistoryAndSessions,
    compactStorageData,
    importSourceMapsForPage,
    isValidSourceMap,
  });

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
    handleWebRequest,
    { urls: ["<all_urls>"] },
  );

  chrome.runtime.onConnect.addListener(handlePopupPort);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}

export function initializeRuntime() {
  chrome.action.setBadgeText({ text: "" });
  return Promise.all([ensureStorageReady(), loadSettings()]).then((results) => {
    registerRuntimeListeners();
    return results;
  });
}
