"use strict";

var manifest = chrome.runtime.getManifest();
var locale = chrome.i18n.getUILanguage() || "en";

document.documentElement.lang = /^zh\b/i.test(locale) ? "zh-CN" : "en";
document.title = chrome.i18n.getMessage("optionsPageTitle") || manifest.name || "SourceD";

function setText(id, key) {
  document.getElementById(id).textContent = chrome.i18n.getMessage(key) || key;
}

function setHtml(id, key) {
  document.getElementById(id).innerHTML = chrome.i18n.getMessage(key) || key;
}

setText("options-eyebrow", "optionsEyebrow");
setText("options-lead", "optionsLead");
setText("options-version-label", "optionsVersion");
setText("options-cached-maps-label", "optionsCachedMaps");
setText("options-tracked-pages-label", "optionsTrackedPages");
setText("options-what-it-does-title", "optionsWhatItDoesTitle");
setHtml("options-what-it-does-body", "optionsWhatItDoesBody");
setText("options-permissions-title", "optionsPermissionsTitle");
setHtml("options-permission-webrequest", "optionsPermissionWebRequest");
setHtml("options-permission-downloads", "optionsPermissionDownloads");
setHtml("options-permission-tabs", "optionsPermissionTabs");
setHtml("options-permission-storage", "optionsPermissionStorage");
setHtml("options-permission-hosts", "optionsPermissionHosts");
setText("options-privacy-title", "optionsPrivacyTitle");
setText("options-privacy-local", "optionsPrivacyLocal");
setText("options-privacy-remote", "optionsPrivacyNoRemote");
setText("options-privacy-clear", "optionsPrivacyClear");
setText("options-responsible-title", "optionsResponsibleTitle");
setText("options-responsible-body", "optionsResponsibleBody");
setText("options-history-title", "optionsHistoryTitle");
setText("options-open-dashboard", "optionsOpenDashboard");
setText("options-history-body", "optionsHistoryBody");

document.getElementById("app-version").textContent = manifest.version || "unknown";

function refreshOverview() {
  chrome.runtime.sendMessage({ action: "getDashboardData" }, function (data) {
    if (!data) return;
    document.getElementById("map-count").textContent = String(data.totalVersions || 0);
    document.getElementById("page-count").textContent = String((data.pages || []).length);
  });
}

document.getElementById("options-open-dashboard").addEventListener("click", function () {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

refreshOverview();
