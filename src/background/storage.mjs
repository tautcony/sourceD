import {
  BLOB_STORE,
  DB_NAME,
  DB_VERSION,
  DEFAULT_SETTINGS,
  MAP_STORE,
  SETTINGS_KEY,
  VERSION_STORE,
  blobStoreKey,
  ensurePageBucket,
  hashString,
  mapStoreKey,
  pageSiteKey,
  canonicalPageUrl,
  rebuildIndexes,
  refreshBadgeForActiveTab,
  refreshBadgeForTab,
  sortPageVersions,
  state,
  versionLabel,
  buildSignatureFromRefs,
} from "./shared.mjs";

export function getDb() {
  if (state.dbPromise) return state.dbPromise;
  state.dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VERSION_STORE)) {
        db.createObjectStore(VERSION_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MAP_STORE)) {
        db.createObjectStore(MAP_STORE);
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return state.dbPromise;
}

export function ensureStorageReady() {
  if (state.storageReadyPromise) return state.storageReadyPromise;
  state.storageReadyPromise = getDb()
    .then((db) => Promise.all([listAllVersionsRaw(db), listAllBlobsRaw(db)]).then((results) => {
      rebuildIndexes(results[0] || [], results[1] || []);
      return db;
    }))
    .then((db) => {
      refreshBadgeForActiveTab();
      return db;
    })
    .catch((err) => {
      state.storageReadyPromise = null;
      throw err;
    });
  return state.storageReadyPromise;
}

export function listAllVersionsRaw(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VERSION_STORE, "readonly");
    const req = tx.objectStore(VERSION_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export function listAllBlobsRaw(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readonly");
    const req = tx.objectStore(BLOB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export function loadStoredMapEntriesRaw(db, metas) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MAP_STORE, "readonly");
    const store = tx.objectStore(MAP_STORE);
    const entries = [];
    let pending = 0;

    metas.forEach((meta) => {
      (meta.mapUrls || []).forEach((mapUrl) => {
        pending++;
        const key = mapStoreKey(meta.id, mapUrl);
        const req = store.get(key);
        req.onsuccess = () => {
          entries.push({
            key,
            meta,
            mapUrl,
            value: req.result,
          });
          pending--;
          if (pending === 0) resolve(entries);
        };
        req.onerror = () => reject(req.error);
      });
    });

    if (pending === 0) resolve(entries);
  });
}

export function loadVersionRefsRaw(db, meta) {
  if (!meta || !meta.mapUrls || meta.mapUrls.length === 0) {
    return Promise.resolve([]);
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(MAP_STORE, "readonly");
    const store = tx.objectStore(MAP_STORE);
    const refs = [];
    let pending = meta.mapUrls.length;
    const siteKey = meta.siteKey || pageSiteKey(meta.pageUrl);

    meta.mapUrls.forEach((mapUrl) => {
      const req = store.get(mapStoreKey(meta.id, mapUrl));
      req.onsuccess = () => {
        const value = req.result;
        if (typeof value === "string") {
          const mapHash = hashString(value);
          refs.push({
            versionId: meta.id,
            mapUrl,
            siteKey,
            mapHash,
            blobId: blobStoreKey(siteKey, mapHash),
            byteSize: value.length,
            rawContent: value,
          });
        } else if (value != null) {
          refs.push(value);
        }
        pending--;
        if (pending === 0) resolve(refs);
      };
      req.onerror = () => reject(req.error);
    });
  });
}

export function loadBlobContentsRaw(db, blobIds) {
  if (!blobIds || blobIds.length === 0) return Promise.resolve({});

  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readonly");
    const store = tx.objectStore(BLOB_STORE);
    const uniqueIds = {};
    const ids = [];
    const contentById = {};

    blobIds.forEach((blobId) => {
      if (!blobId || uniqueIds[blobId]) return;
      uniqueIds[blobId] = true;
      ids.push(blobId);
    });

    if (ids.length === 0) {
      resolve(contentById);
      return;
    }

    let pending = ids.length;
    ids.forEach((blobId) => {
      const req = store.get(blobId);
      req.onsuccess = () => {
        if (req.result && req.result.content != null) {
          contentById[blobId] = req.result.content;
        }
        pending--;
        if (pending === 0) resolve(contentById);
      };
      req.onerror = () => reject(req.error);
    });
  });
}

