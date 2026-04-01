import { hostnameFromUrl, isHostnameFiltered, normalizeDomainFilterList } from "../shared/utils.mjs";

export const DB_NAME = "sourced";
export const DB_VERSION = 4;
export const VERSION_STORE = "pageVersions";
export const MAP_STORE = "versionMaps";
export const BLOB_STORE = "mapBlobs";
export const LEGACY_DATA_STORES = ["sourceMaps"];
export const SETTINGS_KEY = "settings";

export const DEFAULT_SETTINGS = {
  retentionDays: 30,
  maxVersionsPerPage: 10,
  autoCleanup: true,
  detectionEnabled: true,
  ignoredDomains: [],
  fetchDelayMs: 300,
  fetchTimeoutMs: 30_000,
  maxMapBytes: 50 * 1024 * 1024,
};

export const state = {
  popupPorts: [],
  dbPromise: null,
  storageReadyPromise: null,
  tabSessions: {},
  versionIndex: {},
  versionsByPage: {},
  blobIndex: {},
  settings: null,
  pendingSourceMapFetches: new Map(),
  storageCompactionInProgress: false,
  lastDbMaintenance: null,
};

export function setBadgeText(num, tabId) {
  const payload = { text: num > 0 ? String(num) : "" };
  if (tabId != null) payload.tabId = tabId;

  try {
    const maybePromise = chrome.action.setBadgeText(payload);
    if (maybePromise && typeof maybePromise.catch === "function") {
      /* v8 ignore next -- browser badge updates can race with tab teardown */
      maybePromise.catch(() => {
        // Ignore races where the tab no longer exists by the time badge state updates.
      });
    }
  /* v8 ignore next -- browser badge updates can throw during tab teardown */
  } catch {
    // Ignore races where the tab no longer exists by the time badge state updates.
  }
}

export function canonicalPageUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url || "";
  }
}

export function pageSiteKey(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return url || "";
  }
}

export function normalizeSettings(input) {
  const merged = Object.assign({}, DEFAULT_SETTINGS, input || {});
  merged.ignoredDomains = normalizeDomainFilterList(merged.ignoredDomains);
  return merged;
}

export function shouldIgnoreAnalysisForUrl(url, ignoredDomains) {
  return isHostnameFiltered(hostnameFromUrl(url), ignoredDomains);
}

export async function hashString(input) {
  const encoded = new TextEncoder().encode(input);
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function blobStoreKey(siteKey, mapHash) {
  return `${siteKey}::${mapHash}`;
}

export function mapStoreKey(versionId, mapUrl) {
  return `${versionId}::${mapUrl}`;
}

export function buildSignatureFromRefs(refs) {
  return refs
    .slice()
    .sort((a, b) => a.mapUrl.localeCompare(b.mapUrl))
    .map((ref) => `${ref.mapUrl}#${ref.mapHash}`)
    .join("|");
}

export function versionLabel(meta, index, total) {
  const stamp = new Date(meta.createdAt || meta.lastSeenAt).toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `v${total - index} · ${stamp}`;
}

export function ensurePageBucket(pageUrl) {
  if (!state.versionsByPage[pageUrl]) state.versionsByPage[pageUrl] = [];
  return state.versionsByPage[pageUrl];
}

export function sortPageVersions(pageUrl) {
  ensurePageBucket(pageUrl).sort((a, b) => {
    const av = state.versionIndex[a];
    const bv = state.versionIndex[b];
    return new Date(bv.createdAt || bv.lastSeenAt).getTime() - new Date(av.createdAt || av.lastSeenAt).getTime();
  });
}

export function toBlobMeta(record) {
  if (!record) return null;
  return {
    id: record.id,
    siteKey: record.siteKey,
    mapHash: record.mapHash,
    byteSize: record.byteSize || 0,
    createdAt: record.createdAt,
    refCount: record.refCount || 0,
  };
}

export function rebuildIndexes(versions, blobs) {
  state.versionIndex = {};
  state.versionsByPage = {};
  state.blobIndex = {};

  versions.forEach((meta) => {
    state.versionIndex[meta.id] = meta;
    ensurePageBucket(meta.pageUrl).push(meta.id);
  });

  Object.keys(state.versionsByPage).forEach(sortPageVersions);

  (blobs || []).forEach((blob) => {
    state.blobIndex[blob.id] = toBlobMeta(blob);
  });
}

export function latestVersionForPage(pageUrl) {
  const ids = state.versionsByPage[pageUrl] || [];
  return ids.length ? state.versionIndex[ids[0]] : null;
}

export function pageMapCount(pageUrl) {
  const latest = latestVersionForPage(pageUrl);
  return latest ? latest.mapCount || 0 : 0;
}

export function sessionMapCount(tabId) {
  const session = state.tabSessions[tabId];
  if (session) return Object.keys(session.maps || {}).length;
  return 0;
}

export function refreshBadgeForTab(tabId, fallbackUrl) {
  if (tabId == null || tabId < 0) return;

  const count = sessionMapCount(tabId);
  if (count > 0) {
    setBadgeText(count, tabId);
    return;
  }

  if (fallbackUrl) {
    setBadgeText(pageMapCount(canonicalPageUrl(fallbackUrl)), tabId);
    return;
  }

  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url) {
      setBadgeText(0, tabId);
      return;
    }
    setBadgeText(pageMapCount(canonicalPageUrl(tab.url)), tabId);
  });
}

export function refreshBadgeForActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab) {
      setBadgeText(0);
      return;
    }
    refreshBadgeForTab(tab.id, tab.url);
  });
}
