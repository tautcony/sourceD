import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Button, Space, Typography, Empty, Spin, Flex, ConfigProvider,
  Card, Collapse, Statistic, Tag, Tabs, App,
} from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import {
  ReloadOutlined, DeleteOutlined,
  GlobalOutlined, ClockCircleOutlined, ClearOutlined, UploadOutlined,
} from "@ant-design/icons";
import {
  i18nMessage,
  fileSizeIEC,
  uiLocale,
  setI18nLocale,
} from "../shared/utils.mjs";
import enMessages from "../../_locales/en/messages.json";
import zhCNMessages from "../../_locales/zh_CN/messages.json";
import { runtimeMessageError } from "../shared/runtime-utils.js";
import DistributionChart from "./DistributionChart.jsx";
import VersionPanel, { versionFilesCache } from "./VersionPanel.jsx";
import SettingsSection from "./SettingsSection.jsx";
import ImportMapsModal from "./ImportMapsModal.jsx";
import {
  formatShortDate,
  formatVersionTime,
  groupPagesByDomain,
  renderCleanupSummary,
} from "./helpers.jsx";

const { Title, Text } = Typography;
const defaultDashboardSettings = {
  retentionDays: 30,
  maxVersionsPerPage: 10,
  autoCleanup: true,
  detectionEnabled: true,
  sizeDisplayMode: "uncompressed",
  ignoredDomains: [],
  fetchDelayMs: 300,
  fetchTimeoutMs: 30_000,
  maxMapBytes: 50 * 1024 * 1024,
  uiLanguage: "auto",
};

function dashboardStorageTotals(data) {
  const pages = Array.isArray(data?.pages) ? data.pages : [];
  return pages.reduce((totals, page) => {
    const versions = Array.isArray(page?.versions) ? page.versions : [];
    versions.forEach((version) => {
      totals.rawByteSize += Number(version?.rawByteSize ?? version?.byteSize) || 0;
      totals.storedByteSize += Number(version?.storedByteSize ?? version?.byteSize) || 0;
    });
    return totals;
  }, { rawByteSize: 0, storedByteSize: 0 });
}

