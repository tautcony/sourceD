export function runtimeMessageError() {
  const err = chrome.runtime?.lastError;
  if (!err) return null;
  return err instanceof Error ? err : new Error(err.message || String(err));
}
