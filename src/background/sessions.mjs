import {
  buildSignatureFromRefs,
  canonicalPageUrl,
  ensurePageBucket,
  pageSiteKey,
  refreshBadgeForTab,
  setBadgeText,
  sortPageVersions,
  state,
  blobStoreKey,
  hashString,
} from "./shared.mjs";
import {
  broadcastSummary,
  currentSettings,
  persistVersionState,
  prunePageHistory,
} from "./storage.mjs";

export function buildSessionArtifacts(session) {
  const siteKey = pageSiteKey(session.pageUrl);
  const mapUrls = Object.keys(session.maps).sort();
  const refs = [];
  const blobs = {};
  let byteSize = 0;
  const createdAt = new Date().toISOString();

  mapUrls.forEach((mapUrl) => {
    const content = session.maps[mapUrl];
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
        createdAt,
        refCount: 0,
      };
    }
  });

  return {
    siteKey,
    mapUrls,
    byteSize,
    refs,
    blobs,
    signature: buildSignatureFromRefs(refs),
  };
}

export function buildMetaForSession(session, artifacts, versionId) {
  const now = new Date().toISOString();
  const existing = state.versionIndex[versionId];

  return {
    id: versionId,
    pageUrl: session.pageUrl,
    siteKey: artifacts.siteKey,
    title: session.title,
    createdAt: existing ? existing.createdAt : now,
    lastSeenAt: now,
    signature: artifacts.signature,
    mapUrls: artifacts.mapUrls,
    mapCount: artifacts.mapUrls.length,
    fileCount: artifacts.mapUrls.length,
    byteSize: artifacts.byteSize,
    tabId: session.tabId,
  };
}

export function upsertSessionVersion(session) {
  const artifacts = buildSessionArtifacts(session);
  if (!artifacts.signature) return Promise.resolve();

  if (session.versionId && session.versionOwned && session.signature === artifacts.signature) {
    const stableMeta = state.versionIndex[session.versionId];
    if (stableMeta) {
      refreshBadgeForTab(session.tabId, session.pageUrl);
      return Promise.resolve();
    }
  }

  if (session.versionId && session.versionOwned) {
    const previousMeta = state.versionIndex[session.versionId];
    const updatedMeta = buildMetaForSession(session, artifacts, session.versionId);
    return persistVersionState(updatedMeta, artifacts.refs, artifacts.blobs, previousMeta)
      .then(() => sortPageVersions(session.pageUrl))
      .then(() => {
        if (currentSettings().autoCleanup) return prunePageHistory(session.pageUrl);
        return null;
      })
      .then(() => {
        session.signature = artifacts.signature;
        refreshBadgeForTab(session.tabId, session.pageUrl);
        broadcastSummary();
      });
  }

  const matchingId = ensurePageBucket(session.pageUrl).find((id) => {
    return state.versionIndex[id] && state.versionIndex[id].signature === artifacts.signature;
  });

  if (matchingId) {
    const previousMeta = state.versionIndex[matchingId];
    const nextMeta = Object.assign({}, previousMeta, {
      title: session.title,
      lastSeenAt: new Date().toISOString(),
      tabId: session.tabId,
    });

    return persistVersionState(nextMeta, artifacts.refs, artifacts.blobs, previousMeta)
      .then(() => sortPageVersions(session.pageUrl))
      .then(() => {
        session.versionId = matchingId;
        session.versionOwned = false;
        session.signature = artifacts.signature;
        refreshBadgeForTab(session.tabId, session.pageUrl);
        broadcastSummary();
      });
  }

  const newId = `${session.pageUrl}::${Date.now()}::${Math.random().toString(36).slice(2, 8)}`;
  const meta = buildMetaForSession(session, artifacts, newId);

  return persistVersionState(meta, artifacts.refs, artifacts.blobs, null)
    .then(() => {
      if (currentSettings().autoCleanup) return prunePageHistory(session.pageUrl);
      return null;
    })
    .then(() => {
      session.versionId = newId;
      session.versionOwned = true;
      session.signature = artifacts.signature;
      ensurePageBucket(session.pageUrl).unshift(newId);
      state.versionIndex[newId] = meta;
      sortPageVersions(session.pageUrl);
      refreshBadgeForTab(session.tabId, session.pageUrl);
      broadcastSummary();
    });
}

export function scheduleSessionPersist(session) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    upsertSessionVersion(session).catch((err) => {
      console.warn("[SourceD] version save failed:", err && err.message ? err.message : err);
    });
  }, 1400);
}

export function getOrCreateSession(tab) {
  const pageUrl = canonicalPageUrl(tab.url || "");
  let session = state.tabSessions[tab.id];
  if (!session || session.pageUrl !== pageUrl) {
    session = {
      tabId: tab.id,
      pageUrl,
      title: tab.title || pageUrl,
      maps: {},
      versionId: null,
      versionOwned: false,
      signature: null,
      timer: null,
    };
    state.tabSessions[tab.id] = session;
  }
  session.title = tab.title || session.title;
  refreshBadgeForTab(tab.id, pageUrl);
  return session;
}

export function cleanupTabSession(tabId) {
  const session = state.tabSessions[tabId];
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  setBadgeText(0, tabId);
  delete state.tabSessions[tabId];
}

export function fetchSourceMap(jsUrl, callback) {
  setTimeout(() => {
    fetch(jsUrl)
      .then((resp) => (resp.ok ? resp.text() : null))
      .then((jsContent) => {
        if (!jsContent) return;
        const match = jsContent.match(/\/\/# sourceMappingURL=([^\s\r\n]+)/);
        if (!match) return;
        const mapRef = match[1];

        if (mapRef.startsWith("data:application/json")) {
          const b64 = mapRef.split(",")[1];
          try {
            callback(`${jsUrl}.map`, atob(b64));
          } catch (e) {
            console.warn("[SourceD] inline map decode error:", e);
          }
          return;
        }

        const mapUrl = /^https?:/.test(mapRef) ? mapRef : new URL(mapRef, jsUrl).href;
        fetch(mapUrl)
          .then((resp) => (resp.ok ? resp.text() : null))
          .then((text) => {
            if (text) callback(mapUrl, text);
          })
          .catch((e) => {
            console.warn("[SourceD] map fetch error:", e);
          });
      })
      .catch((e) => {
        console.warn("[SourceD] js fetch error:", e);
      });
  }, 300);
}

export function isValidSourceMap(raw) {
  try {
    const data = JSON.parse(raw.replace(/^\)\]\}'/, ""));
    return (
      data.version === 3 &&
      Array.isArray(data.sources) && data.sources.length > 0 &&
      Array.isArray(data.sourcesContent) &&
      data.sourcesContent.some((content) => content != null && content !== "")
    );
  } catch {
    return false;
  }
}
