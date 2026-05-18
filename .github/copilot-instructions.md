# SourceD repository instructions

Trust this file first for repository context, file locations, and validation workflow. Only search the codebase when these instructions are incomplete or obviously stale.

## What this repository is

SourceD is a Manifest V3 browser extension for Chromium-based browsers. It detects JavaScript source maps seen during page visits, keeps versions of maps with embedded `sourcesContent`, and lets users inspect or download recovered source files.

## Stack and runtime

- JavaScript / JSX / MJS only; no TypeScript source in this repo.
- UI uses React 19 and Ant Design 6.
- Extension runtime targets Chromium; `manifest.json` declares the MV3 service worker, popup, options page, and dashboard.
- Bundling is done with `esbuild` via `scripts/build-dist.mjs`.
- Tests use Vitest; browser UI tests use Playwright Chromium.
- CI uses Node **24** (`.github/workflows/ci.yml`). Prefer Node 24 locally to match CI behavior.

## Where to make changes

- `manifest.json`: extension wiring and permissions.
- `src/background/`
  - `index.js` boots the background runtime.
  - `runtime.mjs`, `runtime-handlers.mjs`: browser/runtime message integration.
  - `sessions.mjs`: groups discovered maps into page sessions and versions.
  - `storage.mjs`, `db.mjs`, `shared.mjs`, `compression.mjs`: IndexedDB persistence, deduplication, cleanup, and storage helpers.
- `src/popup/`
  - `App.jsx`: popup UI.
  - `sourcemap.mjs`: source-map parsing, source extraction, ZIP download helpers.
- `src/dashboard/`
  - `App.jsx`: dashboard shell and high-level interactions.
  - `VersionPanel.jsx`: version tree, preview drawer, download flow.
  - `CodePreview.jsx`: code preview renderer for recovered source files.
- `src/options/`: options/about UI.
- `src/shared/`: reusable utilities (`utils.mjs`, `runtime-utils.js`, `tree-utils.jsx`).
- `docs/architecture.md`: the best high-level explanation of data flow and IndexedDB schema. Read this before changing persistence logic.
- `_locales/`: extension strings. Update locale files when changing user-facing copy.
- `tests/`
  - `*.test.js`: node/jsdom-oriented logic tests.
  - `*.test.jsx`: browser UI tests.
  - `__screenshots__/`: screenshot baselines for browser tests.

## Build artifacts and files to avoid editing directly

Do not hand-edit generated output under `bundles/`, `dist/`, `coverage/`, or `releases/`. Make source changes in `src/`, `scripts/`, `manifest.json`, tests, or locale files, then regenerate artifacts with the existing scripts if needed.

## Validation workflow

Use this command order unless the task is documentation-only:

1. `npm install` (or `npm ci` in a clean CI-style environment)
2. `npm run check:manifest`
3. `npm run lint`
4. `npm test`
5. `npm run build`
6. `npm run package` when a release artifact is relevant

Additional commands:

- `npm run build:debug`: produces a development-friendly unpacked build with sourcemaps.
- `npm run test:coverage`: CI-style coverage run.
- `npm run test:browser`: browser-only UI tests.
- `npm run clean`: removes `dist/` and `releases/`.

## CI and test expectations

- CI runs, in order: `npm ci`, `npx playwright install --with-deps chromium`, `npm run lint`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run package`.
- Browser tests require Playwright Chromium. If UI tests fail on a clean machine because the browser is missing, run `npx playwright install --with-deps chromium`.
- When changing popup/dashboard UI, expect browser tests and screenshot baselines under `tests/__screenshots__/` to be relevant.

## Architecture notes that save search time

- The background service worker is the source of truth for discovery, deduplication, cleanup, import/export, and dashboard/popup data loading.
- Popup and dashboard talk to the background via `chrome.runtime.sendMessage`; many UI changes require corresponding handler updates in background modules.
- The dashboard preview experience is composed from `src/dashboard/App.jsx` → `VersionPanel.jsx` → `CodePreview.jsx`.
- Source map recovery and ZIP export logic is shared from `src/popup/sourcemap.mjs`; reuse it instead of duplicating parsing or archive logic in UI components.
- Storage is normalized around versions, version-to-map references, and deduplicated map blobs. `docs/architecture.md` documents the model and should be treated as the reference when touching storage behavior.

## Change guidelines for this repo

- Preserve the current split between background logic, shared helpers, and React UI surfaces.
- Prefer extending existing helpers in `src/shared/` or `src/popup/sourcemap.mjs` over duplicating logic.
- Keep React changes aligned with existing function-component and hook-based patterns.
- Keep user-visible wording localized through `_locales/` instead of hardcoding new copy in only one place.
- If a change affects extension permissions, manifest wiring, storage shape, or message contracts, inspect all dependent surfaces before finishing.
