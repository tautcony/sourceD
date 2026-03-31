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

export function createWebRequestHandler(deps) {
  const {
    chrome,
    state,
    currentSettings,
    getOrCreateSession,
    fetchSourceMap,
    isValidSourceMap,
    refreshBadgeForTab,
    scheduleSessionPersist,
  } = deps;

  return (details) => {
    if (details.type !== "script") return;
    if (!/\.js(\?.*)?$/.test(details.url)) return;
    if (/^chrome-extension:\/\//.test(details.url)) return;
    if (details.tabId == null || details.tabId < 0) return;
    if (!currentSettings().detectionEnabled) return;

    chrome.tabs.get(details.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || !tab.url) return;
      const session = getOrCreateSession(tab);

      fetchSourceMap(details.url, (mapUrl, content) => {
        if (state.tabSessions[session.tabId] !== session) return;
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
        const removeIds = Object.keys(state.versionIndex);
        deleteVersions(removeIds).then(() => {
          removeVersionsFromIndexes(removeIds);
          broadcastSummary();
        }).catch((err) => {
          postPortError(port, "clearAll", err);
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
    compactStorageData,
    importSourceMapsForPage,
    isValidSourceMap,
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
      loadVersionFiles(message.versionId).then((files) => {
        sendResponse({ ok: true, files });
      }).catch((err) => {
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
        sendResponse({ ok: false, error: errorMessage(err) });
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
