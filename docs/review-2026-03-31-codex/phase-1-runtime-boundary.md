# Phase 1 Runtime / Boundary Layer

## Coverage
- Reviewed:
  - `src/background/runtime.mjs`
  - `src/background/index.js`
  - `src/background/shared.mjs`
- Checked:
  - browser event listeners
  - message/port response behavior
  - startup ordering
  - badge refresh fallbacks

## Findings

### High: mutation message handlers can leave popup/dashboard requests hanging forever on storage failures
- Location:
  - `src/background/runtime.mjs:190`
  - `src/background/runtime.mjs:207`
  - `src/background/runtime.mjs:217`
  - `src/background/runtime.mjs:226`
- Trigger:
  - Any rejection from `saveSettings`, `prunePageHistory`, `deleteVersions`, `deletePageHistoryAndSessions`, or `deleteSiteHistoryAndSessions`
- Impact:
  - These branches return `true` to keep the message channel open, but never attach a `.catch(...)` that calls `sendResponse`.
  - If IndexedDB rejects or a transaction aborts, the popup/dashboard caller waits indefinitely and keeps stale loading UI or stale state.
- Repair direction:
  - Add explicit rejection handling for every async message branch and always respond with `{ ok: false, error }`.
  - Add tests that force storage helpers to reject and assert that callers receive a failure response.

### Medium: detection-disabled setting is not honored during service worker startup
- Location:
  - `src/background/runtime.mjs:68`
  - `src/background/runtime.mjs:301`
  - `src/background/shared.mjs:8`
  - `src/background/shared.mjs:23`
- Trigger:
  - User has persisted `detectionEnabled: false`, then the MV3 service worker cold-starts and receives web requests before `loadSettings()` resolves.
- Impact:
  - `currentSettings()` falls back to `DEFAULT_SETTINGS`, which enables detection.
  - The extension can inspect and cache maps during the startup window even though the user explicitly disabled collection.
- Repair direction:
  - Load settings before registering listeners, or gate request handling on a resolved initialization promise.
  - Add a startup test that simulates persisted disabled settings and verifies that no detection work starts before settings load completes.

## No Additional Findings
- Badge refresh fallbacks handle tab races defensively.
- Read-only request handlers (`getPopupState`, `getVersionFiles`, `cleanupData`, `importSourceMaps`) already return explicit error responses on rejection.