function adjustBlobDelta(deltaByBlob, blobId, amount) {
  deltaByBlob[blobId] = (deltaByBlob[blobId] || 0) + amount;
  if (deltaByBlob[blobId] === 0) delete deltaByBlob[blobId];
}

function putBlobRecordWithRefCount(blobStore, blobId, nextCount, fallbackRecord) {
  if (fallbackRecord && fallbackRecord.content != null) {
    blobStore.put({
      id: blobId,
      siteKey: fallbackRecord.siteKey,
      mapHash: fallbackRecord.mapHash,
      byteSize: fallbackRecord.byteSize || 0,
      content: fallbackRecord.content,
      createdAt: fallbackRecord.createdAt || new Date().toISOString(),
      refCount: nextCount,
    });
    return;
  }

  const getReq = blobStore.get(blobId);
  getReq.onsuccess = () => {
    const existing = getReq.result;
    if (!existing) return;
    blobStore.put(Object.assign({}, existing, { refCount: nextCount }));
  };
}

export function persistVersionState(nextMeta, nextRefs, nextBlobs, previousMeta) {
  return ensureStorageReady()
    .then((db) => {
      if (!previousMeta) return { db, previousRefs: [] };
      return loadVersionRefsRaw(db, previousMeta).then((previousRefs) => ({ db, previousRefs }));
    })
    .then((payload) => {
      const { db, previousRefs } = payload;
      const deltaByBlob = {};

      previousRefs.forEach((ref) => {
        adjustBlobDelta(deltaByBlob, ref.blobId, -1);
      });
      nextRefs.forEach((ref) => {
        adjustBlobDelta(deltaByBlob, ref.blobId, 1);
      });

      return new Promise((resolve, reject) => {
        const tx = db.transaction([VERSION_STORE, MAP_STORE, BLOB_STORE], "readwrite");
        const versionStore = tx.objectStore(VERSION_STORE);
        const mapStore = tx.objectStore(MAP_STORE);
        const blobStore = tx.objectStore(BLOB_STORE);

        versionStore.put(nextMeta);

        if (previousMeta) {
          (previousMeta.mapUrls || []).forEach((mapUrl) => {
            mapStore.delete(mapStoreKey(previousMeta.id, mapUrl));
          });
        }

        nextRefs.forEach((ref) => {
          const storedRef = Object.assign({}, ref, { versionId: nextMeta.id });
          mapStore.put(storedRef, mapStoreKey(nextMeta.id, ref.mapUrl));
        });

        Object.keys(deltaByBlob).forEach((blobId) => {
          const current = state.blobIndex[blobId];
          const nextCount = (current ? current.refCount : 0) + deltaByBlob[blobId];

          if (nextCount <= 0) {
            blobStore.delete(blobId);
            return;
          }

          putBlobRecordWithRefCount(blobStore, blobId, nextCount, nextBlobs[blobId] || null);
        });

        tx.oncomplete = () => {
          state.versionIndex[nextMeta.id] = nextMeta;

          Object.keys(deltaByBlob).forEach((blobId) => {
            const current = state.blobIndex[blobId];
            const nextCount = (current ? current.refCount : 0) + deltaByBlob[blobId];

            if (nextCount <= 0) {
              delete state.blobIndex[blobId];
              return;
            }

            const template = current || nextBlobs[blobId];
            if (!template) return;

            state.blobIndex[blobId] = {
              id: blobId,
              siteKey: template.siteKey,
              mapHash: template.mapHash,
              byteSize: template.byteSize || 0,
              createdAt: template.createdAt || new Date().toISOString(),
              refCount: nextCount,
            };
          });

          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    });
}

export function deleteVersions(versionIds) {
  if (versionIds.length === 0) return Promise.resolve();

  return ensureStorageReady()
    .then((db) => {
      const metas = versionIds.map((id) => state.versionIndex[id]).filter(Boolean);
      return Promise.all(metas.map((meta) => loadVersionRefsRaw(db, meta))).then((refsByVersion) => ({ db, metas, refsByVersion }));
    })
    .then((payload) => {
      const { db, metas, refsByVersion } = payload;
      const deltaByBlob = {};

      refsByVersion.forEach((refs) => {
        refs.forEach((ref) => {
          adjustBlobDelta(deltaByBlob, ref.blobId, -1);
        });
      });

      return new Promise((resolve, reject) => {
        const tx = db.transaction([VERSION_STORE, MAP_STORE, BLOB_STORE], "readwrite");
        const versionStore = tx.objectStore(VERSION_STORE);
        const mapStore = tx.objectStore(MAP_STORE);
        const blobStore = tx.objectStore(BLOB_STORE);

        metas.forEach((meta) => {
          versionStore.delete(meta.id);
          (meta.mapUrls || []).forEach((mapUrl) => {
            mapStore.delete(mapStoreKey(meta.id, mapUrl));
          });
        });

        Object.keys(deltaByBlob).forEach((blobId) => {
          const current = state.blobIndex[blobId];
          const nextCount = (current ? current.refCount : 0) + deltaByBlob[blobId];
          if (nextCount <= 0) blobStore.delete(blobId);
          else putBlobRecordWithRefCount(blobStore, blobId, nextCount, null);
        });

        tx.oncomplete = () => {
          Object.keys(deltaByBlob).forEach((blobId) => {
            const current = state.blobIndex[blobId];
            const nextCount = (current ? current.refCount : 0) + deltaByBlob[blobId];
            if (nextCount <= 0) delete state.blobIndex[blobId];
            else state.blobIndex[blobId] = Object.assign({}, current, { refCount: nextCount });
          });
          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    });
}

export function removeVersionsFromIndexes(versionIds) {
  versionIds.forEach((id) => {
    const meta = state.versionIndex[id];
    if (meta && state.versionsByPage[meta.pageUrl]) {
      state.versionsByPage[meta.pageUrl] = state.versionsByPage[meta.pageUrl].filter((item) => item !== id);
      if (state.versionsByPage[meta.pageUrl].length === 0) delete state.versionsByPage[meta.pageUrl];
    }
    delete state.versionIndex[id];
  });
}

export function deletePageHistory(pageUrl) {
  const ids = (state.versionsByPage[pageUrl] || []).slice();
  return deleteVersions(ids).then(() => {
    removeVersionsFromIndexes(ids);
    refreshBadgeForActiveTab();
  });
}

export function loadVersionFiles(versionId) {
  const meta = state.versionIndex[versionId];
  if (!meta) return Promise.resolve([]);

  return ensureStorageReady().then((db) => loadVersionRefsRaw(db, meta).then((refs) => {
    return loadBlobContentsRaw(db, refs.map((ref) => ref.blobId)).then((blobContent) => {
      return refs.map((ref) => {
        let content = blobContent[ref.blobId];
        if (content == null && ref.rawContent != null) content = ref.rawContent;
        if (content == null) return null;
        return {
          url: ref.mapUrl,
          content,
          page: {
            url: meta.pageUrl,
            title: meta.title,
            id: meta.tabId || null,
          },
          versionId,
        };
      }).filter(Boolean);
    });
  }));
}

export function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SETTINGS_KEY], (data) => {
      state.settings = Object.assign({}, DEFAULT_SETTINGS, data[SETTINGS_KEY] || {});
      resolve(state.settings);
    });
  });
}

export function saveSettings(nextSettings) {
  state.settings = Object.assign({}, DEFAULT_SETTINGS, nextSettings || {});
  return new Promise((resolve) => {
    const payload = {};
    payload[SETTINGS_KEY] = state.settings;
    chrome.storage.local.set(payload, resolve);
  });
}

export function summarizePages() {
  const pageUrls = Object.keys(state.versionsByPage).sort((a, b) => {
    const av = state.versionIndex[state.versionsByPage[a][0]];
    const bv = state.versionIndex[state.versionsByPage[b][0]];
    return new Date(bv.createdAt || bv.lastSeenAt).getTime() - new Date(av.createdAt || av.lastSeenAt).getTime();
  });

  return pageUrls.map((pageUrl) => {
    const ids = state.versionsByPage[pageUrl];
    const metas = ids.map((id) => state.versionIndex[id]);
    return {
      pageUrl,
      title: metas[0].title,
      siteKey: metas[0].siteKey,
      versions: metas.map((meta, index) => ({
        id: meta.id,
        label: versionLabel(meta, index, metas.length),
        createdAt: meta.createdAt,
        lastSeenAt: meta.lastSeenAt,
        mapCount: meta.mapCount,
        byteSize: meta.byteSize,
        signature: meta.signature,
      })),
    };
  });
}

export function distributionSummary() {
  const bySite = {};
  Object.keys(state.versionIndex).forEach((id) => {
    const meta = state.versionIndex[id];
    if (!bySite[meta.siteKey]) {
      bySite[meta.siteKey] = {
        siteKey: meta.siteKey,
        versionCount: 0,
        mapCount: 0,
        byteSize: 0,
      };
    }
    bySite[meta.siteKey].versionCount++;
  });

  Object.keys(state.blobIndex).forEach((blobId) => {
    const blob = state.blobIndex[blobId];
    if (!bySite[blob.siteKey]) {
      bySite[blob.siteKey] = {
        siteKey: blob.siteKey,
        versionCount: 0,
        mapCount: 0,
        byteSize: 0,
      };
    }
    bySite[blob.siteKey].mapCount++;
    bySite[blob.siteKey].byteSize += blob.byteSize || 0;
  });

  return Object.keys(bySite).sort().map((key) => bySite[key]);
}

export function totalStorageBytes() {
  return Object.keys(state.blobIndex).reduce((sum, id) => sum + (state.blobIndex[id].byteSize || 0), 0);
}

export function currentSettings() {
  return state.settings || DEFAULT_SETTINGS;
}

export function importSourceMapsForPage(payload) {
  const pageUrl = canonicalPageUrl(payload && payload.pageUrl ? payload.pageUrl : "");
  const title = payload && payload.title ? String(payload.title).trim() : "";
  const files = Array.isArray(payload && payload.files) ? payload.files : [];

  if (!pageUrl) {
    return Promise.reject(new Error("pageUrl is required"));
  }
  if (!files.length) {
    return Promise.reject(new Error("No source map files were provided"));
  }

  const siteKey = pageSiteKey(pageUrl);
  const now = new Date().toISOString();
  const refs = [];
  const blobs = {};
  let byteSize = 0;

  files
    .slice()
    .sort((a, b) => String(a.mapUrl || "").localeCompare(String(b.mapUrl || "")))
    .forEach((file) => {
      const mapUrl = String(file.mapUrl || "").trim();
      const content = typeof file.content === "string" ? file.content : "";
      if (!mapUrl || !content) return;

      const mapHash = hashString(content);
      const blobId = blobStoreKey(siteKey, mapHash);
      byteSize += content.length;

      refs.push({
        versionId: "",
        mapUrl,
        siteKey,
        mapHash,
        blobId,
        byteSize: content.length,
      });

      if (!blobs[blobId]) {
        blobs[blobId] = {
          id: blobId,
          siteKey,
          mapHash,
          byteSize: content.length,
          content,
          createdAt: now,
          refCount: 0,
        };
      }
    });

  if (!refs.length) {
    return Promise.reject(new Error("No valid source map files were provided"));
  }

  const signature = buildSignatureFromRefs(refs);
  const existingId = ensurePageBucket(pageUrl).find((id) => {
    return state.versionIndex[id] && state.versionIndex[id].signature === signature;
  });

  if (existingId) {
    return Promise.resolve({
      ok: true,
      reusedExisting: true,
      versionId: existingId,
      importedCount: refs.length,
      skippedCount: Math.max(0, files.length - refs.length),
    });
  }

  const versionId = `${pageUrl}::${Date.now()}::${Math.random().toString(36).slice(2, 8)}`;
  const meta = {
    id: versionId,
    pageUrl,
    siteKey,
    title: title || pageUrl,
    createdAt: now,
    lastSeenAt: now,
    signature,
    mapUrls: refs.map((ref) => ref.mapUrl),
    mapCount: refs.length,
    fileCount: refs.length,
    byteSize,
    tabId: null,
  };

  ensurePageBucket(pageUrl).unshift(versionId);
  state.versionIndex[versionId] = meta;
  sortPageVersions(pageUrl);

  return persistVersionState(meta, refs, blobs, null)
    .then(() => {
      if (currentSettings().autoCleanup) return prunePageHistory(pageUrl);
      return null;
    })
    .then(() => {
      refreshBadgeForActiveTab();
      return {
        ok: true,
        reusedExisting: false,
        versionId,
        importedCount: refs.length,
        skippedCount: Math.max(0, files.length - refs.length),
      };
    });
}

export function pushSummary(port) {
  port.postMessage({
    type: "summary",
    pages: summarizePages(),
    distribution: distributionSummary(),
    settings: state.settings,
    totalVersions: Object.keys(state.versionIndex).length,
    totalStorageBytes: totalStorageBytes(),
  });
}

export function broadcastSummary() {
  state.popupPorts.forEach((port) => {
    try {
      pushSummary(port);
    } catch {
      // ignore disconnected popup ports
    }
  });
}

export function prunePageHistory(pageUrl) {
  const cfg = currentSettings();
  const ids = ensurePageBucket(pageUrl).slice();
  const removeIds = [];
  const cutoff = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000;

  ids.forEach((id, index) => {
    const meta = state.versionIndex[id];
    if (!meta) return;
    const old = new Date(meta.lastSeenAt).getTime() < cutoff;
    const overflow = index >= cfg.maxVersionsPerPage;
    if (old || overflow) removeIds.push(id);
  });

  if (removeIds.length === 0) return Promise.resolve();

  return deleteVersions(removeIds).then(() => {
    removeVersionsFromIndexes(removeIds);
    refreshBadgeForActiveTab();
  });
}

export function buildCompactedStorageState(db, metas) {
  return Promise.all([loadStoredMapEntriesRaw(db, metas), listAllBlobsRaw(db)]).then((results) => {
    const entries = results[0];
    const existingBlobs = results[1];
    const existingBlobMap = {};
    const desiredRefs = [];
    const desiredBlobs = {};
    const invalidVersionMap = {};

    existingBlobs.forEach((blob) => {
      existingBlobMap[blob.id] = blob;
    });

    entries.forEach((entry) => {
      const meta = entry.meta;
      const siteKey = meta.siteKey || pageSiteKey(meta.pageUrl);
      const value = entry.value;
      let content = null;
      let mapHash = null;
      let blobId = null;

      if (typeof value === "string") {
        content = value;
        mapHash = hashString(content);
        blobId = blobStoreKey(siteKey, mapHash);
      } else if (value) {
        mapHash = value.mapHash || null;
        blobId = value.blobId || (mapHash ? blobStoreKey(siteKey, mapHash) : null);
        if (blobId && existingBlobMap[blobId] && existingBlobMap[blobId].content != null) {
          content = existingBlobMap[blobId].content;
        }
      }

      if (content == null) {
        invalidVersionMap[meta.id] = {
          id: meta.id,
          pageUrl: meta.pageUrl,
          reason: "all_maps_missing",
          mapCount: meta.mapUrls ? meta.mapUrls.length : 0,
        };
        return;
      }

      if (!mapHash) mapHash = hashString(content);
      if (!blobId) blobId = blobStoreKey(siteKey, mapHash);

      desiredRefs.push({
        key: entry.key,
        value: {
          versionId: meta.id,
          mapUrl: entry.mapUrl,
          siteKey,
          mapHash,
          blobId,
          byteSize: content.length,
        },
      });

      if (!desiredBlobs[blobId]) {
        desiredBlobs[blobId] = {
          id: blobId,
          siteKey,
          mapHash,
          byteSize: content.length,
          content,
          createdAt: (existingBlobMap[blobId] && existingBlobMap[blobId].createdAt) || meta.createdAt || meta.lastSeenAt || new Date().toISOString(),
          refCount: 0,
        };
      }
      desiredBlobs[blobId].refCount++;
    });

    return {
      desiredRefs,
      desiredBlobs: Object.keys(desiredBlobs).map((blobId) => desiredBlobs[blobId]),
      invalidVersions: Object.keys(invalidVersionMap).map((id) => invalidVersionMap[id]),
    };
  });
}

export function compactStorageData() {
  return ensureStorageReady().then((db) => listAllVersionsRaw(db).then((metas) => {
    const beforeVersionCount = metas.length;
    const beforeMapCount = Object.keys(state.blobIndex).length;
    const beforeBytes = totalStorageBytes();

    return buildCompactedStorageState(db, metas).then((storageState) => {
      const invalidMap = {};
      storageState.invalidVersions.forEach((item) => {
        invalidMap[item.id] = true;
      });

      return new Promise((resolve, reject) => {
        const tx = db.transaction([VERSION_STORE, MAP_STORE, BLOB_STORE], "readwrite");
        const versionStore = tx.objectStore(VERSION_STORE);
        const mapStore = tx.objectStore(MAP_STORE);
        const blobStore = tx.objectStore(BLOB_STORE);

        mapStore.clear();
        blobStore.clear();

        metas.forEach((meta) => {
          if (invalidMap[meta.id]) versionStore.delete(meta.id);
        });

        storageState.desiredRefs.forEach((entry) => {
          if (!invalidMap[entry.value.versionId]) {
            mapStore.put(entry.value, entry.key);
          }
        });

        storageState.desiredBlobs.forEach((blob) => {
          blobStore.put(blob);
        });

        tx.oncomplete = () => resolve(storageState);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }).then((storageState) => Promise.all([listAllVersionsRaw(db), listAllBlobsRaw(db)]).then((results) => {
      rebuildIndexes(results[0] || [], results[1] || []);
      refreshBadgeForActiveTab();
      return {
        invalidVersions: storageState.invalidVersions,
        stats: {
          removedVersions: Math.max(0, beforeVersionCount - results[0].length),
          removedMaps: Math.max(0, beforeMapCount - results[1].length),
          reclaimedBytes: Math.max(0, beforeBytes - totalStorageBytes()),
          remainingVersions: results[0].length,
          remainingMaps: results[1].length,
          remainingBytes: totalStorageBytes(),
        },
      };
    }));
  }));
}

export function clearSessionsForPage(pageUrl) {
  Object.keys(state.tabSessions).forEach((tabId) => {
    const session = state.tabSessions[tabId];
    if (!session || session.pageUrl !== pageUrl) return;
    if (session.timer) clearTimeout(session.timer);
    session.maps = {};
    session.versionId = null;
    session.versionOwned = false;
    session.signature = null;
    refreshBadgeForTab(Number(tabId), pageUrl);
  });
}

export function clearSessionsForSiteKey(siteKey) {
  Object.keys(state.tabSessions).forEach((tabId) => {
    const session = state.tabSessions[tabId];
    if (!session || pageSiteKey(session.pageUrl) !== siteKey) return;
    if (session.timer) clearTimeout(session.timer);
    session.maps = {};
    session.versionId = null;
    session.versionOwned = false;
    session.signature = null;
    refreshBadgeForTab(Number(tabId), session.pageUrl);
  });
}

export function deletePageHistoryAndSessions(pageUrl) {
  return deletePageHistory(pageUrl).then(() => {
    clearSessionsForPage(pageUrl);
    refreshBadgeForActiveTab();
  });
}

export function deleteSiteHistoryAndSessions(siteKey) {
  const pageUrls = Object.keys(state.versionsByPage).filter((pageUrl) => pageSiteKey(pageUrl) === siteKey);
  const versionIds = pageUrls.flatMap((pageUrl) => (state.versionsByPage[pageUrl] || []).slice());

  return deleteVersions(versionIds).then(() => {
    removeVersionsFromIndexes(versionIds);
    clearSessionsForSiteKey(siteKey);
    refreshBadgeForActiveTab();
  });
}
