import "@testing-library/jest-dom/vitest";
import { createHash } from "node:crypto";

// Patch crypto.subtle.digest to use Node's synchronous createHash so it resolves
// as a microtask instead of via the libuv thread pool. This makes fake-timer
// tests deterministic regardless of system load.
if (globalThis.crypto?.subtle) {
  const _origDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  globalThis.crypto.subtle.digest = (algorithm, data) => {
    const algoName = (typeof algorithm === "string" ? algorithm : algorithm.name).toUpperCase();
    if (algoName === "SHA-256") {
      const view = ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data);
      const result = createHash("sha256").update(view).digest();
      return Promise.resolve(result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength));
    }
    return _origDigest(algorithm, data);
  };
}

// Mock window.matchMedia (required by antd)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Mock ResizeObserver (required by antd)
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

globalThis.URL.createObjectURL = () => "blob:mock-download";
globalThis.URL.revokeObjectURL = () => {};

// Mock getComputedStyle
const origGetComputedStyle = window.getComputedStyle;
window.getComputedStyle = (elt, pseudoElt) => {
  try {
    return origGetComputedStyle(elt, pseudoElt);
  } catch {
    return {};
  }
};

// Mock chrome extension APIs
globalThis.chrome = {
  i18n: {
    getMessage: (key, substitutions) => {
      const messages = {
        commonUnknown: "Unknown",
        popupHeaderTitle: "SourceD",
        popupOpenHistory: "History",
        popupOpenGithub: "Open GitHub repository",
        popupClearButton: "Clear Current Page",
        popupLoading: "Loading current page data...",
        popupEmptyTitle: "No source files detected",
        popupEmptyHint: "Visit a site that exposes source maps and SourceD will detect them automatically",
        popupDownloadAll: "Download all",
        popupStoredVersions: `${substitutions?.[0] ?? ""} versions`,
        popupStorageUsed: `${substitutions?.[0] ?? ""} used`,
        popupLatestVersion: `Latest version: ${substitutions?.[0] ?? ""}`,
        popupDetectionToggle: "Detect",
        popupCurrentDomain: `Current domain: ${substitutions?.[0] ?? ""}`,
        popupAddDomainFilter: "Ignore domain",
        popupRemoveDomainFilter: "Analyze domain",
        dashboardPageTitle: "SourceD History",
        dashboardEyebrow: "Source Map Archive",
        dashboardTitle: "SourceD History",
        dashboardLead: "Browse every tracked page...",
        dashboardRefresh: "Refresh",
        dashboardImportAction: "Import Maps",
        dashboardTotalPages: "Tracked Pages",
        dashboardTotalVersions: "Stored Versions",
        dashboardTotalStorage: "Storage Used",
        dashboardHistoryTitle: "History",
        dashboardHistoryCopy: "Pages are grouped first...",
        dashboardDistributionTitle: "Data Distribution",
        dashboardDistributionCopy: "Storage is summarized by origin...",
        dashboardSettingsTitle: "Settings",
        dashboardSettingsCopy: "History cleanup runs...",
        dashboardSettingRetentionDays: "Retention Days",
        dashboardSettingMaxVersions: "Max Versions Per Page",
        dashboardSettingAutoCleanup: "Automatically prune old history",
        dashboardSettingDetectionEnabled: "Enable source map detection",
        dashboardSettingsGroupAnalysis: "Analysis",
        dashboardSettingsGroupCapture: "Capture Limits",
        dashboardSettingsGroupRetention: "Retention",
        dashboardSettingIgnoredDomains: "Ignored Domains",
        dashboardSettingIgnoredDomainsHelp: "One domain per line. Matching pages will no longer be analyzed.",
        dashboardSettingIgnoredDomainsPlaceholder: "example.com\nstatic.example.com",
        dashboardSettingFetchDelayMs: "Fetch Delay (ms)",
        dashboardSettingFetchTimeoutMs: "Fetch Timeout (ms)",
        dashboardSettingMaxMapBytes: "Max Map Size (bytes)",
        dashboardSaveSettings: "Save Settings",
        dashboardSaved: "Saved",
        dashboardSaveFailed: "Failed to save settings",
        dashboardEmptyHistory: "No history yet.",
        dashboardEmptyDistribution: "No distribution data yet.",
        dashboardDomainSummary: `${substitutions?.[0] ?? ""} pages · ${substitutions?.[1] ?? ""} versions`,
        dashboardLastUpdated: `Updated ${substitutions?.[0] ?? ""}`,
        dashboardVersionFiles: `${substitutions?.[0] ?? ""} files`,
        dashboardDistributionVersions: `${substitutions?.[0] ?? ""} versions`,
        dashboardDistributionMaps: `${substitutions?.[0] ?? ""} maps`,
        dashboardEmptyVersionFiles: "No files in this version.",
        dashboardCapturedAt: substitutions?.[0] ?? "",
        dashboardMapCount: `${substitutions?.[0] ?? ""} maps`,
        dashboardDownloadVersion: "Download version",
        dashboardDeleteVersion: "Delete",
        dashboardCleanup: "Optimize Storage",
        dashboardCleanupDone: `Abnormal data cleaned: ${substitutions?.[0] ?? ""} versions`,
        dashboardCleanupOptimized: `Storage optimized: ${substitutions?.[0] ?? ""} maps, ${substitutions?.[1] ?? ""} reclaimed`,
        dashboardCleanupNone: "No abnormal data found and no storage optimization was needed",
        dashboardPreviewSources: "Preview Sources",
        dashboardPreviewTitle: "Source Preview",
        dashboardPreviewEmpty: "Select a file to preview",
        dashboardImportTitle: "Import Source Maps",
        dashboardImportHelp: "Attach one or more source map files...",
        dashboardImportUrlLabel: "Page URL",
        dashboardImportUrlPlaceholder: "https://example.com/app",
        dashboardImportPageTitleLabel: "Page Title",
        dashboardImportTitlePlaceholder: "Optional page title",
        dashboardImportFileLabel: "Source map files",
        dashboardImportEmpty: "No files selected yet.",
        dashboardImportConfirm: "Import",
        dashboardImportResultCreated: `Imported ${substitutions?.[0] ?? ""} source map files as a new version`,
        dashboardImportResultReused: `Matched an existing version with ${substitutions?.[0] ?? ""} source map files`,
        dashboardImportResultRejected: `${substitutions?.[0] ?? ""} files were skipped`,
        optionsPageTitle: "SourceD",
        optionsEyebrow: "Browser Extension",
        optionsLead: "Detect source maps...",
        optionsVersion: "Version",
        optionsCachedMaps: "Stored Versions",
        optionsTrackedPages: "Tracked Pages",
        optionsWhatItDoesTitle: "What It Does",
        optionsWhatItDoesBodyPrefix: "SourceD watches JavaScript requests, locates",
        optionsWhatItDoesBodyMiddle: ", keeps only valid source maps with",
        optionsWhatItDoesBodySuffix: ", and lets you download the reconstructed source tree from the popup.",
        optionsPermissionsTitle: "Permissions",
        optionsPermissionWebRequestBody: "to detect JavaScript files that may reference a source map",
        optionsPermissionDownloadsBody: "to save recovered source archives",
        optionsPermissionTabsBody: "to associate findings with the active page",
        optionsPermissionStorageBody: "to keep map metadata and content locally",
        optionsPermissionHostsBody: "because source maps may be hosted on any origin",
        optionsPrivacyTitle: "Privacy",
        optionsPrivacyLocal: "Processing happens locally",
        optionsPrivacyNoRemote: "No collected map data is sent",
        optionsPrivacyClear: "You can clear cached data",
        optionsResponsibleTitle: "Responsible Use",
        optionsResponsibleBody: "Use SourceD only where you are authorized",
        optionsHistoryTitle: "History Dashboard",
        optionsHistoryBody: "Open the full dashboard...",
        optionsOpenDashboard: "Open History Dashboard",
      };
      return messages[key] || key;
    },
    getUILanguage: () => "en",
  },
  runtime: {
    getManifest: () => ({ version: "0.0.1", name: "SourceD" }),
    getURL: (path) => `chrome-extension://fakeid/${path}`,
    sendMessage: (msg, cb) => {
      if (typeof cb === "function") {
        cb(null);
      }
    },
  },
  tabs: {
    query: (opts, cb) => cb([{ url: "https://example.com", title: "Example" }]),
    create: () => {},
  },
  downloads: {
    download: (opts, cb) => { if (cb) cb(); },
  },
};
