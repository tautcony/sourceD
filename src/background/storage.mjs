import {
  BLOB_STORE,
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
  normalizeSettings,
  sortPageVersions,
  state,
  versionLabel,
  buildSignatureFromRefs,
} from "./shared.mjs";
import {
  ensureStorageReady,
  getDb,
  listAllBlobsRaw,
  listAllVersionsRaw,
  loadBlobContentsRaw,
  loadStoredMapEntriesRaw,
  loadVersionRefsRaw,
  summarizeLegacyDataStores,
} from "./db.mjs";
export {
  ensureStorageReady,
  getDb,
  listAllBlobsRaw,
  listAllVersionsRaw,
  loadBlobContentsRaw,
  loadStoredMapEntriesRaw,
  loadVersionRefsRaw,
} from "./db.mjs";

const EMPTY_CLEANUP_STATS = {
  removedVersions: 0,
  removedMaps: 0,
  reclaimedBytes: 0,
  remainingVersions: 0,
  remainingMaps: 0,
  remainingBytes: 0,
  upgradedRefs: 0,
  upgradedVersions: 0,
};

function adjustBlobDelta(deltaByBlob, blobId, amount) {
  deltaByBlob[blobId] = (deltaByBlob[blobId] || 0) + amount;
  if (deltaByBlob[blobId] === 0) delete deltaByBlob[blobId];
}

function runtimeLastError() {
  const err = chrome.runtime?.lastError;
  if (!err) return null;
  return err instanceof Error ? err : new Error(err.message || String(err));
}

function uniqueBlobId(blobMap, preferredBlobId, content) {
  let candidate = preferredBlobId;
  let suffix = 1;
  while (blobMap[candidate] && blobMap[candidate].content !== content) {
    candidate = `${preferredBlobId}::dup${suffix}`;
    suffix++;
  }
  return candidate;
}

function cleanupErrorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function mergeCleanupStats(baseStats, stepStats) {
  if (!stepStats) return baseStats;
  return {
    removedVersions: (baseStats.removedVersions || 0) + (Number(stepStats.removedVersions) || 0),
    removedMaps: (baseStats.removedMaps || 0) + (Number(stepStats.removedMaps) || 0),
    reclaimedBytes: (baseStats.reclaimedBytes || 0) + (Number(stepStats.reclaimedBytes) || 0),
    upgradedRefs: (baseStats.upgradedRefs || 0) + (Number(stepStats.upgradedRefs) || 0),
    upgradedVersions: (baseStats.upgradedVersions || 0) + (Number(stepStats.upgradedVersions) || 0),
    remainingVersions: stepStats.remainingVersions ?? baseStats.remainingVersions,
    remainingMaps: stepStats.remainingMaps ?? baseStats.remainingMaps,
    remainingBytes: stepStats.remainingBytes ?? baseStats.remainingBytes,
  };
}

function rebuildVersionMetaFromRefs(meta, refs, siteKey) {
  const nextRefs = refs.slice().sort((a, b) => a.mapUrl.localeCompare(b.mapUrl));
  const mapUrls = nextRefs.map((ref) => ref.mapUrl);
  const byteSize = nextRefs.reduce((sum, ref) => sum + (Number(ref.byteSize) || 0), 0);
  return Object.assign({}, meta, {
    siteKey,
    mapUrls,
    mapCount: mapUrls.length,
    fileCount: mapUrls.length,
    byteSize,
    signature: buildSignatureFromRefs(nextRefs),
  });
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
    /* v8 ignore next -- defensive race guard if the blob disappears mid-transaction */
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
        /* v8 ignore start -- platform transaction failure hooks are not meaningful unit-test targets */
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        /* v8 ignore stop */
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
        /* v8 ignore start -- platform transaction failure hooks are not meaningful unit-test targets */
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        /* v8 ignore stop */
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
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([SETTINGS_KEY], (data) => {
      const err = runtimeLastError();
      if (err) {
        reject(err);
        return;
      }
      state.settings = normalizeSettings(data[SETTINGS_KEY]);
      resolve(state.settings);
    });
  });
}

