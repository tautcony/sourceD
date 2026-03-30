"use strict";

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

    return createVDOM("div", { className: "tree-node" },
      createVDOM("div", {
        className: "tree-folder",
        style: "padding-left:" + (depth * 18 + 16) + "px",
        onclick: handleFolderClick,
        _folderKey: folderPath
      },
        createVDOM("span", { className: "tree-caret" }, collapsed ? "▸" : "▾"),
        createVDOM("span", { className: "tree-folder-name" }, folder.name)
      ),
      collapsed ? [] : renderTreeNode(folder, depth + 1, folderPath)
    );
  }).concat(fileNodes.map(function (file) {
    return createVDOM("div", { className: "file-item tree-file-item" },
      createVDOM("div", {
        className: "file-name-wrap",
        onclick: handleFileClick,
        _fileUrl: file.url,
        style: "padding-left:" + (depth * 18 + 34) + "px"
      },
        createVDOM("span", { className: "tree-file-bullet" }, "•"),
        createVDOM("a", {
          className: "file-url",
          href: "#",
          title: file.url
        }, file.name)
      ),
      createVDOM("span", { className: "file-size" }, fileSizeIEC(file.size))
    );
  }));
}

function buildVDOM(s) {
  var totalBytes = s.totalStorageBytes || 0;

  var statsRow = [
    createVDOM("div", { className: "header-stats" },
      createVDOM("span", { className: "stat-item" }, i18nMessage("popupStoredVersions", [String(s.totalVersions || 0)])),
      createVDOM("span", { className: "stat-sep" }, "·"),
      createVDOM("span", { className: "stat-item" }, i18nMessage("popupStorageUsed", [fileSizeIEC(totalBytes)]))
    )
  ];

  var header = createVDOM("div", { className: "header" },
    createVDOM("div", { className: "header-top" },
      createVDOM("h1", {}, i18nMessage("popupHeaderTitle")),
      createVDOM("div", { className: "header-actions" },
        createVDOM("button", {
          className: "btn btn-secondary btn-small",
          onclick: handleOpenHistory
        }, i18nMessage("popupOpenHistory")),
        createVDOM("button", {
          className: "btn btn-secondary btn-small" + (s.latestVersion ? "" : " disabled"),
          onclick: handleClearCurrentPage
        }, i18nMessage("popupClearButton"))
      )
    ),
    statsRow
  );

  if (s.loading) {
    return createVDOM("div", { className: "app-container" },
      header,
      createVDOM("div", { className: "loading-state" }, i18nMessage("popupLoading"))
    );
  }

  if (!s.latestVersion) {
    return createVDOM("div", { className: "app-container" },
      header,
      createVDOM("div", { className: "empty-state" },
        createVDOM("div", { className: "empty-icon" }, "📦"),
        createVDOM("p", {}, i18nMessage("popupEmptyTitle")),
        createVDOM("p", { className: "hint" }, i18nMessage("popupEmptyHint"))
      )
    );
  }

  var fileTree = buildMapTree(s.files);

  return createVDOM("div", { className: "app-container" },
    header,
    createVDOM("div", { className: "content-container" },
      createVDOM("div", { className: "content-header" },
        createVDOM("div", { className: "page-meta" },
          createVDOM("a", {
            className: "page-link",
            href: s.pageUrl,
            target: "_blank"
          }, s.pageUrl),
          createVDOM("div", { className: "latest-version-line" },
            i18nMessage("popupLatestVersion", [s.latestVersion.label])
          )
        ),
        createVDOM("div", { className: "actions" },
          createVDOM("button", {
            className: "btn btn-primary",
            onclick: handleDownloadAll
          },
            createVDOM("span", { className: "btn-icon" }, "⬇"),
            " " + i18nMessage("popupDownloadAll")
          )
        )
      ),
      createVDOM("div", { className: "file-list" },
        renderTreeNode(fileTree, 0, "")
      )
    )
  );
}

function renderApp() {
  renderDOM(buildVDOM(appState), document.getElementById("app"));
}
