"use strict";

var DB_NAME = "sourced";
var DB_VERSION = 2;
var VERSION_STORE = "pageVersions";
var MAP_STORE = "versionMaps";
var SETTINGS_KEY = "settings";
var popupPorts = [];
var dbPromise = null;
var tabSessions = {};
var versionIndex = {};
var versionsByPage = {};
var settings = null;

var DEFAULT_SETTINGS = {
  retentionDays: 30,
  maxVersionsPerPage: 10,
  autoCleanup: true
};

chrome.action.setBadgeText({ text: "" });

function setBadgeText(num, tabId) {
  var payload = { text: num > 0 ? String(num) : "" };
  if (tabId != null) payload.tabId = tabId;
  chrome.action.setBadgeText(payload);
}

function pageMapCount(pageUrl) {
  var latest = latestVersionForPage(pageUrl);
  return latest ? (latest.mapCount || 0) : 0;
}

function sessionMapCount(tabId) {
  var session = tabSessions[tabId];
  if (session) return Object.keys(session.maps || {}).length;
  return 0;
}

function refreshBadgeForTab(tabId, fallbackUrl) {
  if (tabId == null || tabId < 0) return;

  var count = sessionMapCount(tabId);
  if (count > 0) {
    setBadgeText(count, tabId);
    return;
  }

  if (fallbackUrl) {
    setBadgeText(pageMapCount(canonicalPageUrl(fallbackUrl)), tabId);
    return;
  }

  chrome.tabs.get(tabId, function (tab) {
    if (chrome.runtime.lastError || !tab || !tab.url) {
      setBadgeText(0, tabId);
      return;
    }
    setBadgeText(pageMapCount(canonicalPageUrl(tab.url)), tabId);
  });
}

function refreshBadgeForActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab) {
      setBadgeText(0);
      return;
    }
    refreshBadgeForTab(tab.id, tab.url);
  });
}

function canonicalPageUrl(url) {
  try {
    var parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return url || "";
  }
}

function pageSiteKey(url) {
  try {
    var parsed = new URL(url);
    return parsed.origin;
  } catch (_) {
    return url || "";
  }
}

function hashString(input) {
  var hash = 2166136261;
  for (var i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function buildSignature(maps) {
  return Object.keys(maps).sort().map(function (mapUrl) {
    return mapUrl + "#" + hashString(maps[mapUrl]);
  }).join("|");
}

function versionLabel(meta, index, total) {
  var stamp = new Date(meta.createdAt || meta.lastSeenAt).toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  return "v" + (total - index) + " · " + stamp;
}

function ensurePageBucket(pageUrl) {
  if (!versionsByPage[pageUrl]) versionsByPage[pageUrl] = [];
  return versionsByPage[pageUrl];
}

function sortPageVersions(pageUrl) {
  ensurePageBucket(pageUrl).sort(function (a, b) {
    var av = versionIndex[a];
    var bv = versionIndex[b];
    return new Date(bv.lastSeenAt).getTime() - new Date(av.lastSeenAt).getTime();
  });
}

function rebuildIndexes(versions) {
  versionIndex = {};
  versionsByPage = {};

  versions.forEach(function (meta) {
    versionIndex[meta.id] = meta;
    ensurePageBucket(meta.pageUrl).push(meta.id);
  });

  Object.keys(versionsByPage).forEach(sortPageVersions);
  refreshBadgeForActiveTab();
}

function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(VERSION_STORE)) {
        db.createObjectStore(VERSION_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MAP_STORE)) {
        db.createObjectStore(MAP_STORE);
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
  return dbPromise;
}

function listAllVersions() {
  return getDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(VERSION_STORE, "readonly");
      var req = tx.objectStore(VERSION_STORE).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function putVersion(meta) {
  return getDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(VERSION_STORE, "readwrite");
      tx.objectStore(VERSION_STORE).put(meta);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  });
}

function deleteVersions(versionIds) {
  if (versionIds.length === 0) return Promise.resolve();
  return getDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction([VERSION_STORE, MAP_STORE], "readwrite");
      var versions = tx.objectStore(VERSION_STORE);
      var maps = tx.objectStore(MAP_STORE);
      versionIds.forEach(function (id) {
        var meta = versionIndex[id];
        versions.delete(id);
        if (meta && meta.mapUrls) {
          meta.mapUrls.forEach(function (mapUrl) {
            maps.delete(id + "::" + mapUrl);
          });
        }
      });
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  });
}