function DashboardContent() {
  const { message, modal } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pages, setPages] = useState([]);
  const [distribution, setDistribution] = useState([]);
  const [settings, setSettings] = useState(null);
  const [totalVersions, setTotalVersions] = useState(0);
  const [totalStorageBytes, setTotalStorageBytes] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [activePageTabs, setActivePageTabs] = useState({});
  const [expandedDomainKeys, setExpandedDomainKeys] = useState([]);
  const historyCardRef = useRef(null);
  const hasLoadedDashboardRef = useRef(false);

  const applyDashboardData = useCallback((data) => {
    versionFilesCache.clear();
    setPages(data?.pages || []);
    setDistribution(data?.distribution || []);
    setSettings(data?.settings || defaultDashboardSettings);
    setTotalVersions(data?.totalVersions || 0);
    setTotalStorageBytes(data?.totalStorageBytes || 0);
  }, []);

  const loadData = useCallback((options = {}) => {
    const preserveContent = options.preserveContent ?? hasLoadedDashboardRef.current;
    if (preserveContent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    chrome.runtime.sendMessage({ action: "getDashboardData" }, (data) => {
      hasLoadedDashboardRef.current = true;
      // Set locale synchronously before state updates so that i18nMessage()
      // calls during the triggered re-render already see the correct locale.
      const s = data?.settings || defaultDashboardSettings;
      const totals = dashboardStorageTotals(data);
      const lang = s.uiLanguage;
      const zh = lang === "zh-CN" || (lang !== "en-US" && /^zh\b/i.test(chrome.i18n.getUILanguage() || "en"));
      setI18nLocale(zh ? zhCNMessages : enMessages);
      console.info("[SourceD] dashboard storage totals:", {
        sizeDisplayMode: s.sizeDisplayMode || "uncompressed",
        rawByteSize: totals.rawByteSize,
        storedByteSize: totals.storedByteSize,
        displayedByteSize: Number(data?.totalStorageBytes) || 0,
      });
      setLoading(false);
      setRefreshing(false);
      applyDashboardData(data);
    });
  }, [applyDashboardData]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const effectiveLocale = useMemo(() => uiLocale(settings), [settings]);

  const uiLang = settings?.uiLanguage;
  const useZhCN = uiLang === "zh-CN" || (uiLang !== "en-US" && /^zh\b/i.test(chrome.i18n.getUILanguage() || "en"));

  const antdLocale = useMemo(() => useZhCN ? zhCN : enUS, [useZhCN]);

  useEffect(() => {
    document.documentElement.lang = useZhCN ? "zh-CN" : "en";
    setI18nLocale(useZhCN ? zhCNMessages : enMessages);
    document.title = i18nMessage("dashboardPageTitle");
  }, [useZhCN]);

  const [cleaning, setCleaning] = useState(false);
  const handleCleanup = useCallback(() => {
    setCleaning(true);
    chrome.runtime.sendMessage({ action: "cleanupData" }, (resp) => {
      setCleaning(false);
      const err = runtimeMessageError();
      if (err) {
        console.error("[SourceD] cleanupData message failed:", err);
        modal.error({
          title: "Storage Cleanup Failed",
          content: renderCleanupSummary({ ok: false, error: err.message, steps: [] }, "Cleanup failed"),
          width: 720,
        });
        return;
      }
      const steps = Array.isArray(resp?.steps) ? resp.steps : [];

      if (!resp?.ok) {
        modal.error({
          title: "Storage Cleanup Failed",
          content: renderCleanupSummary(resp, "Cleanup failed"),
          width: 720,
        });
        return;
      } else {
        const details = (resp.cleaned || []).map((v) => `${v.pageUrl} (${v.reason}, ${v.mapCount} maps)`).join("\n");
        const stats = resp.stats || {};
        const reclaimedBytes = Number(stats.reclaimedBytes) || 0;
        const removedVersions = Number(stats.removedVersions) || 0;
        const removedMaps = Number(stats.removedMaps) || 0;
        const changed = reclaimedBytes > 0 || removedVersions > 0 || removedMaps > 0 || (resp.cleaned || []).length > 0;

        modal.info({
          title: changed ? "Storage Cleanup Completed" : "Storage Cleanup Checked",
          content: renderCleanupSummary(resp, "Cleanup failed"),
          width: 720,
        });

        if (details) {
          console.info("[SourceD] Cleaned versions:\n" + details);
        }
        if (steps.length) {
          console.info("[SourceD] Cleanup steps:\n" + steps.map((step) => {
            const status = step.ok === false ? "FAILED" : step.changed ? "CHANGED" : "OK";
            return `${status} ${step.label || step.id}: ${step.summary || ""}`.trim();
          }).join("\n"));
        }

        loadData();
      }
    });
  }, [loadData, modal]);

  const groups = useMemo(() => groupPagesByDomain(pages), [pages]);

  const stopHeaderAction = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleDeleteVersion = useCallback((event, versionId) => {
    stopHeaderAction(event);
    chrome.runtime.sendMessage({ action: "deleteVersion", versionId }, () => {
      loadData({ preserveContent: true });
    });
  }, [loadData, stopHeaderAction]);

  const handleDeletePage = useCallback((event, pageUrl) => {
    stopHeaderAction(event);
    chrome.runtime.sendMessage({ action: "deletePageHistory", pageUrl }, () => {
      loadData({ preserveContent: true });
    });
  }, [loadData, stopHeaderAction]);

  const handleDeleteSite = useCallback((event, siteKey) => {
    stopHeaderAction(event);
    chrome.runtime.sendMessage({ action: "deleteSiteHistory", siteKey }, () => {
      loadData({ preserveContent: true });
    });
  }, [loadData, stopHeaderAction]);

  const handleImportMaps = useCallback((payload) => {
    setImporting(true);
    chrome.runtime.sendMessage({
      action: "importSourceMaps",
      pageUrl: payload.pageUrl,
      title: payload.title,
      files: payload.files,
    }, (resp) => {
      setImporting(false);
      if (!resp?.ok) {
        message.error(resp?.error || "Import failed");
        return;
      }

      const rejectedCount = Array.isArray(resp.rejectedFiles) ? resp.rejectedFiles.length : 0;
      const importedCount = Number(resp.importedCount) || 0;
      const summary = resp.reusedExisting
        ? i18nMessage("dashboardImportResultReused", [String(importedCount)])
        : i18nMessage("dashboardImportResultCreated", [String(importedCount)]);

      const detail = rejectedCount
        ? `${summary} · ${i18nMessage("dashboardImportResultRejected", [String(rejectedCount)])}`
        : summary;

      message.success(detail);
      setImportOpen(false);
      loadData({ preserveContent: true });
    });
  }, [loadData, message]);

  const handlePageTabChange = useCallback((siteKey, pageUrl) => {
    setActivePageTabs((current) => {
      if (current[siteKey] === pageUrl) return current;
      return { ...current, [siteKey]: pageUrl };
    });
  }, []);

  const domainCollapseItems = useMemo(() => {
    return groups.map((group) => ({
      key: group.siteKey,
      label: (
        <div data-site-key={group.siteKey}>
        <Flex justify="space-between" align="center" style={{ overflow: "hidden" }}>
          <Flex vertical gap={2} style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
            <Flex align="center" gap={8} style={{ minWidth: 0 }}>
              <GlobalOutlined style={{ flexShrink: 0 }} />
              <Text strong ellipsis={{ tooltip: group.siteKey }}>{group.siteKey}</Text>
            </Flex>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {[i18nMessage("dashboardDistributionVersions", [String(group.versionCount)]), i18nMessage("dashboardDistributionMaps", [String(group.mapCount)]), fileSizeIEC(group.byteSize || 0)].join(" · ")}
            </Text>
          </Flex>
          <Flex align="center" gap={8} style={{ flexShrink: 0, marginLeft: 12 }}>
            <Tag color="blue">{group.versionCount}</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {i18nMessage("dashboardLastUpdated", [formatShortDate(group.lastSeenAt, effectiveLocale)])}
            </Text>
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              title={i18nMessage("dashboardDeleteVersion")}
              aria-label={i18nMessage("dashboardDeleteVersion")}
              onClick={(event) => handleDeleteSite(event, group.siteKey)}
            />
          </Flex>
        </Flex>
        </div>
      ),
      children: (
        <Tabs
          size="small"
          activeKey={activePageTabs[group.siteKey] || group.pages[0]?.pageUrl}
          onChange={(pageUrl) => handlePageTabChange(group.siteKey, pageUrl)}
          items={group.pages.map((page) => ({
            key: page.pageUrl,
            label: (
              <Flex align="center" gap={8} style={{ minWidth: 0, maxWidth: 320 }}>
                {/* c8 ignore next 2 */}
                <Text strong ellipsis={{ tooltip: page.title || page.pageUrl }} style={{ minWidth: 0 }}>
                  {page.title || page.pageUrl}
                </Text>
                <Tag style={{ flexShrink: 0, marginInlineEnd: 0 }}>{page.versions.length}</Tag>
              </Flex>
            ),
            children: (
              <Flex vertical gap={12} style={{ paddingTop: 4 }}>
                <Flex
                  justify="space-between"
                  align="center"
                  gap={12}
                  style={{ minWidth: 0 }}
                  data-page-panel={page.pageUrl}
                >
                  <Flex vertical gap={2} style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
                    {/* c8 ignore next 2 */}
                    <Text strong ellipsis={{ tooltip: page.title || page.pageUrl }}>{page.title || page.pageUrl}</Text>
                    <Text type="secondary" ellipsis={{ tooltip: page.pageUrl }} style={{ fontSize: 12 }}>
                      {page.pageUrl}
                    </Text>
                  </Flex>
                  <Flex align="center" gap={8} style={{ flexShrink: 0, marginLeft: 12 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {i18nMessage("dashboardLastUpdated", [formatShortDate(page.versions[0]?.lastSeenAt, effectiveLocale)])}
                    </Text>
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      title={i18nMessage("dashboardDeleteVersion")}
                      aria-label={i18nMessage("dashboardDeleteVersion")}
                      onClick={(event) => handleDeletePage(event, page.pageUrl)}
                    />
                  </Flex>
                </Flex>
                <Collapse
                  size="small"
                  items={page.versions.map((version) => ({
                    key: version.id,
                    label: (
                      <Flex justify="space-between" align="center" style={{ overflow: "hidden" }}>
                        <Flex align="center" gap={8} style={{ minWidth: 0, flex: 1 }}>
                          <ClockCircleOutlined style={{ flexShrink: 0 }} />
                          <Text ellipsis={{ tooltip: version.label }}>{version.label}</Text>
                        </Flex>
                        <Flex gap={4} wrap="wrap" style={{ flexShrink: 0, marginLeft: 8 }}>
                          <Tag>{i18nMessage("dashboardCapturedAt", [formatVersionTime(version.createdAt, effectiveLocale)])}</Tag>
                          <Tag>{i18nMessage("dashboardMapCount", [String(version.mapCount || 0)])}</Tag>
                          <Button
                            size="small"
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            title={i18nMessage("dashboardDeleteVersion")}
                            aria-label={i18nMessage("dashboardDeleteVersion")}
                            onClick={(event) => handleDeleteVersion(event, version.id)}
                          />
                        </Flex>
                      </Flex>
                    ),
                    children: <VersionPanel version={version} sizeMode={settings?.sizeDisplayMode ?? "uncompressed"} />,
                  }))}
                />
              </Flex>
            ),
          }))}
        />
      ),
    }));
  }, [activePageTabs, groups, handleDeletePage, handleDeleteSite, handleDeleteVersion, handlePageTabChange, effectiveLocale, settings]);

  const handleLegendClick = useCallback((siteKey) => {
    setExpandedDomainKeys((prev) => {
      if (prev.includes(siteKey)) return prev;
      return [...prev, siteKey];
    });
    setTimeout(() => {
      const el = document.querySelector(`[data-site-key="${CSS.escape(siteKey)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 100);
  }, []);

  const handleCollapseChange = useCallback((keys) => {
    setExpandedDomainKeys(keys);
  }, []);

  return (
    <ConfigProvider theme={{ token: { fontSize: 13 } }} locale={antdLocale}>
        <style>{`
          .ant-collapse-header { overflow: hidden; }
          .ant-collapse-header-text { overflow: hidden; min-width: 0; flex: 1; }
          .ant-tree { width: 100%; min-width: 0; overflow: hidden; }
          .ant-tree-list,
          .ant-tree-list-holder,
          .ant-tree-list-holder-inner { width: 100%; min-width: 0; overflow: hidden; }
          .ant-tree .ant-tree-treenode { display: flex; align-items: center; width: 100%; min-width: 0; white-space: nowrap; }
          .ant-tree-node-content-wrapper { display: flex !important; align-items: center; flex: 1 1 auto; min-width: 0; max-width: 100%; overflow: hidden; }
          .ant-tree-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; width: 100%; }
          .ant-tree-list-holder-inner .ant-tree-treenode .ant-tree-switcher { flex: 0 0 auto; }
          .ant-tree-list-holder-inner .ant-tree-treenode .ant-tree-iconEle { flex: 0 0 auto; }
        `}</style>
        <Flex vertical gap={24} style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
        {/* Hero */}
        <Flex justify="space-between" align="flex-start">
          <Flex vertical gap={4}>
            <Text type="secondary">{i18nMessage("dashboardEyebrow")}</Text>
            <Title level={2} style={{ margin: 0 }}>{i18nMessage("dashboardTitle")}</Title>
            <Text type="secondary">{i18nMessage("dashboardLead")}</Text>
          </Flex>
          <Space>
            <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
              {i18nMessage("dashboardImportAction")}
            </Button>
            <Button icon={<ClearOutlined />} onClick={handleCleanup} loading={cleaning}>
              {i18nMessage("dashboardCleanup")}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => loadData({ preserveContent: true })} loading={refreshing}>
              {i18nMessage("dashboardRefresh")}
            </Button>
          </Space>
        </Flex>

        {/* Summary cards */}
        <Flex gap={16}>
          <Card size="small" style={{ flex: 1 }}>
            <Statistic title={i18nMessage("dashboardTotalPages")} value={pages.length} />
          </Card>
          <Card size="small" style={{ flex: 1 }}>
            <Statistic title={i18nMessage("dashboardTotalVersions")} value={totalVersions} />
          </Card>
          <Card size="small" style={{ flex: 1 }}>
            <Statistic title={i18nMessage("dashboardTotalStorage")} value={fileSizeIEC(totalStorageBytes)} />
          </Card>
        </Flex>

        {/* History */}
        <Card
          title={i18nMessage("dashboardHistoryTitle")}
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{i18nMessage("dashboardHistoryCopy")}</Text>}
        >
          {loading ? (
            <Flex justify="center" style={{ padding: 40 }}><Spin /></Flex>
          ) : !pages.length ? (
            <Empty description={i18nMessage("dashboardEmptyHistory")} />
          ) : (
            <Collapse activeKey={expandedDomainKeys} onChange={handleCollapseChange} items={domainCollapseItems} />
          )}
        </Card>

        {/* Distribution */}
        <Card
          title={i18nMessage("dashboardDistributionTitle")}
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{i18nMessage("dashboardDistributionCopy")}</Text>}
        >
          {loading ? (
            <Flex justify="center" style={{ padding: 40 }}><Spin /></Flex>
          ) : !distribution.length ? (
            <Empty description={i18nMessage("dashboardEmptyDistribution")} />
          ) : (
            <DistributionChart items={distribution} onLegendClick={handleLegendClick} />
          )}
        </Card>

        {/* Settings */}
        <Card
          title={i18nMessage("dashboardSettingsTitle")}
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{i18nMessage("dashboardSettingsCopy")}</Text>}
        >
          <SettingsSection settings={settings} onReload={loadData} />
        </Card>
        <ImportMapsModal
          open={importOpen}
          importing={importing}
          onCancel={() => setImportOpen(false)}
          onImport={handleImportMaps}
        />
      </Flex>
      </ConfigProvider>
  );
}

export default function DashboardApp() {
  return (
    <App>
      <DashboardContent />
    </App>
  );
}
