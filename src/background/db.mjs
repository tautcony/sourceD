import {
  BLOB_STORE,
  DB_NAME,
  DB_VERSION,
  LEGACY_DATA_STORES,
  MAP_STORE,
  VERSION_STORE,
  blobStoreKey,
  hashString,
  mapStoreKey,
  pageSiteKey,
  rebuildIndexes,
  refreshBadgeForActiveTab,
  state,
} from "./shared.mjs";

export function getDb() {
  if (state.dbPromise) return state.dbPromise;
  state.dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const removedStores = [];
      if (!db.objectStoreNames.contains(VERSION_STORE)) {
        db.createObjectStore(VERSION_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MAP_STORE)) {
        db.createObjectStore(MAP_STORE);
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE, { keyPath: "id" });
      }
      LEGACY_DATA_STORES.forEach((storeName) => {
        if (!db.objectStoreNames.contains(storeName)) return;
        db.deleteObjectStore(storeName);
        removedStores.push(storeName);
      });
      state.lastDbMaintenance = {
        fromVersion: req.transaction?.db?.version || null,
        toVersion: DB_VERSION,
        removedStores,
      };
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      state.dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      state.dbPromise = null;
      reject(new Error("indexedDB open blocked"));
    };
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
      req.onsuccess = async () => {
        const value = req.result;
        if (typeof value === "string") {
          const mapHash = await hashString(value);
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

export function summarizeLegacyDataStores(db) {
  const lingeringStores = LEGACY_DATA_STORES.filter((storeName) => db.objectStoreNames.contains(storeName));
  const removedStores = state.lastDbMaintenance?.removedStores || [];
  if (state.lastDbMaintenance) {
    state.lastDbMaintenance = Object.assign({}, state.lastDbMaintenance, {
      removedStores: [],
    });
  }
  return {
    checkedStores: LEGACY_DATA_STORES.slice(),
    removedStores: removedStores.slice(),
    lingeringStores,
  };
}
