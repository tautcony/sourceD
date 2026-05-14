# Fixes Plan

## Batch 1: unblock correctness on user-facing commands
- Scope:
  - `src/background/runtime.mjs`
- Changes:
  - Wrap every async mutation handler in success and failure branches that always call `sendResponse`.
  - Standardize the response shape to `{ ok, error? }`.
- Verification:
  - Add tests that force each storage helper to reject and assert the popup/dashboard receives `{ ok: false }`.

## Batch 2: preserve active history correctly
- Scope:
  - `src/background/sessions.mjs`
  - `src/background/storage.mjs`
- Changes:
  - When an existing signature is matched, update `lastSeenAt` and reorder that page’s version list.
  - Confirm retention and “latest version” labeling use the refreshed timestamps as intended.
- Verification:
  - Add a unit/integration test that revisits the same signature after simulated time passes and confirms it is not pruned.

## Batch 3: make startup honor persisted settings
- Scope:
  - `src/background/runtime.mjs`
  - possibly `src/background/storage.mjs`
- Changes:
  - Load settings before listener registration, or gate request processing on a resolved initialization barrier.
  - Ensure `currentSettings()` is not consulted for detection decisions until storage-backed settings are ready.
- Verification:
  - Test cold start with persisted `detectionEnabled: false` and confirm no capture begins before initialization finishes.

## Batch 4: make version creation atomic
- Scope:
  - `src/background/sessions.mjs`
  - `src/background/storage.mjs`
- Changes:
  - Delay `state.versionIndex` / `state.versionsByPage` mutation until after IndexedDB commit succeeds.
  - Add rollback if post-persist cleanup fails after optimistic publication.
- Verification:
  - Inject rejected `persistVersionState()` calls and assert no ghost version remains in summaries or indexes.

## Batch 5: define compaction salvage semantics
- Scope:
  - `src/background/storage.mjs`
- Changes:
  - Either salvage valid refs from partially damaged versions or intentionally delete the whole version with an accurate reason.
  - Align cleanup statistics with the chosen behavior.
- Verification:
  - Add tests for one-missing-map and all-maps-missing cases.
