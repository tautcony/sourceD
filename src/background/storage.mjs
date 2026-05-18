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
  findBestVersionMatch,
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
import { decodeBlobContent, encodeBlobContent } from "./compression.mjs";
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

function hasExtractableMapContent(raw) {
  try {
    const data = JSON.parse(raw.replace(/^\)\]\}'/, ""));
    return (
      data.version === 3 &&
      Array.isArray(data.sources) && data.sources.length > 0 &&
      Array.isArray(data.sourcesContent) &&
      data.sourcesContent.some((content) => content != null && content.trim() !== "")
    );
  } catch {
    return false;
  }
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

function sizeDisplayMode() {
  return currentSettings().sizeDisplayMode === "compressed" ? "compressed" : "uncompressed";
}

function displayBytes(uncompressedBytes, compressedBytes, mode = sizeDisplayMode()) {
  if (mode === "compressed") {
    return Number(compressedBytes ?? uncompressedBytes) || 0;
  }
  return Number(uncompressedBytes ?? compressedBytes) || 0;
}

function storedBlobBytes(blob) {
  if (!blob) return 0;
  return Number(blob.storedByteSize ?? blob.byteSize) || 0;
}

function storedBytesForRefs(refs, blobLookup = {}) {
  return (refs || []).reduce((sum, ref) => {
    if (!ref) return sum;
    if (ref.storedByteSize != null) return sum + (Number(ref.storedByteSize) || 0);
    if (ref.blobId && blobLookup[ref.blobId]) return sum + storedBlobBytes(blobLookup[ref.blobId]);
    return sum + (Number(ref.byteSize) || 0);
  }, 0);
}

function withStoredByteSize(meta, refs, blobLookup = {}) {
  return Object.assign({}, meta, {
    storedByteSize: storedBytesForRefs(refs, blobLookup),
  });
}

function metaDisplayByteSize(meta, mode = sizeDisplayMode()) {
  return displayBytes(meta?.byteSize, meta?.storedByteSize, mode);
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
    storedByteSize: meta.storedByteSize ?? byteSize,
    signature: buildSignatureFromRefs(nextRefs),
  });
}

function signatureTokens(signature) {
  return String(signature || "").split("|").filter(Boolean);
}

function timeValue(value) {
  const stamp = new Date(value || 0).getTime();
  return Number.isFinite(stamp) ? stamp : 0;
}

function metaSortValue(meta) {
  return timeValue(meta.createdAt) || timeValue(meta.lastSeenAt);
}

function compareMetaByTimeline(a, b) {
  return metaSortValue(a) - metaSortValue(b)
    || timeValue(a.lastSeenAt) - timeValue(b.lastSeenAt)
    || String(a.id || "").localeCompare(String(b.id || ""));
}

function findBestCompactionMatch(metaMap, ids, signature) {
  const candidateTokens = signatureTokens(signature);
  if (!candidateTokens.length) return null;

  const candidateSet = new Set(candidateTokens);
  let supersetId = null;
  let bestExtraCount = Infinity;

  for (const id of ids) {
    const meta = metaMap[id];
    if (!meta?.signature) continue;
    if (meta.signature === signature) return id;

    const existingTokens = signatureTokens(meta.signature);
    if (existingTokens.length <= candidateTokens.length) continue;

    const existingSet = new Set(existingTokens);
    let isSuperset = true;
    for (const token of candidateSet) {
      if (!existingSet.has(token)) {
        isSuperset = false;
        break;
      }
    }
    if (!isSuperset) continue;

    const extraCount = existingTokens.length - candidateTokens.length;
    if (extraCount < bestExtraCount) {
      bestExtraCount = extraCount;
      supersetId = id;
    }
  }

  return supersetId;
}

