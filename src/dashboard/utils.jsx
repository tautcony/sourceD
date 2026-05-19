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