export function saveSettings(nextSettings) {
  const mergedSettings = normalizeSettings(nextSettings);
  return new Promise((resolve, reject) => {
    const payload = {};
    payload[SETTINGS_KEY] = mergedSettings;
    chrome.storage.local.set(payload, () => {
      const err = runtimeLastError();
      if (err) {
        reject(err);
        return;
      }
      state.settings = mergedSettings;
      resolve(mergedSettings);
    });
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
  return state.settings || normalizeSettings();
}

export async function importSourceMapsForPage(payload) {
  const pageUrl = canonicalPageUrl(payload && payload.pageUrl ? payload.pageUrl : "");
  const title = payload && payload.title ? String(payload.title).trim() : "";
  const files = Array.isArray(payload && payload.files) ? payload.files : [];

  if (!pageUrl) {
    throw new Error("pageUrl is required");
  }
  if (!files.length) {
    throw new Error("No source map files were provided");
  }

  const siteKey = pageSiteKey(pageUrl);
  const now = new Date().toISOString();
  const refs = [];
  const blobs = {};
  let byteSize = 0;

  const sortedFiles = files
    .slice()
    .sort((a, b) => String(a.mapUrl || "").localeCompare(String(b.mapUrl || "")));

  for (const file of sortedFiles) {
    const mapUrl = String(file.mapUrl || "").trim();
    const content = typeof file.content === "string" ? file.content : "";
    if (!mapUrl || !content) continue;

    const mapHash = await hashString(content);
    const blobId = uniqueBlobId(blobs, blobStoreKey(siteKey, mapHash), content);
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
  }

  if (!refs.length) {
    throw new Error("No valid source map files were provided");
  }

  const signature = buildSignatureFromRefs(refs);
  const existingId = ensurePageBucket(pageUrl).find((id) => {
    return state.versionIndex[id] && state.versionIndex[id].signature === signature;
  });

  if (existingId) {
    return {
      ok: true,
      reusedExisting: true,
      versionId: existingId,
      importedCount: refs.length,
      skippedCount: Math.max(0, files.length - refs.length),
    };
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

  await persistVersionState(meta, refs, blobs, null);
  ensurePageBucket(pageUrl).unshift(versionId);
  state.versionIndex[versionId] = meta;
  sortPageVersions(pageUrl);
  if (currentSettings().autoCleanup) await prunePageHistory(pageUrl);
  refreshBadgeForActiveTab();
  return {
    ok: true,
    reusedExisting: false,
    versionId,
    importedCount: refs.length,
    skippedCount: Math.max(0, files.length - refs.length),
  };
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
    /* v8 ignore next -- disconnected popup ports are intentionally ignored */
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
  return Promise.all([loadStoredMapEntriesRaw(db, metas), listAllBlobsRaw(db)]).then(async (results) => {
    const entries = results[0];
    const existingBlobs = results[1];
    const existingBlobMap = {};
    const desiredRefs = [];
    const desiredBlobs = {};
    const desiredVersionMap = {};
    const invalidVersionMap = {};
    const validRefsByVersion = {};
    let upgradedRefs = 0;
    let upgradedVersions = 0;

    existingBlobs.forEach((blob) => {
      existingBlobMap[blob.id] = blob;
    });

    for (const entry of entries) {
      const meta = entry.meta;
      const siteKey = meta.siteKey || pageSiteKey(meta.pageUrl);
      const value = entry.value;
      let content = null;
      let mapHash = null;

      if (typeof value === "string") {
        content = value;
        upgradedRefs++;
      } else if (value) {
        const previousMapHash = value.mapHash || null;
        const blobId = value.blobId || (value.mapHash ? blobStoreKey(siteKey, value.mapHash) : null);
        if (blobId && existingBlobMap[blobId] && existingBlobMap[blobId].content != null) {
          content = existingBlobMap[blobId].content;
        }
        value._legacyMapHash = previousMapHash;
        value._legacyBlobId = blobId;
      }

      if (content == null) {
        continue;
      }

      mapHash = await hashString(content);
      let blobId = blobStoreKey(siteKey, mapHash);
      blobId = uniqueBlobId(desiredBlobs, blobId, content);

      const nextRef = {
        versionId: meta.id,
        mapUrl: entry.mapUrl,
        siteKey,
        mapHash,
        blobId,
        byteSize: content.length,
      };

      if (value && typeof value !== "string") {
        if (value._legacyMapHash !== mapHash || value._legacyBlobId !== blobId) {
          upgradedRefs++;
        }
      }

      desiredRefs.push({
        key: entry.key,
        value: nextRef,
      });

      if (!validRefsByVersion[meta.id]) validRefsByVersion[meta.id] = [];
      validRefsByVersion[meta.id].push(nextRef);

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
    }

    metas.forEach((meta) => {
      const refs = validRefsByVersion[meta.id] || [];
      if (refs.length === 0) {
        invalidVersionMap[meta.id] = {
          id: meta.id,
          pageUrl: meta.pageUrl,
          reason: "all_maps_missing",
          mapCount: meta.mapUrls ? meta.mapUrls.length : 0,
        };
        return;
      }
      const nextMeta = rebuildVersionMetaFromRefs(meta, refs, meta.siteKey || pageSiteKey(meta.pageUrl));
      if (
        nextMeta.signature !== meta.signature
        || nextMeta.byteSize !== meta.byteSize
        || JSON.stringify(nextMeta.mapUrls || []) !== JSON.stringify(meta.mapUrls || [])
        || nextMeta.mapCount !== meta.mapCount
      ) {
        upgradedVersions++;
      }
      desiredVersionMap[meta.id] = nextMeta;
    });

    return {
      desiredMetas: Object.keys(desiredVersionMap).map((id) => desiredVersionMap[id]),
      desiredRefs,
      desiredBlobs: Object.keys(desiredBlobs).map((blobId) => desiredBlobs[blobId]),
      invalidVersions: Object.keys(invalidVersionMap).map((id) => invalidVersionMap[id]),
      migration: {
        upgradedRefs,
        upgradedVersions,
      },
    };
  });
}

export function compactStorageData() {
  state.storageCompactionInProgress = true;
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

        storageState.desiredMetas.forEach((meta) => {
          if (!invalidMap[meta.id]) {
            versionStore.put(meta);
          }
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
        /* v8 ignore start -- platform transaction failure hooks are not meaningful unit-test targets */
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        /* v8 ignore stop */
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
          upgradedRefs: Number(storageState.migration?.upgradedRefs) || 0,
          upgradedVersions: Number(storageState.migration?.upgradedVersions) || 0,
        },
      };
    }));
  })).finally(() => {
    state.storageCompactionInProgress = false;
  });
}