function mergeCompactedMeta(targetMeta, incomingMeta) {
  const targetCreated = timeValue(targetMeta.createdAt);
  const incomingCreated = timeValue(incomingMeta.createdAt);
  const targetSeen = timeValue(targetMeta.lastSeenAt || targetMeta.createdAt);
  const incomingSeen = timeValue(incomingMeta.lastSeenAt || incomingMeta.createdAt);
  const useIncomingDisplay = incomingSeen >= targetSeen;

  return Object.assign({}, targetMeta, {
    createdAt: targetCreated && incomingCreated
      ? (incomingCreated < targetCreated ? incomingMeta.createdAt : targetMeta.createdAt)
      : (targetMeta.createdAt || incomingMeta.createdAt),
    lastSeenAt: incomingSeen > targetSeen
      ? (incomingMeta.lastSeenAt || incomingMeta.createdAt || targetMeta.lastSeenAt)
      : (targetMeta.lastSeenAt || incomingMeta.lastSeenAt || incomingMeta.createdAt),
    title: useIncomingDisplay && incomingMeta.title ? incomingMeta.title : targetMeta.title,
    tabId: useIncomingDisplay && incomingMeta.tabId != null ? incomingMeta.tabId : targetMeta.tabId,
    pageUrl: canonicalPageUrl(targetMeta.pageUrl || incomingMeta.pageUrl || ""),
    siteKey: targetMeta.siteKey || incomingMeta.siteKey || pageSiteKey(targetMeta.pageUrl || incomingMeta.pageUrl || ""),
  });
}

function hasVersionMetaChanged(previousMeta, nextMeta) {
  if (!previousMeta) return true;
  return previousMeta.pageUrl !== nextMeta.pageUrl
    || previousMeta.siteKey !== nextMeta.siteKey
    || previousMeta.signature !== nextMeta.signature
    || previousMeta.byteSize !== nextMeta.byteSize
    || previousMeta.storedByteSize !== nextMeta.storedByteSize
    || previousMeta.mapCount !== nextMeta.mapCount
    || previousMeta.fileCount !== nextMeta.fileCount
    || previousMeta.title !== nextMeta.title
    || previousMeta.tabId !== nextMeta.tabId
    || previousMeta.lastSeenAt !== nextMeta.lastSeenAt
    || JSON.stringify(previousMeta.mapUrls || []) !== JSON.stringify(nextMeta.mapUrls || []);
}