function removeVersionsFromIndexes(versionIds) {
  versionIds.forEach(function (id) {
    var meta = versionIndex[id];
    if (meta && versionsByPage[meta.pageUrl]) {
      versionsByPage[meta.pageUrl] = versionsByPage[meta.pageUrl].filter(function (item) {
        return item !== id;
      });
      if (versionsByPage[meta.pageUrl].length === 0) delete versionsByPage[meta.pageUrl];
    }
    delete versionIndex[id];
  });
}

function clearSessionsForPage(pageUrl) {
  Object.keys(tabSessions).forEach(function (tabId) {
    var session = tabSessions[tabId];
    if (!session || session.pageUrl !== pageUrl) return;
    if (session.timer) clearTimeout(session.timer);
    session.maps = {};
    session.versionId = null;
    session.versionOwned = false;
    session.signature = null;
    refreshBadgeForTab(Number(tabId), pageUrl);
  });
}

function deletePageHistory(pageUrl) {
  var ids = (versionsByPage[pageUrl] || []).slice();
  return deleteVersions(ids).then(function () {
    removeVersionsFromIndexes(ids);
    clearSessionsForPage(pageUrl);
    refreshBadgeForActiveTab();
  });
}

function putVersionMaps(versionId, maps) {
  return getDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(MAP_STORE, "readwrite");
      var store = tx.objectStore(MAP_STORE);
      Object.keys(maps).forEach(function (mapUrl) {
        store.put(maps[mapUrl], versionId + "::" + mapUrl);
      });
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  });
}

function loadVersionFiles(versionId) {
  var meta = versionIndex[versionId];
  if (!meta) return Promise.resolve([]);

  return getDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(MAP_STORE, "readonly");
      var store = tx.objectStore(MAP_STORE);
      var remaining = meta.mapUrls.length;
      var files = [];

      if (remaining === 0) {
        resolve(files);
        return;
      }

      meta.mapUrls.forEach(function (mapUrl) {
        var req = store.get(versionId + "::" + mapUrl);
        req.onsuccess = function () {
          if (req.result != null) {
            files.push({
              url: mapUrl,
              content: req.result,
              page: {
                url: meta.pageUrl,
                title: meta.title,
                id: meta.tabId || null
              },
              versionId: versionId
            });
          }
          remaining--;
          if (remaining === 0) resolve(files);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  });
}

function loadSettings() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([SETTINGS_KEY], function (data) {
      settings = Object.assign({}, DEFAULT_SETTINGS, data[SETTINGS_KEY] || {});
      resolve(settings);
    });
  });
}

function saveSettings(nextSettings) {
  settings = Object.assign({}, DEFAULT_SETTINGS, nextSettings || {});
  return new Promise(function (resolve) {
    var payload = {};
    payload[SETTINGS_KEY] = settings;
    chrome.storage.local.set(payload, resolve);
  });
}

function summarizePages() {
  var pageUrls = Object.keys(versionsByPage).sort(function (a, b) {
    var av = versionIndex[versionsByPage[a][0]];
    var bv = versionIndex[versionsByPage[b][0]];
    return new Date(bv.lastSeenAt).getTime() - new Date(av.lastSeenAt).getTime();
  });

  return pageUrls.map(function (pageUrl) {
    var ids = versionsByPage[pageUrl];
    var metas = ids.map(function (id) { return versionIndex[id]; });
    return {
      pageUrl: pageUrl,
      title: metas[0].title,
      siteKey: metas[0].siteKey,
      versions: metas.map(function (meta, index) {
        return {
          id: meta.id,
          label: versionLabel(meta, index, metas.length),
          createdAt: meta.createdAt,
          lastSeenAt: meta.lastSeenAt,
          mapCount: meta.mapCount,
          byteSize: meta.byteSize,
          signature: meta.signature
        };
      })
    };
  });
}

function distributionSummary() {
  var bySite = {};
  Object.keys(versionIndex).forEach(function (id) {
    var meta = versionIndex[id];
    if (!bySite[meta.siteKey]) {
      bySite[meta.siteKey] = {
        siteKey: meta.siteKey,
        versionCount: 0,
        mapCount: 0,
        byteSize: 0
      };
    }
    bySite[meta.siteKey].versionCount++;
    bySite[meta.siteKey].mapCount += meta.mapCount;
    bySite[meta.siteKey].byteSize += meta.byteSize;
  });
  return Object.keys(bySite).sort().map(function (key) { return bySite[key]; });
}

function totalStorageBytes() {
  return Object.keys(versionIndex).reduce(function (sum, id) {
    return sum + (versionIndex[id].byteSize || 0);
  }, 0);
}

function latestVersionForPage(pageUrl) {
  var ids = versionsByPage[pageUrl] || [];
  return ids.length ? versionIndex[ids[0]] : null;
}

