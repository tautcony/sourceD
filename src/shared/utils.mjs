// ESM version of utils.js for import in JSX components

/* global chrome */

export function i18nMessage(key, substitutions) {
  var message = chrome.i18n.getMessage(key, substitutions);
  return message || key;
}

export function uiLocale() {
  var lang = chrome.i18n.getUILanguage() || "en";
  return /^zh\b/i.test(lang) ? "zh-CN" : "en-US";
}

export function sanitizeFilename(filename) {
  if (!filename) return "unnamed";
  filename = filename.replace(/[<>:"/\\|?*]/g, "_");
  filename = filename.replace(/[\x00-\x1f\x80-\x9f]/g, "");
  filename = filename.replace(/^[\s.]+|[\s.]+$/g, "");
  if (!filename) return "unnamed";
  if (filename.length > 200) {
    var ext = filename.lastIndexOf(".");
    return ext > 0
      ? filename.substring(0, 196) + filename.substring(ext)
      : filename.substring(0, 200);
  }
  return filename;
}

export function sanitizePath(path) {
  if (!path) return "unnamed";
  var parts = path.split("/")
    .map(sanitizeFilename)
    .filter(function (p) { return p && p !== "." && p !== ".."; });
  /* c8 ignore next */
  return parts.join("/") || "unnamed";
}

export function formatTime(isoString) {
  if (!isoString) return i18nMessage("commonUnknown");
  return new Date(isoString).toLocaleString(uiLocale(), {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
}

export function parseFileName(path) {
  var parts = (path || "").split("/");
  return parts[parts.length - 1];
}

export function fileSizeIEC(bytes) {
  if (!bytes || bytes === 0) return "0 Bytes";
  var units = ["Bytes", "KB", "MB", "GB"];
  var i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + " " + units[i];
}

export function sourceMapTreePath(url) {
  try {
    var parsed = new URL(url);
    var parts = [parsed.host];
    var pathParts = parsed.pathname.split("/").filter(function (part) { return !!part; });

    if (pathParts.length === 0) {
      parts.push(parsed.pathname === "/" ? "index.map" : sanitizeFilename(parsed.host));
    } else {
      parts = parts.concat(pathParts);
    }

    if (parsed.search) {
      parts[parts.length - 1] += parsed.search;
    }

    return parts.map(sanitizeFilename);
  } catch (_) {
    return sanitizePath(url).split("/").filter(function (part) { return !!part; });
  }
}
