// Source map helpers for the bundled React UI.

import JSZip from "jszip";
import { SourceMapConsumer } from "source-map-js";
import { sanitizeFilename, sanitizePath } from "../shared/utils.mjs";

// ─── Path handling ─────────────────────────────────────────────────────────────

function isUserSourceFile(fileName) {
  /* c8 ignore next */
  if (!fileName) return false;
  if (fileName.charCodeAt(0) === 0) return false;
  if (/^\/?@vite|^\/?@id\//.test(fileName)) return false;
  if (/^vite\//.test(fileName)) return false;
  if (/webpack\/(bootstrap|runtime)/.test(fileName)) return false;
  if (/\(webpack\)/.test(fileName)) return false;
  if (fileName.startsWith("data:")) return false;
  return true;
}

function normalizeSourcePath(fileName) {
  /* c8 ignore next */
  if (!fileName) return null;

  var result;
  if (fileName.startsWith("webpack://")) {
    fileName = fileName.replace(/^webpack:\/\/[^/]*\//, "");
    fileName = fileName.replace(/^webpack:\/\//, "");
    fileName = fileName.replace(/^\/+/, "");
    fileName = fileName.replace(/^~\//, "node_modules/");
    result = sanitizePath(fileName);
  } else if (fileName.startsWith("/@fs/")) {
    var fsPath = fileName.slice(5);
    var knownDir = /\/(src|lib|app|components|pages|views|utils|stores?|router|assets|styles?|api|hooks|composables|types?)\//;
    var m = fsPath.match(knownDir);
    if (m) {
      fileName = fsPath.slice(fsPath.indexOf(m[0]) + 1);
    } else {
      fileName = fsPath.replace(/^(?:[/\\][^/\\]+){1,4}[/\\]/, "");
    }
    result = sanitizePath(fileName);
  } else {
    fileName = fileName.replace(/^\/+/, "").replace(/^\.\//, "");
    result = sanitizePath(fileName);
  }

  return result;
}

// ─── ZIP helpers ──────────────────────────────────────────────────────────────

function addZipFile(root, filename, content) {
  /* c8 ignore next */
  if (!filename || !content) return;
  var parts = filename.split("/");
  var folder = root;
  for (var i = 0; i < parts.length - 1; i++) {
    var seg = parts[i];
    /* c8 ignore next */
    if (seg && seg !== "." && seg !== "..") folder = folder.folder(seg);
  }
  var last = parts[parts.length - 1];
  /* c8 ignore next */
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
  /* c8 ignore next */
  if (!prefix) return filename;
  /* c8 ignore next */
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

export function versionZipBaseName(files, version) {
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
  var seen = {};

  for (var i = 0; i < files.length; i++) {
    var consumer;
    try {
      var rawSourceMap = files[i].content || (contentMap && contentMap[files[i].url]);
      if (!rawSourceMap) {
        throw new TypeError("Missing source map content for " + files[i].url);
      }
      consumer = new SourceMapConsumer(rawSourceMap);
      consumer.sources.forEach(function (src) {
        if (!isUserSourceFile(src)) return;
        var content = consumer.sourceContentFor(src, true);
        if (!content) return;
        var dest = normalizeSourcePath(src);
        /* c8 ignore next */
        if (!dest) return;
        var fullPath = prefixedPath(pathPrefix, dest);
        if (seen[fullPath]) return;
        seen[fullPath] = true;
        addZipFile(zip, fullPath, content);
        added++;
      });
    } catch (e) {
      errors.push(e);
    } finally {
      /* c8 ignore next */
      if (consumer && typeof consumer.destroy === "function") consumer.destroy();
    }
  }

  return { added: added, errors: errors };
}

// ─── Single file download ─────────────────────────────────────────────────────

export function extractSourceFiles(files) {
  var seen = {};
  var result = [];
  for (var i = 0; i < files.length; i++) {
    var consumer;
    try {
      var rawSourceMap = files[i].content;
      if (!rawSourceMap) continue;
      consumer = new SourceMapConsumer(rawSourceMap);
      consumer.sources.forEach(function (src) {
        if (!isUserSourceFile(src)) return;
        var content = consumer.sourceContentFor(src, true);
        if (!content) return;
        var dest = normalizeSourcePath(src);
        /* c8 ignore next */
        if (!dest) return;
        if (seen[dest]) return;
        seen[dest] = true;
        result.push({ path: dest, content: content });
      });
    } catch {
      // skip invalid source maps
    } finally {
      /* c8 ignore next */
      if (consumer && typeof consumer.destroy === "function") consumer.destroy();
    }
  }
  return result;
}

export async function parseSourceMap(sourceMapFileName, rawSourceMap) {
  var consumer = new SourceMapConsumer(rawSourceMap);
  try {
    var zip = new JSZip();
    var added = 0;
    consumer.sources.forEach(function (src) {
      if (!isUserSourceFile(src)) return;
      var content = consumer.sourceContentFor(src, true);
      if (!content) return;
      var dest = normalizeSourcePath(src);
      /* c8 ignore next */
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
    /* c8 ignore next */
    if (consumer && typeof consumer.destroy === "function") consumer.destroy();
  }
}

// ─── Batch download ───────────────────────────────────────────────────────────

export async function downloadGroup(files, contentMap, zipBaseName) {
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