function pushSummary(port) {
  port.postMessage({
      type: "summary",
      pages: summarizePages(),
      distribution: distributionSummary(),
      settings: settings,
      totalVersions: Object.keys(versionIndex).length,
      totalStorageBytes: totalStorageBytes()
    });
}

function broadcastSummary() {
  popupPorts.forEach(function (port) {
    try { pushSummary(port); } catch (_) {}
  });
}

function currentSettings() {
  return settings || DEFAULT_SETTINGS;
}

function prunePageHistory(pageUrl) {
  var cfg = currentSettings();
  var ids = ensurePageBucket(pageUrl).slice();
  var removeIds = [];
  var cutoff = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000;

  ids.forEach(function (id, index) {
    var meta = versionIndex[id];
    if (!meta) return;
    var old = new Date(meta.lastSeenAt).getTime() < cutoff;
    var overflow = index >= cfg.maxVersionsPerPage;
    if (old || overflow) removeIds.push(id);
  });

  if (removeIds.length === 0) return Promise.resolve();

  return deleteVersions(removeIds).then(function () {
    removeIds.forEach(function (id) { delete versionIndex[id]; });
    versionsByPage[pageUrl] = ensurePageBucket(pageUrl).filter(function (id) {
      return removeIds.indexOf(id) === -1;
    });
    if (versionsByPage[pageUrl].length === 0) delete versionsByPage[pageUrl];
    refreshBadgeForActiveTab();
  });
}

function buildMetaForSession(session, signature, versionId) {
  var mapUrls = Object.keys(session.maps).sort();
  var byteSize = mapUrls.reduce(function (sum, mapUrl) {
    return sum + session.maps[mapUrl].length;
  }, 0);
  var now = new Date().toISOString();
  var existing = versionIndex[versionId];

  return {
    id: versionId,
    pageUrl: session.pageUrl,
    siteKey: pageSiteKey(session.pageUrl),
    title: session.title,
    createdAt: existing ? existing.createdAt : now,
    lastSeenAt: now,
    signature: signature,
    mapUrls: mapUrls,
    mapCount: mapUrls.length,
    fileCount: mapUrls.length,
    byteSize: byteSize,
    tabId: session.tabId
  };
}

function upsertSessionVersion(session) {
  var signature = buildSignature(session.maps);
  if (!signature) return Promise.resolve();

  if (session.versionId && session.versionOwned && session.signature === signature) {
    var stableMeta = versionIndex[session.versionId];
    if (stableMeta) {
      stableMeta.lastSeenAt = new Date().toISOString();
      stableMeta.title = session.title;
      return putVersion(stableMeta).then(function () { broadcastSummary(); });
    }
  }

  if (session.versionId && session.versionOwned) {
    var updatedMeta = buildMetaForSession(session, signature, session.versionId);
    session.signature = signature;
    versionIndex[session.versionId] = updatedMeta;
    return putVersion(updatedMeta)
      .then(function () { return putVersionMaps(session.versionId, session.maps); })
      .then(function () { sortPageVersions(session.pageUrl); })
      .then(function () { if (currentSettings().autoCleanup) return prunePageHistory(session.pageUrl); })
      .then(function () {
        refreshBadgeForTab(session.tabId, session.pageUrl);
        broadcastSummary();
      });
  }

  var matchingId = ensurePageBucket(session.pageUrl).find(function (id) {
    return versionIndex[id] && versionIndex[id].signature === signature;
  });

  if (matchingId) {
    var matched = versionIndex[matchingId];
    matched.lastSeenAt = new Date().toISOString();
    matched.title = session.title;
    session.versionId = matchingId;
    session.versionOwned = false;
    session.signature = signature;
    return putVersion(matched)
      .then(function () { sortPageVersions(session.pageUrl); })
      .then(function () {
        refreshBadgeForTab(session.tabId, session.pageUrl);
        broadcastSummary();
      });
  }

  var newId = session.pageUrl + "::" + Date.now() + "::" + Math.random().toString(36).slice(2, 8);
  var meta = buildMetaForSession(session, signature, newId);
  session.versionId = newId;
  session.versionOwned = true;
  session.signature = signature;
  versionIndex[newId] = meta;
  ensurePageBucket(session.pageUrl).unshift(newId);
  sortPageVersions(session.pageUrl);

  return putVersion(meta)
    .then(function () { return putVersionMaps(newId, session.maps); })
    .then(function () { if (currentSettings().autoCleanup) return prunePageHistory(session.pageUrl); })
    .then(function () {
      refreshBadgeForTab(session.tabId, session.pageUrl);
      broadcastSummary();
    });
}

