function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function postPortError(port, action, err) {
  port.postMessage({
    type: "error",
    action,
    error: errorMessage(err),
  });
}

function emptyCleanupStats() {
  return {
    removedVersions: 0,
    removedMaps: 0,
    reclaimedBytes: 0,
    remainingVersions: 0,
    remainingMaps: 0,
    remainingBytes: 0,
  };
}

export function createWebRequestHandler(deps) {
  const {
    chrome,
    state,
    currentSettings,
    shouldIgnoreAnalysisForUrl,
    getOrCreateSession,
    fetchSourceMap,
    isValidSourceMap,
    refreshBadgeForTab,
    scheduleSessionPersist,
  } = deps;

  return (details) => {
    if (details.type !== "script") return;
    if (/^chrome-extension:\/\//.test(details.url)) return;
    if (details.tabId == null || details.tabId < 0) return;
    if (!currentSettings().detectionEnabled) return;

    chrome.tabs.get(details.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || !tab.url) return;
      if (shouldIgnoreAnalysisForUrl(tab.url, currentSettings().ignoredDomains)) return;
      const session = getOrCreateSession(tab);

      fetchSourceMap(details.url, (mapUrl, content, httpStatus) => {
        // Guard against races where the tab navigated between the webRequest
        // event and this async callback. If the session was replaced (due to
        // navigation) or cleaned up, skip the result to avoid assigning source
        // maps from an old page to a new page's session.
        if (state.tabSessions[session.tabId] !== session) return;
        if (content === null) {
          if (!session.failedMaps) session.failedMaps = {};
          session.failedMaps[mapUrl] = { httpStatus: httpStatus != null ? httpStatus : null };
          return;
        }
        if (!isValidSourceMap(content)) return;
        session.maps[mapUrl] = content;
        refreshBadgeForTab(session.tabId, session.pageUrl);
        scheduleSessionPersist(session);
      });
    });
  };
}

export function createPopupPortHandler(deps) {
  const {
    state,
    pushSummary,
    loadVersionFiles,
    deleteVersions,
    removeVersionsFromIndexes,
    broadcastSummary,
    refreshBadgeForActiveTab,
  } = deps;

  return (port) => {
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
        }).catch((err) => {
          postPortError(port, "getVersionFiles", err);
        });
      } else if (msg.action === "clearAll") {
        if (state.storageCompactionInProgress) {
          postPortError(port, "clearAll", new Error("Storage compaction in progress; please try again shortly"));
          return;
        }
        const removeIds = Object.keys(state.versionIndex);
        deleteVersions(removeIds).then(() => {
          removeVersionsFromIndexes(removeIds);
          broadcastSummary();
        }).catch((err) => {
          postPortError(port, "clearAll", err);
        });
      } else if (msg.action === "clearOlderThan7d") {
        if (state.storageCompactionInProgress) {
          postPortError(port, "clearOlderThan7d", new Error("Storage compaction in progress; please try again shortly"));
          return;
        }
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const removeIds = Object.keys(state.versionIndex).filter((id) => {
          return new Date(state.versionIndex[id].lastSeenAt).getTime() < cutoff;
        });
        deleteVersions(removeIds).then(() => {
          removeVersionsFromIndexes(removeIds);
          refreshBadgeForActiveTab();
          broadcastSummary();
        }).catch((err) => {
          postPortError(port, "clearOlderThan7d", err);
        });
      }
    });
  };
}

export function createRuntimeMessageHandler(deps) {
  const {
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
    importSourceMapsForPage,
    isValidSourceMap,
    runCleanupTasks,
    retryFailedMapFetch,
  } = deps;

  return (message, _sender, sendResponse) => {
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
            byteSize: currentSettings().sizeDisplayMode === "compressed"
              ? Number(latest.storedByteSize ?? latest.byteSize) || 0
              : Number(latest.byteSize ?? latest.storedByteSize) || 0,
            rawByteSize: latest.byteSize,
            storedByteSize: latest.storedByteSize ?? latest.byteSize,
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
          error: errorMessage(err),
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
      loadVersionFiles(message.versionId, { includeContent: message.includeContent !== false }).then((files) => {
        const meta = state.versionIndex[message.versionId];
        const failedMapUrls = meta?.failedMapUrls || [];
        const failedMapHttpStatuses = meta?.failedMapHttpStatuses || {};
        sendResponse({ ok: true, files, failedMapUrls, failedMapHttpStatuses });
      }).catch((err) => {
        console.error("[SourceD] getVersionFiles failed:", message.versionId, err);
        sendResponse({ ok: false, error: errorMessage(err) });
      });
      return true;
    }

    if (message.action === "retryMapFetch") {
      retryFailedMapFetch(message.versionId, message.mapUrl).then((result) => {
        sendResponse({ ok: true, ...result });
      }).catch((err) => {
        console.error("[SourceD] retryMapFetch failed:", message.versionId, message.mapUrl, err);
        sendResponse({ ok: false, error: errorMessage(err) });
      });
      return true;
    }

    if (message.action === "updateSettings") {
      saveSettings(message.settings)
        .then(() => Promise.all(Object.keys(state.versionsByPage).map(prunePageHistory)))
        .then(() => {
          broadcastSummary();
          sendResponse({
            ok: true,
            settings: currentSettings(),
            totalVersions: Object.keys(state.versionIndex).length,
          });
        })
        .catch((err) => {
          sendResponse({
            ok: false,
            error: errorMessage(err),
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
      }).catch((err) => {
        sendResponse({ ok: false, error: errorMessage(err) });
      });
      return true;
    }

    if (message.action === "deletePageHistory") {
      const targetPageUrl = canonicalPageUrl(message.pageUrl || "");
      deletePageHistoryAndSessions(targetPageUrl).then(() => {
        broadcastSummary();
        sendResponse({ ok: true });
      }).catch((err) => {
        sendResponse({ ok: false, error: errorMessage(err) });
      });
      return true;
    }

    if (message.action === "deleteSiteHistory") {
      deleteSiteHistoryAndSessions(message.siteKey || "").then(() => {
        broadcastSummary();
        sendResponse({ ok: true });
      }).catch((err) => {
        sendResponse({ ok: false, error: errorMessage(err) });
      });
      return true;
    }

    if (message.action === "cleanupData") {
      console.info("[SourceD] cleanup started");
      runCleanupTasks().then((cleanupResult) => {
        console.info("[SourceD] cleanup finished:", cleanupResult);
        broadcastSummary();
        sendResponse(cleanupResult);
      }).catch((err) => {
        console.error("[SourceD] cleanup failed:", err);
        sendResponse({ ok: false, error: errorMessage(err), cleaned: [], stats: emptyCleanupStats(), steps: [] });
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
          error: errorMessage(err),
          rejectedFiles,
        });
      });
      return true;
    }

    sendResponse({ ok: false, error: "unknown action" });
  };
}