function putBlobRecordWithRefCount(blobStore, blobId, nextCount, fallbackRecord) {
  if (fallbackRecord && fallbackRecord.content != null) {
    blobStore.put({
      id: blobId,
      siteKey: fallbackRecord.siteKey,
      mapHash: fallbackRecord.mapHash,
      byteSize: fallbackRecord.byteSize || 0,
      storedByteSize: fallbackRecord.storedByteSize ?? fallbackRecord.byteSize ?? 0,
      contentByteSize: fallbackRecord.contentByteSize ?? fallbackRecord.byteSize ?? 0,
      compression: fallbackRecord.compression || "identity",
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

async function prepareBlobRecordForStorage(blob) {
  const encoded = await encodeBlobContent(blob.content);
  return Object.assign({}, blob, {
    compression: encoded.compression,
    content: encoded.content,
    storedByteSize: encoded.storedByteSize,
    contentByteSize: encoded.contentByteSize,
  });
}

async function prepareBlobMapForStorage(blobMap) {
  const prepared = {};
  await Promise.all(Object.keys(blobMap || {}).map(async (blobId) => {
    prepared[blobId] = await prepareBlobRecordForStorage(blobMap[blobId]);
  }));
  return prepared;
}

export function persistVersionState(nextMeta, nextRefs, nextBlobs, previousMeta) {
  return ensureStorageReady()
    .then((db) => {
      if (!previousMeta) return { db, previousRefs: [] };
      return loadVersionRefsRaw(db, previousMeta).then((previousRefs) => ({ db, previousRefs }));
    })
    .then(async (payload) => {
      const preparedBlobs = await prepareBlobMapForStorage(nextBlobs || {});
      const persistedMeta = withStoredByteSize(nextMeta, nextRefs, preparedBlobs);
      return Object.assign({}, payload, { preparedBlobs, persistedMeta });
    })
    .then((payload) => {
      const { db, previousRefs, preparedBlobs, persistedMeta } = payload;
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

        versionStore.put(persistedMeta);

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

          putBlobRecordWithRefCount(blobStore, blobId, nextCount, preparedBlobs[blobId] || null);
        });

        tx.oncomplete = () => {
          state.versionIndex[persistedMeta.id] = persistedMeta;

          Object.keys(deltaByBlob).forEach((blobId) => {
            const current = state.blobIndex[blobId];
            const nextCount = (current ? current.refCount : 0) + deltaByBlob[blobId];

            if (nextCount <= 0) {
              delete state.blobIndex[blobId];
              delete state.blobSiteIndex[blobId];
              return;
            }

            const template = current || preparedBlobs[blobId];
            if (!template) return;

            state.blobIndex[blobId] = {
              id: blobId,
              siteKey: template.siteKey,
              mapHash: template.mapHash,
              byteSize: template.byteSize || 0,
              storedByteSize: template.storedByteSize ?? template.byteSize ?? 0,
              contentByteSize: template.contentByteSize ?? template.byteSize ?? 0,
              compression: template.compression || "identity",
              createdAt: template.createdAt || new Date().toISOString(),
              refCount: nextCount,
            };
          });

          nextRefs.forEach((ref) => {
            if (ref?.blobId) state.blobSiteIndex[ref.blobId] = persistedMeta.siteKey || pageSiteKey(persistedMeta.pageUrl);
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

export function touchVersionMeta(nextMeta) {
    return ensureStorageReady().then((db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction([VERSION_STORE], "readwrite");
        const versionStore = tx.objectStore(VERSION_STORE);
        versionStore.put(nextMeta);

        tx.oncomplete = () => {
          state.versionIndex[nextMeta.id] = nextMeta;
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
            if (nextCount <= 0) {
              delete state.blobIndex[blobId];
              delete state.blobSiteIndex[blobId];
            } else {
              state.blobIndex[blobId] = Object.assign({}, current, { refCount: nextCount });
            }
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

export function loadVersionRefs(versionId) {
  const meta = state.versionIndex[versionId];
  if (!meta) return Promise.resolve([]);
  return ensureStorageReady().then((db) => loadVersionRefsRaw(db, meta));
}

export function loadVersionFiles(versionId, options = {}) {
  const meta = state.versionIndex[versionId];
  if (!meta) return Promise.resolve([]);
  const includeContent = options.includeContent !== false;
  const mode = sizeDisplayMode();

  return ensureStorageReady().then((db) => loadVersionRefsRaw(db, meta).then((refs) => {
    if (!includeContent) {
      return refs.map((ref) => ({
        url: ref.mapUrl,
        byteSize: displayBytes(ref.byteSize, state.blobIndex[ref.blobId]?.storedByteSize, mode),
        rawByteSize: Number(ref.byteSize) || 0,
        storedByteSize: storedBlobBytes(state.blobIndex[ref.blobId]),
        refCount: ref.blobId ? Math.max(1, Number(state.blobIndex[ref.blobId]?.refCount) || 0) : 1,
        page: {
          url: meta.pageUrl,
          title: meta.title,
          id: meta.tabId || null,
        },
        versionId,
      }));
    }
    return loadBlobContentsRaw(db, refs.map((ref) => ref.blobId)).then((blobContent) => {
      return refs.map((ref) => {
        let content = blobContent[ref.blobId];
        if (content == null && ref.rawContent != null) content = ref.rawContent;
        if (content == null) return null;
        return {
          url: ref.mapUrl,
          content,
          byteSize: displayBytes(ref.byteSize, state.blobIndex[ref.blobId]?.storedByteSize, mode),
          rawByteSize: Number(ref.byteSize) || content.length,
          storedByteSize: storedBlobBytes(state.blobIndex[ref.blobId]),
          refCount: ref.blobId ? Math.max(1, Number(state.blobIndex[ref.blobId]?.refCount) || 0) : 1,
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
  const mode = sizeDisplayMode();
  const pageUrls = Object.keys(state.versionsByPage).sort((a, b) => {
    const av = state.versionIndex[state.versionsByPage[a][0]];
    const bv = state.versionIndex[state.versionsByPage[b][0]];
    return new Date((bv?.createdAt || bv?.lastSeenAt) || 0).getTime() - new Date((av?.createdAt || av?.lastSeenAt) || 0).getTime();
  });

  return pageUrls.map((pageUrl) => {
    const ids = state.versionsByPage[pageUrl];
    const metas = ids.map((id) => state.versionIndex[id]).filter(Boolean);
    if (!metas.length) return null;
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
        byteSize: metaDisplayByteSize(meta, mode),
        rawByteSize: Number(meta.byteSize) || 0,
        storedByteSize: Number(meta.storedByteSize ?? meta.byteSize) || 0,
        signature: meta.signature,
      })),
    };
  }).filter(Boolean);
}

export function distributionSummary() {
  const mode = sizeDisplayMode();
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
    bySite[meta.siteKey].mapCount += Number(meta.mapCount) || 0;
    bySite[meta.siteKey].byteSize += metaDisplayByteSize(meta, mode);
  });

  return Object.keys(bySite).sort().map((key) => bySite[key]);
}

export function totalStorageBytes() {
  return Object.keys(state.versionIndex).reduce((sum, id) => sum + metaDisplayByteSize(state.versionIndex[id]), 0);
}

function totalStoredBlobBytes() {
  return Object.keys(state.blobIndex).reduce((sum, id) => sum + storedBlobBytes(state.blobIndex[id]), 0);
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
  const { exactId, supersetId } = findBestVersionMatch(pageUrl, signature);
  const existingId = exactId || supersetId;

  if (existingId) {
    const previousMeta = state.versionIndex[existingId];
    if (previousMeta) {
      const nextMeta = Object.assign({}, previousMeta, {
        title: title || previousMeta.title,
        lastSeenAt: now,
      });
      await touchVersionMeta(nextMeta);
      sortPageVersions(pageUrl);
      refreshBadgeForActiveTab();
    }
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
    storedByteSize: byteSize,
    tabId: null,
  };

  await persistVersionState(meta, refs, blobs, null);
  ensurePageBucket(pageUrl).unshift(versionId);
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
    const existingBlobContent = {};
    const invalidVersionMap = {};
    const recoveredRefsByVersion = {};
    const originalMetaById = {};
    const desiredRefs = [];
    const desiredBlobs = {};
    const desiredVersionMap = {};
    const desiredRefsByVersion = {};
    const desiredIdsByPage = {};
    let upgradedRefs = 0;

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
          if (!(blobId in existingBlobContent)) {
            existingBlobContent[blobId] = await decodeBlobContent(existingBlobMap[blobId]);
          }
          content = existingBlobContent[blobId];
        }
        value._legacyMapHash = previousMapHash;
        value._legacyBlobId = blobId;
      }

      if (content == null) {
        continue;
      }

      if (!hasExtractableMapContent(content)) {
        continue;
      }

      mapHash = await hashString(content);
      const nextRef = {
        mapUrl: entry.mapUrl,
        siteKey,
        mapHash,
        byteSize: content.length,
        content,
        legacy: {
          upgradedFromString: typeof value === "string",
          mapHash: value && typeof value !== "string" ? value._legacyMapHash : null,
          blobId: value && typeof value !== "string" ? value._legacyBlobId : null,
        },
      };

      if (!recoveredRefsByVersion[meta.id]) recoveredRefsByVersion[meta.id] = [];
      recoveredRefsByVersion[meta.id].push(nextRef);
    }

    metas.slice().sort(compareMetaByTimeline).forEach((meta) => {
      originalMetaById[meta.id] = meta;
      const refs = recoveredRefsByVersion[meta.id] || [];
      if (refs.length === 0) {
        invalidVersionMap[meta.id] = {
          id: meta.id,
          pageUrl: canonicalPageUrl(meta.pageUrl),
          reason: "all_maps_missing",
          mapCount: meta.mapUrls ? meta.mapUrls.length : 0,
        };
        return;
      }

      const normalizedPageUrl = canonicalPageUrl(meta.pageUrl || "");
      const normalizedSiteKey = meta.siteKey || pageSiteKey(normalizedPageUrl);
      const nextMeta = rebuildVersionMetaFromRefs(
        Object.assign({}, meta, {
          pageUrl: normalizedPageUrl,
          siteKey: normalizedSiteKey,
        }),
        refs,
        normalizedSiteKey,
      );
      const pageIds = desiredIdsByPage[normalizedPageUrl] || [];
      const matchedId = findBestCompactionMatch(desiredVersionMap, pageIds, nextMeta.signature);
      if (matchedId) {
        desiredVersionMap[matchedId] = mergeCompactedMeta(desiredVersionMap[matchedId], nextMeta);
        return;
      }

      desiredVersionMap[meta.id] = nextMeta;
      desiredRefsByVersion[meta.id] = refs.slice().sort((a, b) => a.mapUrl.localeCompare(b.mapUrl));
      if (!desiredIdsByPage[normalizedPageUrl]) desiredIdsByPage[normalizedPageUrl] = [];
      desiredIdsByPage[normalizedPageUrl].push(meta.id);
    });

    Object.keys(desiredVersionMap).forEach((id) => {
      const meta = desiredVersionMap[id];
      const refs = desiredRefsByVersion[id] || [];
      const finalizedRefs = [];

      refs.forEach((ref) => {
        let blobId = blobStoreKey(meta.siteKey, ref.mapHash);
        blobId = uniqueBlobId(desiredBlobs, blobId, ref.content);

        const storedRef = {
          versionId: id,
          mapUrl: ref.mapUrl,
          siteKey: meta.siteKey,
          mapHash: ref.mapHash,
          blobId,
          byteSize: ref.byteSize,
        };
        desiredRefs.push({
          key: mapStoreKey(id, ref.mapUrl),
          value: storedRef,
        });
        finalizedRefs.push(storedRef);

        if (!desiredBlobs[blobId]) {
          desiredBlobs[blobId] = {
            id: blobId,
            siteKey: meta.siteKey,
            mapHash: ref.mapHash,
            byteSize: ref.byteSize,
            content: ref.content,
            createdAt: (existingBlobMap[blobId] && existingBlobMap[blobId].createdAt) || meta.createdAt || meta.lastSeenAt || new Date().toISOString(),
            refCount: 0,
          };
        }
        desiredBlobs[blobId].refCount++;

        if (
          ref.legacy?.upgradedFromString
          || ref.legacy?.mapHash !== storedRef.mapHash
          || ref.legacy?.blobId !== storedRef.blobId
        ) {
          upgradedRefs++;
        }
      });

      const finalizedMeta = rebuildVersionMetaFromRefs(meta, finalizedRefs, meta.siteKey || pageSiteKey(meta.pageUrl));
      desiredRefsByVersion[id] = finalizedRefs;
      desiredVersionMap[id] = finalizedMeta;
    });

    const desiredBlobArray = await Promise.all(Object.keys(desiredBlobs).map(async (blobId) => {
      return prepareBlobRecordForStorage(desiredBlobs[blobId]);
    }));
    const desiredBlobLookup = {};
    desiredBlobArray.forEach((blob) => {
      desiredBlobLookup[blob.id] = blob;
    });
    const desiredMetas = Object.keys(desiredVersionMap).map((id) => {
      return withStoredByteSize(desiredVersionMap[id], desiredRefsByVersion[id] || [], desiredBlobLookup);
    });
    const upgradedVersions = desiredMetas.reduce((count, meta) => {
      return count + (hasVersionMetaChanged(originalMetaById[meta.id], meta) ? 1 : 0);
    }, 0);

    return {
      desiredMetas,
      desiredRefs,
      desiredBlobs: desiredBlobArray,
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
  console.info("[SourceD] compactStorageData starting");
  return ensureStorageReady().then((db) => listAllVersionsRaw(db).then((metas) => {
    const beforeVersionCount = metas.length;
    const beforeMapCount = Object.keys(state.blobIndex).length;
    const beforeBytes = totalStoredBlobBytes();

    return buildCompactedStorageState(db, metas).then((storageState) => {
      const desiredIdMap = {};
      storageState.desiredMetas.forEach((meta) => {
        desiredIdMap[meta.id] = true;
      });

      return new Promise((resolve, reject) => {
        const tx = db.transaction([VERSION_STORE, MAP_STORE, BLOB_STORE], "readwrite");
        const versionStore = tx.objectStore(VERSION_STORE);
        const mapStore = tx.objectStore(MAP_STORE);
        const blobStore = tx.objectStore(BLOB_STORE);

        mapStore.clear();
        blobStore.clear();

        metas.forEach((meta) => {
          if (!desiredIdMap[meta.id]) versionStore.delete(meta.id);
        });

        storageState.desiredMetas.forEach((meta) => {
          versionStore.put(meta);
        });

        storageState.desiredRefs.forEach((entry) => {
          mapStore.put(entry.value, entry.key);
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
    }).then((storageState) => Promise.all([
      listAllVersionsRaw(db),
      listAllBlobsRaw(db),
      loadStoredMapEntriesRaw(db, storageState.desiredMetas),
    ]).then((results) => {
      const versions = results[0] || [];
      const blobs = results[1] || [];
      const entries = results[2] || [];
      const blobSiteIndex = {};
      entries.forEach((entry) => {
        const siteKey = entry.meta?.siteKey || pageSiteKey(entry.meta?.pageUrl);
        if (!siteKey || typeof entry.value === "string") return;
        if (entry.value?.blobId) blobSiteIndex[entry.value.blobId] = siteKey;
      });
      rebuildIndexes(versions, blobs, blobSiteIndex);
      refreshBadgeForActiveTab();
      const result = {
        invalidVersions: storageState.invalidVersions,
        stats: {
          removedVersions: Math.max(0, beforeVersionCount - versions.length),
          removedMaps: Math.max(0, beforeMapCount - blobs.length),
          reclaimedBytes: Math.max(0, beforeBytes - totalStoredBlobBytes()),
          remainingVersions: versions.length,
          remainingMaps: blobs.length,
          remainingBytes: totalStoredBlobBytes(),
          upgradedRefs: Number(storageState.migration?.upgradedRefs) || 0,
          upgradedVersions: Number(storageState.migration?.upgradedVersions) || 0,
        },
      };
      console.info("[SourceD] compactStorageData finished:", result.stats, result.invalidVersions);
      return result;
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
      console.info(`[SourceD] cleanup step starting: ${stepDef.label}`);
      const result = await stepDef.run();
      const step = {
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
      };
      console.info(`[SourceD] cleanup step finished: ${stepDef.label}`, step);
      steps.push(step);
      cleaned = cleaned.concat(result.cleaned || []);
      stats = mergeCleanupStats(stats, result.stats);
    } catch (err) {
      failedCount++;
      const step = {
        id: stepDef.id,
        label: stepDef.label,
        ok: false,
        changed: false,
        summary: `${stepDef.label} failed: ${cleanupErrorMessage(err)}`,
        error: cleanupErrorMessage(err),
      };
      console.error(`[SourceD] cleanup step failed: ${stepDef.label}`, err);
      steps.push(step);
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