function scheduleSessionPersist(session) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(function () {
    upsertSessionVersion(session).catch(function (err) {
      console.warn("[SourceD] version save failed:", err && err.message ? err.message : err);
    });
  }, 1400);
}

function getOrCreateSession(tab) {
  var pageUrl = canonicalPageUrl(tab.url || "");
  var session = tabSessions[tab.id];
  if (!session || session.pageUrl !== pageUrl) {
    session = {
      tabId: tab.id,
      pageUrl: pageUrl,
      title: tab.title || pageUrl,
      maps: {},
      versionId: null,
      versionOwned: false,
      signature: null,
      timer: null
    };
    tabSessions[tab.id] = session;
  }
  session.title = tab.title || session.title;
  refreshBadgeForTab(tab.id, pageUrl);
  return session;
}

function cleanupTabSession(tabId) {
  var session = tabSessions[tabId];
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  setBadgeText(0, tabId);
  delete tabSessions[tabId];
}

function fetchSourceMap(jsUrl, callback) {
  setTimeout(function () {
    fetch(jsUrl)
      .then(function (resp) { return resp.ok ? resp.text() : null; })
      .then(function (jsContent) {
        if (!jsContent) return;
        var match = jsContent.match(/\/\/# sourceMappingURL=([^\s\r\n]+)/);
        if (!match) return;
        var mapRef = match[1];

        if (mapRef.startsWith("data:application/json")) {
          var b64 = mapRef.split(",")[1];
          try { callback(jsUrl + ".map", atob(b64)); }
          catch (e) { console.warn("[SourceD] inline map decode error:", e); }
          return;
        }

        var mapUrl = /^https?:/.test(mapRef) ? mapRef : new URL(mapRef, jsUrl).href;
        fetch(mapUrl)
          .then(function (r) { return r.ok ? r.text() : null; })
          .then(function (text) { if (text) callback(mapUrl, text); })
          .catch(function (e) { console.warn("[SourceD] map fetch error:", e); });
      })
      .catch(function (e) { console.warn("[SourceD] js fetch error:", e); });
  }, 300);
}

function isValidSourceMap(raw) {
  try {
    var data = JSON.parse(raw.replace(/^\)\]\}'/, ""));
    return (
      data.version === 3 &&
      Array.isArray(data.sources) && data.sources.length > 0 &&
      Array.isArray(data.sourcesContent) &&
      data.sourcesContent.some(function (c) { return c != null && c !== ""; })
    );
  } catch (_) { return false; }
}

chrome.tabs.onRemoved.addListener(function (tabId) {
  cleanupTabSession(tabId);
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.url) {
    cleanupTabSession(tabId);
    refreshBadgeForTab(tabId, changeInfo.url);
  } else if (changeInfo.title && tabSessions[tabId]) {
    tabSessions[tabId].title = changeInfo.title;
  } else if (changeInfo.status === "complete" && tabSessions[tabId]) {
    scheduleSessionPersist(tabSessions[tabId]);
    refreshBadgeForTab(tabId, tab && tab.url);
  }
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
  refreshBadgeForTab(activeInfo.tabId);
});

chrome.windows.onFocusChanged.addListener(function (windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  refreshBadgeForActiveTab();
});

