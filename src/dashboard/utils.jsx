import { i18nMessage, fileSizeIEC, uiLocale } from "../shared/utils.mjs";

export function formatShortDate(iso, locale) {
  if (!iso) return i18nMessage("commonUnknown");
  return new Date(iso).toLocaleDateString(locale || uiLocale(), { month: "2-digit", day: "2-digit" });
}

export function formatVersionTime(iso, locale) {
  if (!iso) return i18nMessage("commonUnknown");
  return new Date(iso).toLocaleString(locale || uiLocale(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function cleanupStepStatus(step) {
  if (step?.ok === false) return "Failed";
  if (step?.changed) return "Changed";
  return "OK";
}

export function renderCleanupSummary(resp, fallbackError) {
  const steps = Array.isArray(resp?.steps) ? resp.steps : [];
  const cleaned = Array.isArray(resp?.cleaned) ? resp.cleaned : [];
  const stats = resp?.stats || {};
  const rows = [];

  if (resp?.ok) {
    rows.push(`Versions removed: ${Number(stats.removedVersions) || 0}`);
    rows.push(`Maps removed: ${Number(stats.removedMaps) || 0}`);
    rows.push(`Bytes reclaimed: ${fileSizeIEC(Number(stats.reclaimedBytes) || 0)}`);
    rows.push(`Hash refs upgraded: ${Number(stats.upgradedRefs) || 0}`);
    rows.push(`Version signatures upgraded: ${Number(stats.upgradedVersions) || 0}`);
  } else {
    rows.push(`Error: ${resp?.error || fallbackError}`);
  }

  if (cleaned.length) {
    rows.push("Cleaned versions:");
    cleaned.forEach((item) => {
      rows.push(`- ${item.pageUrl} (${item.reason}, ${item.mapCount} maps)`);
    });
  }

  if (steps.length) {
    rows.push("Steps:");
    steps.forEach((step) => {
      rows.push(`- [${cleanupStepStatus(step)}] ${step.label || step.id}: ${step.summary || ""}`.trim());
    });
  }

  return (
    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "'Menlo', 'Consolas', 'Courier New', monospace", fontSize: 12, lineHeight: 1.6 }}>
      {rows.join("\n")}
    </pre>
  );
}

export function registrableDomain(siteKey) {
  let hostname;
  try {
    hostname = new URL(siteKey).hostname.toLowerCase();
  } catch {
    hostname = String(siteKey || "").toLowerCase().split("/")[0].split("?")[0].split("#")[0];
  }
  if (!hostname) return siteKey || "";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith("[")) return hostname;
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

export function groupPagesByDomain(pages) {
  const buckets = {};
  pages.forEach((page) => {
    const siteKey = page.siteKey || i18nMessage("commonUnknown");
    if (!buckets[siteKey]) {
      buckets[siteKey] = { siteKey, pages: [], versionCount: 0, mapCount: 0, byteSize: 0, lastSeenAt: null };
    }
    buckets[siteKey].pages.push(page);
    page.versions.forEach((version) => {
      buckets[siteKey].versionCount += 1;
      buckets[siteKey].mapCount += Number(version.mapCount) || 0;
      buckets[siteKey].byteSize += Number(version.byteSize) || 0;
    });
    const pageLastSeenAt = page.versions[0]?.lastSeenAt;
    if (!buckets[siteKey].lastSeenAt || new Date(pageLastSeenAt) > new Date(buckets[siteKey].lastSeenAt)) {
      buckets[siteKey].lastSeenAt = pageLastSeenAt;
    }
  });
  return Object.values(buckets)
    .map((b) => {
      /* c8 ignore next */
      b.pages.sort((a, c) => new Date(c.versions[0]?.lastSeenAt || 0) - new Date(a.versions[0]?.lastSeenAt || 0));
      return b;
    })
    /* c8 ignore next */
    .sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
}

// Ten hues evenly distributed across the wheel for maximum distinctiveness
// (azure, amber, sage, violet, coral, chartreuse, teal, indigo, lime, mauve)
const DOMAIN_HUES = [210, 35, 145, 290, 5, 65, 180, 250, 105, 320];

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Build a unified color map for siteKeys and their registrable domains.
 * Each eTLD+1 gets a unique hue family; subdomains within the same family
 * share the hue but vary in lightness. Returns { [siteKey]: hex, [domain]: hex }.
 */
export function buildColorMap(siteKeys) {
  const domainGroups = new Map();
  siteKeys.forEach((key) => {
    const rd = registrableDomain(key);
    if (!domainGroups.has(rd)) domainGroups.set(rd, []);
    domainGroups.get(rd).push(key);
  });
  const sortedDomains = Array.from(domainGroups.keys()).sort();
  const colorMap = {};
  sortedDomains.forEach((domain, di) => {
    const hue = DOMAIN_HUES[di % DOMAIN_HUES.length];
    colorMap[domain] = hslToHex(hue, 48, 52);
    domainGroups.get(domain).slice().sort().forEach((key, ki) => {
      colorMap[key] = hslToHex(hue, 48, 48 + (ki % 4) * 7);
    });
  });
  return colorMap;
}
