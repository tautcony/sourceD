"use strict";

var h = React.createElement;

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

function renderTreeNode(node, depth, parentPath) {
  var folderNames = Object.keys(node.folders).sort();
  var fileNodes = node.files.slice().sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });

  return folderNames.map(function (folderName) {
    var folder = node.folders[folderName];
    var folderPath = (parentPath ? parentPath + "/" : "") + folder.name;
    var collapsed = !!appState.collapsedFolders[folderPath];

    return h("div", { key: "folder-" + folderPath, className: "tree-node" },
      h("div", {
        className: "tree-folder",
        style: { paddingLeft: (depth * 18 + 16) + "px" },
        onClick: handleFolderClick,
        "data-folder-key": folderPath
      },
        h("span", { className: "tree-caret" }, collapsed ? "▸" : "▾"),
        h("span", { className: "tree-folder-name" }, folder.name)
      ),
      collapsed ? null : renderTreeNode(folder, depth + 1, folderPath)
    );
  }).concat(fileNodes.map(function (file) {
    return h("div", { key: "file-" + file.url, className: "file-item tree-file-item" },
      h("div", {
        className: "file-name-wrap",
        onClick: handleFileClick,
        "data-file-url": file.url,
        style: { paddingLeft: (depth * 18 + 34) + "px" }
      },
        h("span", { className: "tree-file-bullet" }, "•"),
        h("a", {
          className: "file-url",
          href: "#",
          title: file.url
        }, file.name)
      ),
      h("span", { className: "file-size" }, fileSizeIEC(file.size))
    );
  }));
}

function buildVDOM(s) {
  var totalBytes = s.totalStorageBytes || 0;

  var statsRow =
    h("div", { className: "header-stats" },
      h("span", { className: "stat-item" }, i18nMessage("popupStoredVersions", [String(s.totalVersions || 0)])),
      h("span", { className: "stat-sep" }, "·"),
      h("span", { className: "stat-item" }, i18nMessage("popupStorageUsed", [fileSizeIEC(totalBytes)]))
    );

  var header = h("div", { className: "header" },
    h("div", { className: "header-top" },
      h("h1", null, i18nMessage("popupHeaderTitle")),
      h("div", { className: "header-actions" },
        h("button", {
          className: "btn btn-secondary btn-small",
          onClick: handleOpenHistory
        }, i18nMessage("popupOpenHistory")),
        h("button", {
          className: "btn btn-secondary btn-small" + (s.latestVersion ? "" : " disabled"),
          onClick: handleClearCurrentPage
        }, i18nMessage("popupClearButton"))
      )
    ),
    statsRow
  );

  if (s.loading) {
    return h("div", { className: "app-container" },
      header,
      h("div", { className: "loading-state" }, i18nMessage("popupLoading"))
    );
  }

  if (!s.latestVersion) {
    return h("div", { className: "app-container" },
      header,
      h("div", { className: "empty-state" },
        h("div", { className: "empty-icon" }, "📦"),
        h("p", null, i18nMessage("popupEmptyTitle")),
        h("p", { className: "hint" }, i18nMessage("popupEmptyHint"))
      )
    );
  }

  var fileTree = buildMapTree(s.files);

  return h("div", { className: "app-container" },
    header,
    h("div", { className: "content-container" },
      h("div", { className: "content-header" },
        h("div", { className: "page-meta" },
          h("a", {
            className: "page-link",
            href: s.pageUrl,
            target: "_blank",
            rel: "noopener noreferrer"
          }, s.pageUrl),
          h("div", { className: "latest-version-line" },
            i18nMessage("popupLatestVersion", [s.latestVersion.label])
          )
        ),
        h("div", { className: "actions" },
          h("button", {
            className: "btn btn-primary",
            onClick: handleDownloadAll
          },
            h("span", { className: "btn-icon" }, "⬇"),
            " " + i18nMessage("popupDownloadAll")
          )
        )
      ),
      h("div", { className: "file-list" },
        renderTreeNode(fileTree, 0, "")
      )
    )
  );
}

var reactRoot = null;

function renderApp() {
  if (!reactRoot) {
    reactRoot = ReactDOM.createRoot(document.getElementById("app"));
  }
  reactRoot.render(buildVDOM(appState));
}
