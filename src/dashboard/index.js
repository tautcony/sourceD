"use strict";

var dashboardState = {
  loading: true,
  pages: [],
  distribution: [],
  settings: null,
  totalVersions: 0,
  totalStorageBytes: 0,
  expandedDomains: {},
  expandedPages: {},
  expandedVersions: {},
  filesByVersion: {},
  loadingVersions: {},
  pendingVersionLoads: {},
  collapsedFolders: {}
};

var locale = chrome.i18n.getUILanguage() || "en";
document.documentElement.lang = /^zh\b/i.test(locale) ? "zh-CN" : "en";
document.title = chrome.i18n.getMessage("dashboardPageTitle") || "SourceD";

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setText(id, key) {
  var node = document.getElementById(id);
  if (node) node.textContent = chrome.i18n.getMessage(key) || key;
}

function formatShortDate(iso) {
  if (!iso) return i18nMessage("commonUnknown");
  return new Date(iso).toLocaleDateString(uiLocale(), {
    month: "2-digit",
    day: "2-digit"
  });
}

function formatVersionTime(iso) {
  if (!iso) return i18nMessage("commonUnknown");
  return new Date(iso).toLocaleString(uiLocale(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildMapTree(files) {
  var root = { folders: {}, files: [] };

  files.forEach(function (file) {
    var parts = sourceMapTreePath(file.url);
    var node = root;

    for (var i = 0; i < parts.length - 1; i++) {
      if (!node.folders[parts[i]]) {
        node.folders[parts[i]] = { name: parts[i], folders: {}, files: [] };
      }
      node = node.folders[parts[i]];
    }

    node.files.push({
      name: parts[parts.length - 1] || parseFileName(file.url),
      url: file.url,
      size: file.content.length
    });
  });

  return root;
}

function renderTreeNodes(node, depth, parentPath, versionId) {
  var folderNames = Object.keys(node.folders).sort();
  var fileNodes = node.files.slice().sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
  var html = "";

  folderNames.forEach(function (folderName) {
    var folder = node.folders[folderName];
    var folderPath = versionId + "::" + (parentPath ? parentPath + "/" : "") + folder.name;
    var collapsed = !!dashboardState.collapsedFolders[folderPath];

    html += [
      "<div class='tree-node'>",
      "<button class='tree-folder tree-folder-button' type='button' data-folder-key='", escapeHtml(folderPath), "' style='padding-left:", String(depth * 18 + 16), "px'>",
      "<span class='tree-caret'>", collapsed ? "▸" : "▾", "</span>",
      "<span class='tree-folder-name'>", escapeHtml(folder.name), "</span>",
      "</button>",
      collapsed ? "" : renderTreeNodes(folder, depth + 1, parentPath ? parentPath + "/" + folder.name : folder.name, versionId),
      "</div>"
    ].join("");
  });

  fileNodes.forEach(function (file) {
    html += [
      "<div class='file-item tree-file-item dashboard-file-item'>",
      "<div class='file-name-wrap' style='padding-left:", String(depth * 18 + 34), "px'>",
      "<span class='tree-file-bullet'>•</span>",
      "<span class='file-url' title='", escapeHtml(file.url), "'>", escapeHtml(file.name), "</span>",
      "</div>",
      "<span class='file-size'>", escapeHtml(fileSizeIEC(file.size)), "</span>",
      "</div>"
    ].join("");
  });

  return html;
}

function renderVersionPanel(version) {
  var files = dashboardState.filesByVersion[version.id];
  if (dashboardState.loadingVersions[version.id]) {
    return "<div class='dashboard-version-body loading-inline'>" + escapeHtml(chrome.i18n.getMessage("dashboardLoadingVersion") || "Loading version details...") + "</div>";
  }

  if (!files) return "";

  if (!files.length) {
    return "<div class='dashboard-version-body empty-copy'>" + escapeHtml(chrome.i18n.getMessage("dashboardEmptyVersionFiles") || "No files in this version.") + "</div>";
  }

  return [
    "<div class='dashboard-version-body'>",
    "<div class='dashboard-version-meta'>",
    "<span>", escapeHtml(chrome.i18n.getMessage("dashboardVersionFiles", [String(files.length)]) || (String(files.length) + " files")), "</span>",
    "<span>", escapeHtml(fileSizeIEC(version.byteSize || 0)), "</span>",
    "</div>",
    "<div class='dashboard-version-tree'>",
    renderTreeNodes(buildMapTree(files), 0, "", version.id),
    "</div>",
    "</div>"
  ].join("");
}

function renderHistory() {
  var root = document.getElementById("dashboard-history-list");
  if (dashboardState.loading) {
    root.innerHTML = "<p class='empty-copy'>" + escapeHtml(chrome.i18n.getMessage("dashboardLoading") || "Loading...") + "</p>";
    return;
  }

  if (!dashboardState.pages.length) {
    root.innerHTML = "<p class='empty-copy'>" + escapeHtml(chrome.i18n.getMessage("dashboardEmptyHistory") || "No history yet.") + "</p>";
    return;
  }

  var groups = groupPagesByDomain(dashboardState.pages);

  root.innerHTML = groups.map(function (group) {
    var domainExpanded = !!dashboardState.expandedDomains[group.siteKey];
    return [
      "<section class='dashboard-domain-card'>",
      "<button class='dashboard-domain-head' type='button' data-domain-key='", escapeHtml(group.siteKey), "'>",
      "<div class='dashboard-domain-main'>",
      "<div class='dashboard-page-title-row'>",
      "<span class='dashboard-caret'>", domainExpanded ? "▾" : "▸", "</span>",
      "<h3>", escapeHtml(group.siteKey), "</h3>",
      "</div>",
      "<p class='dashboard-page-url'>", escapeHtml(chrome.i18n.getMessage("dashboardDomainSummary", [String(group.pages.length), String(group.versionCount)]) || ""), "</p>",
      "</div>",
      "<div class='dashboard-page-side'>",
      "<span class='history-badge'>", String(group.versionCount), "</span>",
      "<span class='dashboard-page-updated'>", escapeHtml(chrome.i18n.getMessage("dashboardLastUpdated", [formatShortDate(group.lastSeenAt)]) || ("Updated " + formatShortDate(group.lastSeenAt))), "</span>",
      "</div>",
      "</button>",
      domainExpanded ? [
        "<div class='dashboard-domain-body'>",
        group.pages.map(function (page) {
          var expanded = !!dashboardState.expandedPages[page.pageUrl];
          return [
            "<article class='dashboard-page-card'>",
            "<div class='dashboard-page-head'>",
            "<button class='dashboard-page-toggle' type='button' data-page-url='", escapeHtml(page.pageUrl), "'>",
            "<div class='dashboard-page-main'>",
            "<div class='dashboard-page-title-row'>",
            "<span class='dashboard-caret'>", expanded ? "▾" : "▸", "</span>",
            "<h3>", escapeHtml(page.title || page.pageUrl), "</h3>",
            "</div>",
            "<p class='dashboard-page-url'>", escapeHtml(page.pageUrl), "</p>",
            "</div>",
            "</button>",
            "<div class='dashboard-page-side'>",
            "<span class='history-badge'>", String(page.versions.length), "</span>",
            "<span class='dashboard-page-updated'>", escapeHtml(chrome.i18n.getMessage("dashboardLastUpdated", [formatShortDate(page.versions[0] && page.versions[0].lastSeenAt)]) || ("Updated " + formatShortDate(page.versions[0] && page.versions[0].lastSeenAt))), "</span>",
            "</div>",
            "</div>",
            expanded ? [
              "<div class='dashboard-page-body'>",
              page.versions.map(function (version) {
                var versionExpanded = !!dashboardState.expandedVersions[version.id];
                return [
                  "<section class='dashboard-version-card'>",
                  "<div class='dashboard-version-head'>",
                  "<button class='dashboard-version-toggle' type='button' data-version-id='", escapeHtml(version.id), "'>",
                  "<span class='dashboard-caret'>", versionExpanded ? "▾" : "▸", "</span>",
                  "<span class='dashboard-version-title'>", escapeHtml(version.label), "</span>",
                  "</button>",
                  "<div class='dashboard-version-side'>",
                  "<span class='version-pill'>", escapeHtml(chrome.i18n.getMessage("dashboardCapturedAt", [formatVersionTime(version.createdAt)]) || formatVersionTime(version.createdAt)), "</span>",
                  "<span class='version-pill subtle'>", escapeHtml(chrome.i18n.getMessage("dashboardMapCount", [String(version.mapCount || 0)]) || (String(version.mapCount || 0) + " maps")), "</span>",
                  "<button class='btn btn-secondary btn-small' type='button' data-download-version-id='", escapeHtml(version.id), "'>", escapeHtml(chrome.i18n.getMessage("dashboardDownloadVersion") || "Download version"), "</button>",
                  "<button class='danger-link' type='button' data-delete-version-id='", escapeHtml(version.id), "'>", escapeHtml(chrome.i18n.getMessage("dashboardDeleteVersion") || "Delete"), "</button>",
                  "</div>",
                  "</div>",
                  versionExpanded ? renderVersionPanel(version) : "",
                  "</section>"
                ].join("");
              }).join(""),
              "</div>"
            ].join("") : "",
            "</article>"
          ].join("");
        }).join(""),
        "</div>"
      ].join("") : "",
      "</section>"
    ].join("");
  }).join("");
}

function groupPagesByDomain(pages) {
  var buckets = {};

  pages.forEach(function (page) {
    var siteKey = page.siteKey || i18nMessage("commonUnknown");
    if (!buckets[siteKey]) {
      buckets[siteKey] = {
        siteKey: siteKey,
        pages: [],
        versionCount: 0,
        lastSeenAt: null
      };
    }
    buckets[siteKey].pages.push(page);
    buckets[siteKey].versionCount += page.versions.length;
    var pageLastSeenAt = page.versions[0] && page.versions[0].lastSeenAt;
    if (!buckets[siteKey].lastSeenAt || new Date(pageLastSeenAt).getTime() > new Date(buckets[siteKey].lastSeenAt).getTime()) {
      buckets[siteKey].lastSeenAt = pageLastSeenAt;
    }
  });

  return Object.keys(buckets).map(function (siteKey) {
    buckets[siteKey].pages.sort(function (a, b) {
      return new Date((b.versions[0] && b.versions[0].lastSeenAt) || 0).getTime() -
        new Date((a.versions[0] && a.versions[0].lastSeenAt) || 0).getTime();
    });
    return buckets[siteKey];
  }).sort(function (a, b) {
    return new Date(b.lastSeenAt || 0).getTime() - new Date(a.lastSeenAt || 0).getTime();
  });
}

function findPage(pageUrl) {
  return dashboardState.pages.find(function (page) {
    return page.pageUrl === pageUrl;
  }) || null;
}

function findVersion(versionId) {
  for (var i = 0; i < dashboardState.pages.length; i++) {
    var page = dashboardState.pages[i];
    for (var j = 0; j < page.versions.length; j++) {
      if (page.versions[j].id === versionId) return page.versions[j];
    }
  }
  return null;
}

function renderDistribution() {
  var root = document.getElementById("dashboard-distribution-list");
  if (dashboardState.loading) {
    root.innerHTML = "<p class='empty-copy'>" + escapeHtml(chrome.i18n.getMessage("dashboardLoading") || "Loading...") + "</p>";
    return;
  }

  if (!dashboardState.distribution.length) {
    root.innerHTML = "<p class='empty-copy'>" + escapeHtml(chrome.i18n.getMessage("dashboardEmptyDistribution") || "No data yet.") + "</p>";
    return;
  }

  root.innerHTML = dashboardState.distribution.map(function (item) {
    return [
      "<article class='distribution-card'>",
      "<h3>", escapeHtml(item.siteKey), "</h3>",
      "<div class='distribution-metrics'>",
      "<span>", escapeHtml(chrome.i18n.getMessage("dashboardDistributionVersions", [String(item.versionCount)]) || String(item.versionCount)), "</span>",
      "<span>", escapeHtml(chrome.i18n.getMessage("dashboardDistributionMaps", [String(item.mapCount)]) || String(item.mapCount)), "</span>",
      "<span>", escapeHtml(fileSizeIEC(item.byteSize || 0)), "</span>",
      "</div>",
      "</article>"
    ].join("");
  }).join("");
}

function renderSettings() {
  if (!dashboardState.settings) return;
  document.getElementById("dashboard-setting-retention-days").value = dashboardState.settings.retentionDays;
  document.getElementById("dashboard-setting-max-versions").value = dashboardState.settings.maxVersionsPerPage;
  document.getElementById("dashboard-setting-auto-cleanup").checked = !!dashboardState.settings.autoCleanup;
}

function renderSummary() {
  document.getElementById("dashboard-total-pages").textContent = String(dashboardState.pages.length);
  document.getElementById("dashboard-total-versions").textContent = String(dashboardState.totalVersions || 0);
  document.getElementById("dashboard-total-storage").textContent = fileSizeIEC(dashboardState.totalStorageBytes || 0);
}

function renderDashboard() {
  renderSummary();
  renderHistory();
  renderDistribution();
  renderSettings();
}

function loadDashboard() {
  dashboardState.loading = true;
  renderDashboard();

  chrome.runtime.sendMessage({ action: "getDashboardData" }, function (data) {
    dashboardState.loading = false;
    dashboardState.pages = (data && data.pages) || [];
    dashboardState.distribution = (data && data.distribution) || [];
    dashboardState.settings = (data && data.settings) || {
      retentionDays: 30,
      maxVersionsPerPage: 10,
      autoCleanup: true
    };
    dashboardState.totalVersions = (data && data.totalVersions) || 0;
    dashboardState.totalStorageBytes = (data && data.totalStorageBytes) || 0;
    renderDashboard();
  });
}

function ensureVersionFiles(versionId) {
  if (dashboardState.filesByVersion[versionId]) {
    return Promise.resolve(dashboardState.filesByVersion[versionId]);
  }
  if (dashboardState.pendingVersionLoads[versionId]) {
    return dashboardState.pendingVersionLoads[versionId];
  }

  dashboardState.loadingVersions[versionId] = true;
  renderHistory();

  dashboardState.pendingVersionLoads[versionId] = new Promise(function (resolve) {
    chrome.runtime.sendMessage({ action: "getVersionFiles", versionId: versionId }, function (response) {
      dashboardState.loadingVersions[versionId] = false;
      dashboardState.filesByVersion[versionId] = response && response.ok ? (response.files || []) : [];
      delete dashboardState.pendingVersionLoads[versionId];
      renderHistory();
      resolve(dashboardState.filesByVersion[versionId]);
    });
  });

  return dashboardState.pendingVersionLoads[versionId];
}

function handleVersionDownload(versionId) {
  var version = findVersion(versionId);
  if (!version) return;

  ensureVersionFiles(versionId).then(function (files) {
    return downloadGroup(files, null, versionZipBaseName(files, version));
  }).catch(function (err) {
    console.error("[SourceD] version download failed:", err);
  });
}

setText("dashboard-eyebrow", "dashboardEyebrow");
setText("dashboard-title", "dashboardTitle");
setText("dashboard-lead", "dashboardLead");
setText("dashboard-refresh", "dashboardRefresh");
setText("dashboard-total-pages-label", "dashboardTotalPages");
setText("dashboard-total-versions-label", "dashboardTotalVersions");
setText("dashboard-total-storage-label", "dashboardTotalStorage");
setText("dashboard-history-title", "dashboardHistoryTitle");
setText("dashboard-history-copy", "dashboardHistoryCopy");
setText("dashboard-distribution-title", "dashboardDistributionTitle");
setText("dashboard-distribution-copy", "dashboardDistributionCopy");
setText("dashboard-settings-title", "dashboardSettingsTitle");
setText("dashboard-settings-copy", "dashboardSettingsCopy");
setText("dashboard-setting-retention-label", "dashboardSettingRetentionDays");
setText("dashboard-setting-max-versions-label", "dashboardSettingMaxVersions");
setText("dashboard-setting-auto-cleanup-label", "dashboardSettingAutoCleanup");
setText("dashboard-settings-save", "dashboardSaveSettings");

document.getElementById("dashboard-refresh").addEventListener("click", function () {
  loadDashboard();
});

document.getElementById("dashboard-history-list").addEventListener("click", function (event) {
  var folderButton = event.target.closest("[data-folder-key]");
  if (folderButton) {
    var folderKey = folderButton.getAttribute("data-folder-key");
    dashboardState.collapsedFolders[folderKey] = !dashboardState.collapsedFolders[folderKey];
    renderHistory();
    return;
  }

  var versionDownloadButton = event.target.closest("[data-download-version-id]");
  if (versionDownloadButton) {
    handleVersionDownload(versionDownloadButton.getAttribute("data-download-version-id"));
    return;
  }

  var deleteButton = event.target.closest("[data-delete-version-id]");
  if (deleteButton) {
    chrome.runtime.sendMessage({
      action: "deleteVersion",
      versionId: deleteButton.getAttribute("data-delete-version-id")
    }, function () {
      loadDashboard();
    });
    return;
  }

  var versionButton = event.target.closest("[data-version-id]");
  if (versionButton) {
    var versionId = versionButton.getAttribute("data-version-id");
    dashboardState.expandedVersions[versionId] = !dashboardState.expandedVersions[versionId];
    if (dashboardState.expandedVersions[versionId]) ensureVersionFiles(versionId);
    renderHistory();
    return;
  }

  var pageButton = event.target.closest("[data-page-url]");
  if (pageButton) {
    var pageUrl = pageButton.getAttribute("data-page-url");
    dashboardState.expandedPages[pageUrl] = !dashboardState.expandedPages[pageUrl];
    renderHistory();
    return;
  }

  var domainButton = event.target.closest("[data-domain-key]");
  if (domainButton) {
    var domainKey = domainButton.getAttribute("data-domain-key");
    dashboardState.expandedDomains[domainKey] = !dashboardState.expandedDomains[domainKey];
    renderHistory();
  }
});

document.getElementById("dashboard-settings-form").addEventListener("submit", function (event) {
  event.preventDefault();
  var status = document.getElementById("dashboard-settings-status");
  status.textContent = chrome.i18n.getMessage("dashboardSaving") || "Saving...";

  chrome.runtime.sendMessage({
    action: "updateSettings",
    settings: {
      retentionDays: Number(document.getElementById("dashboard-setting-retention-days").value) || 30,
      maxVersionsPerPage: Number(document.getElementById("dashboard-setting-max-versions").value) || 10,
      autoCleanup: document.getElementById("dashboard-setting-auto-cleanup").checked
    }
  }, function () {
    status.textContent = chrome.i18n.getMessage("dashboardSaved") || "Saved";
    loadDashboard();
  });
});

loadDashboard();
