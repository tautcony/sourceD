import "@testing-library/jest-dom/vitest";

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
        popupClearButton: "Clear Current Page",
        popupLoading: "Loading current page data...",
        popupEmptyTitle: "No source files detected",
        popupEmptyHint: "Visit a site that exposes source maps and SourceD will detect them automatically",
        popupDownloadAll: "Download all",
        popupStoredVersions: `${substitutions?.[0] ?? ""} versions`,
        popupStorageUsed: `${substitutions?.[0] ?? ""} used`,
        popupLatestVersion: `Latest version: ${substitutions?.[0] ?? ""}`,
        popupDetectionToggle: "Detect",
        dashboardPageTitle: "SourceD History",
        dashboardEyebrow: "Source Map Archive",
        dashboardTitle: "SourceD History",
        dashboardLead: "Browse every tracked page...",
        dashboardRefresh: "Refresh",
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
        dashboardSaveSettings: "Save Settings",
        dashboardSaved: "Saved",
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
        optionsPageTitle: "SourceD",
        optionsEyebrow: "Browser Extension",
        optionsLead: "Detect source maps...",
        optionsVersion: "Version",
        optionsCachedMaps: "Stored Versions",
        optionsTrackedPages: "Tracked Pages",
        optionsWhatItDoesTitle: "What It Does",
        optionsWhatItDoesBody: "SourceD watches JavaScript requests...",
        optionsPermissionsTitle: "Permissions",
        optionsPermissionWebRequest: "<code>webRequest</code> to detect",
        optionsPermissionDownloads: "<code>downloads</code> to save",
        optionsPermissionTabs: "<code>tabs</code> to associate",
        optionsPermissionStorage: "<code>storage</code> to keep",
        optionsPermissionHosts: "<code>all_urls</code> because",
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
