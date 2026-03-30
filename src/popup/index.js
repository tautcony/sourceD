"use strict";

var appState = {
  pageUrl: null,
  pageTitle: null,
  latestVersion: null,
  files: [],
  totalStorageBytes: 0,
  totalVersions: 0,
  loading: true,
  collapsedFolders: {}
};

function loadPopupState() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    var pageUrl = tab && tab.url ? tab.url : "";

    chrome.runtime.sendMessage({ action: "getPopupState", pageUrl: pageUrl }, function (data) {
      appState.loading = false;
      appState.pageUrl = pageUrl;
      appState.pageTitle = tab && tab.title ? tab.title : pageUrl;

      if (!data || !data.ok) {
        appState.latestVersion = null;
        appState.files = [];
        renderApp();
        return;
      }

      appState.latestVersion = data.latestVersion;
      appState.files = data.files || [];
      appState.totalStorageBytes = data.totalStorageBytes || 0;
      appState.totalVersions = data.totalVersions || 0;
      renderApp();
    });
  });
}

function handleFileClick(e) {
  e.preventDefault();
  var el = e.target.closest(".file-name-wrap");
  if (!el || !el.dataset.fileUrl || !appState.latestVersion) return;
  var file = appState.files.find(function (item) { return item.url === el.dataset.fileUrl; });
  if (!file) return;
  parseSourceMap(
    sanitizeFilename(parseFileName(el.dataset.fileUrl)),
    file.content
  ).catch(function (err) { console.error("[SourceD] download error:", err); });
}

function handleFolderClick(e) {
  var folder = e.target.closest(".tree-folder");
  if (!folder || !folder.dataset.folderKey) return;
  appState.collapsedFolders[folder.dataset.folderKey] = !appState.collapsedFolders[folder.dataset.folderKey];
  renderApp();
}

function handleDownloadAll() {
  if (!appState.files.length) return;
  downloadGroup(appState.files).catch(function (err) {
    console.error("[SourceD] batch download error:", err);
  });
}

function handleClearCurrentPage() {
  if (!appState.pageUrl || !appState.latestVersion) return;
  chrome.runtime.sendMessage({
    action: "deletePageHistory",
    pageUrl: appState.pageUrl
  }, function () {
    loadPopupState();
  });
}

function handleOpenHistory() {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
}

loadPopupState();
