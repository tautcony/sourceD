const DEFAULT_FETCH_DELAY_MS = 300;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MAP_BYTES = 50 * 1024 * 1024;
const DEFAULT_FETCH_CONCURRENCY = 6;

export function base64ToUtf8(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function fetchTextWithLimits(url, signal, maxBytes = DEFAULT_MAX_MAP_BYTES) {
  return fetch(url, { signal }).then((resp) => {
    if (!resp.ok) return { httpError: resp.status };

    const declaredLength = Number(resp.headers?.get?.("content-length") || 0);
    if (declaredLength > maxBytes) {
      throw new Error(`response too large for ${url}`);
    }

    return resp.text().then((text) => {
      if (new TextEncoder().encode(text).length > maxBytes) {
        throw new Error(`response too large for ${url}`);
      }
      return text;
    });
  });
}

export function resolveSourceMapUrl(jsUrl, mapRef) {
  return /^https?:/.test(mapRef) ? mapRef : new URL(mapRef, jsUrl).href;
}

export function createSourceMapFetcher(state, getSettings) {
  let activeFetchCount = 0;
  const fetchQueue = [];

  // startFetch reads settings fresh each call so that queue-drained fetches
  // also honour the latest values (not the settings captured when enqueued).
  function startFetch(jsUrl, pending) {
    const s = getSettings ? getSettings() : {};
    const fetchTimeoutMs = s.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const maxMapBytes = s.maxMapBytes ?? DEFAULT_MAX_MAP_BYTES;
    activeFetchCount++;

    const fanOut = (mapUrl, content, httpStatus) => {
      pending.callbacks.forEach((cb) => {
        if (httpStatus !== undefined) {
          cb(mapUrl, content, httpStatus);
        } else {
          cb(mapUrl, content);
        }
      });
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, fetchTimeoutMs);

    fetchTextWithLimits(jsUrl, controller.signal, maxMapBytes)
      .then((jsContent) => {
        if (!jsContent || typeof jsContent !== 'string') return;
        const match = jsContent.match(/\/\/# sourceMappingURL=([^\s\r\n]+)/);
        if (!match) return;
        const mapRef = match[1];

        if (mapRef.startsWith("data:application/json")) {
          const b64 = mapRef.split(",")[1];
          try {
            fanOut(`${jsUrl}.map`, base64ToUtf8(b64));
          } catch (e) {
            console.warn("[SourceD] inline map decode error:", e);
            fanOut(`${jsUrl}.map`, null);
          }
          return;
        }

        const mapUrl = resolveSourceMapUrl(jsUrl, mapRef);
        return fetchTextWithLimits(mapUrl, controller.signal, maxMapBytes)
          .then((result) => {
            if (result !== null && typeof result === 'object' && 'httpError' in result) {
              fanOut(mapUrl, null, result.httpError);
            } else {
              fanOut(mapUrl, result || null);
            }
          })
          .catch((e) => {
            console.warn("[SourceD] map fetch error:", e);
            fanOut(mapUrl, null);
          });
      })
      .catch((e) => {
        console.warn(`[SourceD] js fetch '${jsUrl}' error:`, e);
      })
      .finally(() => {
        clearTimeout(timeoutId);
        state.pendingSourceMapFetches.delete(jsUrl);
        activeFetchCount--;
        if (fetchQueue.length > 0) {
          const next = fetchQueue.shift();
          startFetch(next.jsUrl, next.pending);
        }
      });
  }

  return function fetchSourceMap(jsUrl, callback) {
    const existing = state.pendingSourceMapFetches.get(jsUrl);
    if (existing) {
      existing.callbacks.push(callback);
      return;
    }

    const pending = { callbacks: [callback] };
    state.pendingSourceMapFetches.set(jsUrl, pending);

    // fetchDelayMs is read now to determine the setTimeout duration itself.
    // fetchTimeoutMs, maxMapBytes, and fetchConcurrency are read inside the
    // callback so that settings changes during the delay window are applied.
    const fetchDelayMs = (getSettings ? getSettings() : {}).fetchDelayMs ?? DEFAULT_FETCH_DELAY_MS;

    setTimeout(() => {
      const s = getSettings ? getSettings() : {};
      const fetchConcurrency = s.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY;
      if (activeFetchCount >= fetchConcurrency) {
        fetchQueue.push({ jsUrl, pending });
        return;
      }
      startFetch(jsUrl, pending);
    }, fetchDelayMs);
  };
}
