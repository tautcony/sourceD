const DEFAULT_FETCH_DELAY_MS = 300;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MAP_BYTES = 50 * 1024 * 1024;

export function base64ToUtf8(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function fetchTextWithLimits(url, signal, maxBytes = DEFAULT_MAX_MAP_BYTES) {
  return fetch(url, { signal }).then((resp) => {
    if (!resp.ok) return null;

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
  return function fetchSourceMap(jsUrl, callback) {
    if (state.pendingSourceMapFetches.has(jsUrl)) return;
    state.pendingSourceMapFetches.add(jsUrl);

    const settings = getSettings ? getSettings() : {};
    const fetchDelayMs = settings.fetchDelayMs ?? DEFAULT_FETCH_DELAY_MS;
    const fetchTimeoutMs = settings.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const maxMapBytes = settings.maxMapBytes ?? DEFAULT_MAX_MAP_BYTES;

    setTimeout(() => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, fetchTimeoutMs);

      fetchTextWithLimits(jsUrl, controller.signal, maxMapBytes)
        .then((jsContent) => {
          if (!jsContent) return;
          const match = jsContent.match(/\/\/# sourceMappingURL=([^\s\r\n]+)/);
          if (!match) return;
          const mapRef = match[1];

          if (mapRef.startsWith("data:application/json")) {
            const b64 = mapRef.split(",")[1];
            try {
              callback(`${jsUrl}.map`, base64ToUtf8(b64));
            } catch (e) {
              console.warn("[SourceD] inline map decode error:", e);
            }
            return;
          }

          const mapUrl = resolveSourceMapUrl(jsUrl, mapRef);
          return fetchTextWithLimits(mapUrl, controller.signal, maxMapBytes)
            .then((text) => {
              if (text) callback(mapUrl, text);
            })
            .catch((e) => {
              console.warn("[SourceD] map fetch error:", e);
            });
        })
        .catch((e) => {
          console.warn("[SourceD] js fetch error:", e);
        })
        .finally(() => {
          clearTimeout(timeoutId);
          state.pendingSourceMapFetches.delete(jsUrl);
        });
    }, fetchDelayMs);
  };
}
