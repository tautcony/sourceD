"use strict";

// Depends on src/shared/utils.js: sanitizeFilename, sanitizePath

// ─── Path handling (compatible with webpack/Vite/relative paths) ─────────────────────

/**
 * Filter out build tool internal virtual modules, keep only user source files.
 */
function isUserSourceFile(fileName) {
  if (!fileName) return false;
  if (fileName.charCodeAt(0) === 0) return false;                   // Rollup virtual:\0
  if (/^\/?@vite|^\/?@id\//.test(fileName)) return false;           // Vite internals
  if (/^vite\//.test(fileName)) return false;
  if (/webpack\/(bootstrap|runtime)/.test(fileName)) return false;  // webpack runtime
  if (/\(webpack\)/.test(fileName)) return false;
  if (fileName.startsWith("data:")) return false;
  return true;
}

/**
 * Normalize webpack/Vite/regular file paths into relative paths.
 *
 *   webpack://[name]/./src/App.vue  →  src/App.vue
 *   /@fs//abs/.../src/App.vue       →  src/App.vue
 *   /src/App.vue  /  ./src/App.vue  →  src/App.vue
 */
function normalizeSourcePath(fileName) {
  if (!fileName) return null;

  // webpack:// - remove webpack://[name]/ prefix
  if (fileName.startsWith("webpack://")) {
    fileName = fileName.replace(/^webpack:\/\/[^/]*\//, "");
    fileName = fileName.replace(/^webpack:\/\//, "");
    fileName = fileName.replace(/^\/+/, "");
    fileName = fileName.replace(/^~\//, "node_modules/");
    return sanitizePath(fileName);
  }

  // Vite /@fs/ absolute path - try to extract relative part from known directories
  if (fileName.startsWith("/@fs/")) {
    var fsPath = fileName.slice(5);
    var knownDir = /\/(src|lib|app|components|pages|views|utils|stores?|router|assets|styles?|api|hooks|composables|types?)\//;
    var m = fsPath.match(knownDir);
    if (m) {
      fileName = fsPath.slice(fsPath.indexOf(m[0]) + 1);
    } else {
      // Fallback: strip up to 4 leading path segments
      fileName = fsPath.replace(/^(?:[/\\][^/\\]+){1,4}[/\\]/, "");
    }
    return sanitizePath(fileName);
  }

  // Regular /abs or ./rel paths (Vite project relative paths)
  fileName = fileName.replace(/^\/+/, "").replace(/^\.\//, "");
  return sanitizePath(fileName);
}

// ─── ZIP helpers ─────────────────────────────────────────────────────────────────

function addZipFile(root, filename, content) {
  if (!filename || !content) return;
  var parts = filename.split("/");
  var folder = root;
  for (var i = 0; i < parts.length - 1; i++) {
    var seg = parts[i];
    if (seg && seg !== "." && seg !== "..") folder = folder.folder(seg);
  }
  var last = parts[parts.length - 1];
  if (last && last !== "." && last !== "..") folder.file(last, content);
}

function blobToDownload(filename, blob) {
  return new Promise(function (resolve) {
    var reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = function () {
      chrome.downloads.download({ filename: filename, url: reader.result }, resolve);
    };
  });
}

function prefixedPath(prefix, filename) {
  if (!prefix) return filename;
  return sanitizePath(prefix) + "/" + filename;
}

function timestampSlug(isoString) {
  if (!isoString) return "unknown-time";
  return new Date(isoString).toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function defaultZipBaseName(files) {
  var first = files && files[0];
  var pageUrl = first && first.page && first.page.url ? first.page.url : "sourced";
  return sanitizeFilename(pageUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "")) +
    "_" + timestampSlug();
}

function versionZipBaseName(files, version) {
  var first = files && files[0];
  var pageUrl = first && first.page && first.page.url ? first.page.url : "sourced";
  var pageName = sanitizeFilename(pageUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  var versionName = sanitizeFilename(version && version.label ? version.label : "version");
  var createdAt = timestampSlug(version && version.createdAt);
  return pageName + "_" + versionName + "_" + createdAt;
}

function appendFilesToZip(zip, files, contentMap, pathPrefix) {
  var errors = [];
  var added = 0;

  for (var i = 0; i < files.length; i++) {
    var consumer;
    try {
      var rawSourceMap = files[i].content || (contentMap && contentMap[files[i].url]);
      if (!rawSourceMap) {
        throw new TypeError("Missing source map content for " + files[i].url);
      }
      consumer = new sourceMap.SourceMapConsumer(rawSourceMap);
      consumer.sources.forEach(function (src) {
        if (!isUserSourceFile(src)) return;
        var content = consumer.sourceContentFor(src, true);
        if (!content) return;
        var dest = normalizeSourcePath(src);
        if (!dest) return;
        addZipFile(zip, prefixedPath(pathPrefix, dest), content);
        added++;
      });
    } catch (e) {
      errors.push(e);
    } finally {
      if (consumer && typeof consumer.destroy === "function") consumer.destroy();
    }
  }

  return { added: added, errors: errors };
}

// ─── Single file download ─────────────────────────────────────────────────────────

async function parseSourceMap(sourceMapFileName, rawSourceMap) {
  var consumer = new sourceMap.SourceMapConsumer(rawSourceMap);
  try {
    var zip = new JSZip();
    var added = 0;
    consumer.sources.forEach(function (src) {
      if (!isUserSourceFile(src)) return;
      var content = consumer.sourceContentFor(src, true);
      if (!content) return;
      var dest = normalizeSourcePath(src);
      if (!dest) return;
      addZipFile(zip, dest, content);
      added++;
    });
    if (added === 0) {
      console.warn("[SourceD] no extractable sources in", sourceMapFileName);
      return;
    }
    var zipName = sanitizeFilename(sourceMapFileName) + ".zip";
    return blobToDownload(zipName, await zip.generateAsync({ type: "blob" }));
  } finally {
    if (consumer && typeof consumer.destroy === "function") consumer.destroy();
  }
}

// ─── Batch download (all Source Maps on one page) ───────────────────────────────

async function downloadGroup(files, contentMap, zipBaseName) {
  if (!files || files.length === 0) return;
  var zip = new JSZip();
  var result = appendFilesToZip(zip, files, contentMap);

  if (result.errors.length) console.warn("[SourceD] batch download errors:", result.errors);
  if (result.added === 0) {
    console.warn("[SourceD] no extractable sources in batch download");
    return;
  }

  return blobToDownload((zipBaseName || defaultZipBaseName(files)) + ".zip", await zip.generateAsync({ type: "blob" }));
}
