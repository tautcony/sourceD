# SourceD

SourceD is a Manifest V3 browser extension that detects JavaScript source maps referenced by visited pages, caches maps that contain `sourcesContent`, and lets you download the recovered source files as ZIP archives.

This repository is currently structured as a lightweight unpacked extension for Chromium-based browsers such as Chrome and Edge.

## Features

- Detects `sourceMappingURL` from loaded JavaScript files
- Supports both external `.map` files and inline base64 source maps
- Filters out common bundler/runtime virtual modules
- Recovers original sources from `sourcesContent`
- Downloads a single source map or all maps for a page as ZIP files
- Persists discovered maps locally so popup state survives service worker restarts

## Install

1. Run `npm install`
2. Run `npm run build:vendor` if you need to rebuild browser vendor assets manually
3. Open `chrome://extensions` or `edge://extensions`
4. Enable `Developer mode`
5. Click `Load unpacked`
6. Select this repository root

## Build And Package

- `npm run build:vendor`: refresh vendor runtime files under `vendor/`
- `npm run build`: create a clean unpacked release under `dist/`
- `npm run package`: build `dist/` and create a zip under `releases/`
- `npm run clean`: remove generated `dist/` and `releases/`

## Usage

1. Visit a website that ships JavaScript with source maps
2. Wait for the extension badge to show detected items
3. Open the extension popup
4. Download one recovered source archive, or download all archives for the current page

If a site exposes source map URLs but omits `sourcesContent`, SourceD will not show it as downloadable because there is no embedded source content to reconstruct.

## Permissions

- `webRequest`: observe script requests so the extension can inspect matching JavaScript files
- `downloads`: save recovered ZIP archives
- `tabs`: associate detected maps with the active page
- `storage`: persist map metadata and content locally
- `host_permissions: <all_urls>`: required because source maps may be hosted on any origin

## Privacy

- All processing happens locally in the browser
- Detected source maps are stored in extension storage on the local machine
- The extension does not send collected data to any remote service

## Legal And Responsible Use

Use this project only for debugging, security research, incident response, or other activities you are authorized to perform. Recovering source code from third-party deployments can have legal and contractual implications. You are responsible for complying with applicable law, license terms, and site policies.

## Development

The repo uses npm for dependency management. Runtime browser assets are generated into `vendor/`, and release builds are assembled into `dist/`.

Project layout:

- `manifest.json`: extension manifest
- `src/background/index.js`: source map discovery, persistence, popup messaging
- `scripts/build-vendor.mjs`: generate browser vendor assets
- `scripts/build-dist.mjs`: assemble release files into `dist/`
- `scripts/package-release.mjs`: zip `dist/` into `releases/`
- `src/popup/*`: popup UI and download logic
- `src/dashboard/index.js`: history dashboard UI and interactions
- `src/options/index.js`: options/about page logic
- `src/shared/utils.js`: shared UI and formatting helpers
- `options.html`: about, permissions, and privacy page
- `styles/main.css`: popup and options page styles
- `vendor/`: generated browser runtime assets
- `_locales/en/messages.json`: extension name and description

## Third-Party Dependencies

Runtime browser-side dependencies currently used by this repo:

- `jszip` (`MIT OR GPL-3.0-or-later`)
- `source-map-js` (`BSD-3-Clause`)
- `tiny-react` (`MIT`)
- `lodash` (`MIT`)

See [NOTICE.md](NOTICE.md) and the license files under `node_modules/` after `npm install` for details.

## Release Checklist

- Review requested permissions and remove anything unused
- Replace development loading instructions with packaged release steps if publishing to a store
- Add screenshots and store listing copy if distributing publicly
- Verify third-party dependency licenses are acceptable for your release channel
- Bump `manifest.json` version before tagging a release

## License

This repository is licensed under the GNU General Public License v3 or later. See [LICENSE](LICENSE).