export function cleanupLegacyDataTables() {
  return getDb().then((db) => {
    const summary = summarizeLegacyDataStores(db);
    const removedCount = summary.removedStores.length;
    const lingeringCount = summary.lingeringStores.length;

    return {
      checkedTables: summary.checkedStores,
      removedTables: summary.removedStores,
      lingeringTables: summary.lingeringStores,
      changed: removedCount > 0,
      summary: lingeringCount > 0
        ? `Legacy data tables still require cleanup: ${summary.lingeringStores.join(", ")}`
        : removedCount > 0
          ? `Removed ${removedCount} legacy data tables`
          : "Legacy data tables already clean",
    };
  });
}

export async function runCleanupTasks() {
  const stepDefs = [
    {
      id: "compact-storage",
      label: "Compact storage data",
      run: async () => {
        if (Object.keys(state.versionIndex).length === 0) {
          return {
            changed: false,
            cleaned: [],
            stats: EMPTY_CLEANUP_STATS,
            summary: "No stored versions required compaction",
          };
        }
        const result = await compactStorageData();
        const stats = result.stats || EMPTY_CLEANUP_STATS;
        return {
          changed: (result.invalidVersions || []).length > 0
            || (Number(stats.removedVersions) || 0) > 0
            || (Number(stats.removedMaps) || 0) > 0
            || (Number(stats.reclaimedBytes) || 0) > 0
            || (Number(stats.upgradedRefs) || 0) > 0
            || (Number(stats.upgradedVersions) || 0) > 0,
          cleaned: result.invalidVersions || [],
          stats,
          summary: `Compacted storage records: ${Number(stats.removedVersions) || 0} versions, ${Number(stats.removedMaps) || 0} maps, ${Number(stats.reclaimedBytes) || 0} bytes reclaimed, upgraded ${Number(stats.upgradedRefs) || 0} refs across ${Number(stats.upgradedVersions) || 0} versions`,
        };
      },
    },
    {
      id: "cleanup-data-tables",
      label: "Cleanup legacy data tables",
      run: cleanupLegacyDataTables,
    },
  ];

  const steps = [];
  let stats = { ...EMPTY_CLEANUP_STATS };
  let cleaned = [];
  let failedCount = 0;

  for (const stepDef of stepDefs) {
    try {
      const result = await stepDef.run();
      steps.push({
        id: stepDef.id,
        label: stepDef.label,
        ok: true,
        changed: !!result.changed,
        summary: result.summary || "",
        cleaned: result.cleaned || [],
        stats: result.stats || null,
        checkedTables: result.checkedTables || [],
        removedTables: result.removedTables || [],
        lingeringTables: result.lingeringTables || [],
      });
      cleaned = cleaned.concat(result.cleaned || []);
      stats = mergeCleanupStats(stats, result.stats);
    } catch (err) {
      failedCount++;
      steps.push({
        id: stepDef.id,
        label: stepDef.label,
        ok: false,
        changed: false,
        summary: `${stepDef.label} failed: ${cleanupErrorMessage(err)}`,
        error: cleanupErrorMessage(err),
      });
    }
  }

  return {
    ok: failedCount === 0,
    error: failedCount === 0 ? null : `${failedCount} cleanup steps failed`,
    cleaned,
    stats,
    steps,
  };
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
