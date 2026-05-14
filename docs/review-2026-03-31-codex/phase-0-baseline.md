# Phase 0 Baseline

## Scope
- Review target: entire repository
- Review date: 2026-03-31
- Output focus: confirmed defects, reliability risks, behavioral regressions, and testing gaps

## Repository Baseline
- Stack: Manifest V3 Chromium extension, background service worker, React 19 + Ant Design UI, IndexedDB persistence, Vitest test suite
- Key entry points:
  - `src/background/runtime.mjs`
  - `src/background/sessions.mjs`
  - `src/background/storage.mjs`
  - `src/popup/App.jsx`
  - `src/dashboard/App.jsx`
  - `src/options/App.jsx`
- Storage model:
  - `pageVersions` for version metadata
  - `versionMaps` for map refs
  - `mapBlobs` for deduplicated content blobs
- Tests:
  - `npm test` passes: 5 files, 183 tests
  - Coverage is broad on UI helpers and happy paths, but there is little failure-path coverage for background persistence and service worker startup races

## Phase Mapping
- Phase 1: runtime / boundary / browser event handling
- Phase 2: session lifecycle + storage orchestration
- Phase 3: popup / dashboard / options UI and test coverage
- Phase 4: cross-cutting consistency review

## High-Risk Areas
- Async message handlers in the service worker that must always reply
- State synchronization between in-memory indexes and IndexedDB
- Retention / cleanup logic driven by `lastSeenAt`
- Startup ordering between listener registration and persisted settings load

## Existing Context
- No prior review artifacts were found under `docs/`
- Worktree is otherwise clean except for the untracked `.agents/` skill files
