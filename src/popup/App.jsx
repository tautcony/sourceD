import { useState, useEffect, useCallback, useMemo } from "react";
import { Button, Space, Tooltip, Typography, Tree, Empty, Spin, Flex, ConfigProvider, Switch, theme } from "antd";
import { DownloadOutlined, HistoryOutlined, DeleteOutlined, GithubOutlined, InfoCircleOutlined } from "@ant-design/icons";
import {
  fileSizeIEC,
  hostnameFromUrl,
  i18nMessage,
  isHostnameFiltered,
  normalizeDomainFilterList,
  parseFileName,
  sanitizeFilename,
  setI18nLocale,
  uiLocale,
} from "../shared/utils.mjs";
import enMessages from "../../_locales/en/messages.json";
import zhCNMessages from "../../_locales/zh_CN/messages.json";
import { buildMapTree, toAntdTreeData } from "../shared/tree-utils.jsx";
import { runtimeMessageError } from "../shared/runtime-utils.js";
import { parseSourceMap, downloadGroup } from "./sourcemap.mjs";

const { Text, Link: AntLink } = Typography;
const REPOSITORY_URL = "https://github.com/tautcony/sourceD";

export default function PopupApp() {
  const [loading, setLoading] = useState(true);
  const [pageUrl, setPageUrl] = useState(null);
  const [latestVersion, setLatestVersion] = useState(null);
  const [files, setFiles] = useState([]);
  const [totalStorageBytes, setTotalStorageBytes] = useState(0);
  const [totalVersions, setTotalVersions] = useState(0);
  const [detectionEnabled, setDetectionEnabled] = useState(true);
  const [ignoredDomains, setIgnoredDomains] = useState([]);
  const [togglingDetection, setTogglingDetection] = useState(false);

  const loadState = useCallback(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      const url = tab?.url || "";
      chrome.runtime.sendMessage({ action: "getPopupState", pageUrl: url }, (data) => {
        const err = runtimeMessageError();
        const effectiveLang = uiLocale(data?.ok ? data.settings : null);
        setI18nLocale(effectiveLang === "zh-CN" ? zhCNMessages : enMessages);
        setLoading(false);
        setPageUrl(url);
        if (err) {
          console.error("[SourceD] getPopupState failed:", err);
          setLatestVersion(null);
          setFiles([]);
          return;
        }
        if (!data?.ok) {
          if (data?.error) console.error("[SourceD] getPopupState returned error:", data.error);
          setLatestVersion(null);
          setFiles([]);
          return;
        }
        setLatestVersion(data.latestVersion);
        setFiles(data.files || []);
        setTotalStorageBytes(data.totalStorageBytes || 0);
        setTotalVersions(data.totalVersions || 0);
        setDetectionEnabled(data.settings?.detectionEnabled !== false);
        setIgnoredDomains(normalizeDomainFilterList(data.settings?.ignoredDomains));
      });
    });
  }, []);

  useEffect(() => { loadState(); }, [loadState]);

  const handleFileSelect = useCallback((_, info) => {
    const key = info.node.key;
    /* c8 ignore next */
    if (!key.startsWith("file-") || !latestVersion) return;
    const fileUrl = key.slice(5);
    const file = files.find((f) => f.url === fileUrl);
    /* c8 ignore next */
    if (!file) return;
    parseSourceMap(sanitizeFilename(parseFileName(fileUrl)), file.content)
      .catch((err) => console.error("[SourceD] download error:", err));
  }, [files, latestVersion]);

  const handleDownloadAll = useCallback(() => {
    /* c8 ignore next */
    if (!files.length) return;
    downloadGroup(files)
      .catch((err) => console.error("[SourceD] batch download error:", err));
  }, [files]);

  const handleClearCurrentPage = useCallback(() => {
    /* c8 ignore next */
    if (!pageUrl || !latestVersion) return;
    chrome.runtime.sendMessage({ action: "deletePageHistory", pageUrl }, () => {
      setLoading(true);
      loadState();
    });
  }, [pageUrl, latestVersion, loadState]);

  const handleOpenHistory = useCallback(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  }, []);

  const handleOpenRepository = useCallback(() => {
    chrome.tabs.create({ url: REPOSITORY_URL });
  }, []);

  const handleToggleDetection = useCallback((checked) => {
    setTogglingDetection(true);
    chrome.runtime.sendMessage({
      action: "updateSettings",
      settings: { detectionEnabled: checked },
    }, (resp) => {
      setTogglingDetection(false);
      if (resp?.ok) {
        setDetectionEnabled(resp.settings?.detectionEnabled !== false);
      }
    });
  }, []);

  const currentHostname = useMemo(() => hostnameFromUrl(pageUrl), [pageUrl]);
  const currentDomainIgnored = useMemo(
    () => isHostnameFiltered(currentHostname, ignoredDomains),
    [currentHostname, ignoredDomains],
  );

  const handleUpdateDomainFilter = useCallback((nextIgnoredDomains) => {
    chrome.runtime.sendMessage({
      action: "updateSettings",
      settings: { ignoredDomains: nextIgnoredDomains },
    }, (resp) => {
      const err = runtimeMessageError();
      if (err) {
        console.error("[SourceD] updateSettings failed:", err);
        return;
      }
      if (resp?.ok) {
        setIgnoredDomains(normalizeDomainFilterList(resp.settings?.ignoredDomains));
      }
    });
  }, []);

  const handleAddCurrentDomain = useCallback(() => {
    if (!currentHostname) return;
    handleUpdateDomainFilter(normalizeDomainFilterList([...ignoredDomains, currentHostname]));
  }, [currentHostname, handleUpdateDomainFilter, ignoredDomains]);

  const handleRemoveCurrentDomain = useCallback(() => {
    if (!currentHostname) return;
    handleUpdateDomainFilter(ignoredDomains.filter((domain) => domain !== currentHostname));
  }, [currentHostname, handleUpdateDomainFilter, ignoredDomains]);

  const treeData = useMemo(() => {
    if (!files.length) return [];
    return toAntdTreeData(buildMapTree(files));
  }, [files]);

  const statsTooltip = useMemo(() => {
    return [
      i18nMessage("popupStoredVersions", [String(totalVersions)]),
      i18nMessage("popupStorageUsed", [fileSizeIEC(totalStorageBytes)]),
    ].join("\n");
  }, [totalVersions, totalStorageBytes]);

  return (
    <ConfigProvider theme={{
      algorithm: theme.compactAlgorithm,
      token: { fontSize: 13 },
    }}>
      <style>{`
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
      <Flex vertical style={{ minHeight: 300, maxHeight: 620, overflow: "hidden", minWidth: 560, maxWidth: 840 }}>
        {/* Header */}
        <Flex
          justify="space-between"
          align="flex-start"
          gap={16}
          style={{ padding: "14px 14px 12px", borderBottom: "1px solid #dde4ec", background: "#fafbfc" }}
        >
          <Flex vertical gap={4} style={{ minWidth: 0, flex: 1 }}>
            <Flex align="center" gap={8}>
              <Text strong style={{ fontSize: 18, letterSpacing: "-0.025em", lineHeight: 1.1 }}>
                {i18nMessage("popupHeaderTitle")}
              </Text>
              <Tooltip title={<pre style={{ margin: 0, fontFamily: "inherit" }}>{statsTooltip}</pre>}>
                <InfoCircleOutlined style={{ color: "#8c8c8c", fontSize: 14, cursor: "help" }} />
              </Tooltip>
            </Flex>
            {currentHostname ? (
              <Flex align="center" gap={8} wrap="wrap">
                <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.35 }}>
                  {i18nMessage("popupCurrentDomain", [currentHostname])}
                </Text>
                <Button size="small" onClick={currentDomainIgnored ? handleRemoveCurrentDomain : handleAddCurrentDomain}>
                  {currentDomainIgnored ? i18nMessage("popupRemoveDomainFilter") : i18nMessage("popupAddDomainFilter")}
                </Button>
              </Flex>
            ) : null}
          </Flex>
          <Flex vertical gap={10} style={{ flexShrink: 0, minWidth: 0, alignItems: "flex-end" }}>
            <Flex
              align="center"
              gap={10}
              style={{
                padding: "8px 10px",
                background: "#fff",
                border: "1px solid #dde4ec",
              }}
            >
              <Text type="secondary" style={{ fontSize: 13, lineHeight: 1 }}>
                {i18nMessage("popupDetectionToggle")}
              </Text>
              <Switch checked={detectionEnabled} loading={togglingDetection} onChange={handleToggleDetection} />
            </Flex>
            <Space size="middle">
              <Tooltip title={i18nMessage("popupOpenGithub")}>
                <Button
                  size="middle"
                  aria-label={i18nMessage("popupOpenGithub")}
                  icon={<GithubOutlined />}
                  onClick={handleOpenRepository}
                  style={{ width: 34, minWidth: 34, height: 34, paddingInline: 0 }}
                />
              </Tooltip>
              <Button size="middle" icon={<HistoryOutlined />} onClick={handleOpenHistory} style={{ minWidth: 96, height: 34 }}>
                {i18nMessage("popupOpenHistory")}
              </Button>
              <Button size="middle" icon={<DeleteOutlined />} onClick={handleClearCurrentPage} disabled={!latestVersion} style={{ minWidth: 132, height: 34 }}>
                {i18nMessage("popupClearButton")}
              </Button>
            </Space>
          </Flex>
        </Flex>

        {/* Body */}
        <Flex vertical flex={1} style={{ overflow: "auto", padding: "0 14px 10px" }}>
          {loading ? (
            <Flex justify="center" align="center" flex={1} style={{ padding: 28 }}>
              <Spin description={i18nMessage("popupLoading")} />
            </Flex>
          ) : !latestVersion ? (
            <Empty
              style={{ padding: "20px 0" }}
              description={
                <Flex vertical gap={4}>
                  <Text>{i18nMessage("popupEmptyTitle")}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{i18nMessage("popupEmptyHint")}</Text>
                </Flex>
              }
            />
          ) : (
            <Flex vertical gap={8} style={{ paddingTop: 10 }}>
              <Flex justify="space-between" align="center">
                <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
                  <AntLink href={pageUrl} target="_blank" rel="noopener noreferrer" ellipsis style={{ fontSize: 12 }}>
                    {pageUrl}
                  </AntLink>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {i18nMessage("popupLatestVersion", [latestVersion.label])}
                  </Text>
                </Flex>
                <Button type="primary" icon={<DownloadOutlined />} onClick={handleDownloadAll} style={{ flexShrink: 0 }}>
                  {i18nMessage("popupDownloadAll")}
                </Button>
              </Flex>
              <Tree
                showIcon
                blockNode
                defaultExpandAll
                treeData={treeData}
                onSelect={handleFileSelect}
                style={{ fontSize: 12, width: "100%", minWidth: 0, overflow: "hidden" }}
              />
            </Flex>
          )}
        </Flex>
      </Flex>
    </ConfigProvider>
  );
}
