import {
  BLOB_STORE,
  MAP_STORE,
  VERSION_STORE,
  blobStoreKey,
  mapStoreKey,
  pageSiteKey,
  canonicalPageUrl,
  rebuildIndexes,
  refreshBadgeForActiveTab,
  state,
  buildSignatureFromRefs,
  hashString,
} from "../shared.mjs";
import {
  ensureStorageReady,
  getDb,
  listAllVersionsRaw,
  listAllBlobsRaw,
  loadStoredMapEntriesRaw,
  summarizeLegacyDataStores,
} from "./db.mjs";
import { decodeBlobContent } from "./compression.mjs";
import {
  prepareBlobRecordForStorage,
  storedBlobBytes,
  uniqueBlobId,
  withStoredByteSize,
} from "./utils.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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

function totalStoredBlobBytes() {
  return Object.keys(state.blobIndex).reduce((sum, id) => sum + storedBlobBytes(state.blobIndex[id]), 0);
}

// ---------------------------------------------------------------------------
// Exported compaction / cleanup functions
// ---------------------------------------------------------------------------

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