chrome.webRequest.onBeforeRequest.addListener(
  function (details) {
    if (details.type !== "script") return;
    if (!/\.js(\?.*)?$/.test(details.url)) return;
    if (/^chrome-extension:\/\//.test(details.url)) return;
    if (details.tabId == null || details.tabId < 0) return;

    chrome.tabs.get(details.tabId, function (tab) {
      if (chrome.runtime.lastError || !tab || !tab.url) return;
      var session = getOrCreateSession(tab);

      fetchSourceMap(details.url, function (mapUrl, content) {
        if (!isValidSourceMap(content)) return;
        session.maps[mapUrl] = content;
        refreshBadgeForTab(session.tabId, session.pageUrl);
        scheduleSessionPersist(session);
      });
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== "popup") return;

  popupPorts.push(port);
  pushSummary(port);

  port.onDisconnect.addListener(function () {
    popupPorts = popupPorts.filter(function (item) { return item !== port; });
  });

  port.onMessage.addListener(function (msg) {
    if (msg.action === "getVersionFiles") {
      loadVersionFiles(msg.versionId).then(function (files) {
        port.postMessage({ type: "versionFiles", versionId: msg.versionId, files: files });
      });
    } else if (msg.action === "clearAll") {
      deleteVersions(Object.keys(versionIndex)).then(function () {
        rebuildIndexes([]);
        broadcastSummary();
      });
    } else if (msg.action === "clearOlderThan7d") {
      var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      var removeIds = Object.keys(versionIndex).filter(function (id) {
        return new Date(versionIndex[id].lastSeenAt).getTime() < cutoff;
      });
      deleteVersions(removeIds).then(function () {
        removeVersionsFromIndexes(removeIds);
        refreshBadgeForActiveTab();
        broadcastSummary();
      });
    }
  });
});

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (message.action === "getPopupState") {
    var pageUrl = canonicalPageUrl(message.pageUrl || "");
    var latest = latestVersionForPage(pageUrl);

    if (!latest) {
      sendResponse({
        ok: true,
        pageUrl: pageUrl,
        latestVersion: null,
        files: [],
        totalStorageBytes: totalStorageBytes(),
        totalVersions: Object.keys(versionIndex).length
      });
      return;
    }

    loadVersionFiles(latest.id).then(function (files) {
      sendResponse({
        ok: true,
        pageUrl: pageUrl,
        latestVersion: {
          id: latest.id,
          label: versionLabel(latest, 0, (versionsByPage[pageUrl] || []).length),
          createdAt: latest.createdAt,
          lastSeenAt: latest.lastSeenAt,
          mapCount: latest.mapCount,
          byteSize: latest.byteSize,
          title: latest.title
        },
        files: files,
        totalStorageBytes: totalStorageBytes(),
        totalVersions: Object.keys(versionIndex).length
      });
    }).catch(function (err) {
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err)
      });
    });
    return true;
  }

  if (message.action === "getDashboardData") {
    sendResponse({
      pages: summarizePages(),
      distribution: distributionSummary(),
      settings: currentSettings(),
      totalVersions: Object.keys(versionIndex).length,
      totalStorageBytes: totalStorageBytes()
    });
    return;
  }

  if (message.action === "getVersionFiles") {
    loadVersionFiles(message.versionId).then(function (files) {
      sendResponse({ ok: true, files: files });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }

  if (message.action === "updateSettings") {
    saveSettings(message.settings)
      .then(function () {
        var tasks = Object.keys(versionsByPage).map(prunePageHistory);
        return Promise.all(tasks);
      })
      .then(function () {
        broadcastSummary();
        sendResponse({
          ok: true,
          settings: currentSettings(),
          totalVersions: Object.keys(versionIndex).length
        });
      });
    return true;
  }

  if (message.action === "deleteVersion") {
    deleteVersions([message.versionId]).then(function () {
      removeVersionsFromIndexes([message.versionId]);
      refreshBadgeForActiveTab();
      broadcastSummary();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === "deletePageHistory") {
    var pageUrl = canonicalPageUrl(message.pageUrl || "");
    deletePageHistory(pageUrl).then(function () {
      broadcastSummary();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === "cleanupData") {
    var allIds = Object.keys(versionIndex);
    if (allIds.length === 0) {
      sendResponse({ ok: true, cleaned: [] });
      return;
    }

    Promise.all(allIds.map(function (id) {
      var meta = versionIndex[id];
      if (!meta || !meta.mapUrls || meta.mapUrls.length === 0) {
        return { id: id, pageUrl: meta ? meta.pageUrl : "", reason: "no_maps_metadata", mapCount: 0, bad: true };
      }
      return loadVersionFiles(id).then(function (files) {
        if (!files || files.length === 0) {
          return { id: id, pageUrl: meta.pageUrl, reason: "all_maps_missing", mapCount: meta.mapUrls.length, bad: true };
        }
        return { id: id, bad: false };
      });
    })).then(function (results) {
      var badVersions = results.filter(function (r) { return r.bad; });
      if (badVersions.length === 0) {
        sendResponse({ ok: true, cleaned: [] });
        return;
      }
      var removeIds = badVersions.map(function (v) { return v.id; });
      return deleteVersions(removeIds).then(function () {
        removeVersionsFromIndexes(removeIds);
        refreshBadgeForActiveTab();
        broadcastSummary();
        sendResponse({ ok: true, cleaned: badVersions.map(function (v) { return { id: v.id, pageUrl: v.pageUrl, reason: v.reason, mapCount: v.mapCount }; }) });
      });
    }).catch(function (err) {
      console.error("[SourceD] cleanup failed:", err);
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }
});

Promise.all([listAllVersions(), loadSettings()]).then(function (results) {
  rebuildIndexes(results[0] || []);
}).catch(function (err) {
  console.warn("[SourceD] init failed:", err && err.message ? err.message : err);
});
