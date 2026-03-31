/* global chrome */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Button, Space, Typography, Tree, Empty, Spin, Flex, ConfigProvider, theme } from "antd";
import { DownloadOutlined, HistoryOutlined, DeleteOutlined, FolderOutlined, FileOutlined } from "@ant-design/icons";
import { i18nMessage, fileSizeIEC, parseFileName, sourceMapTreePath, sanitizeFilename } from "../shared/utils.mjs";
import { parseSourceMap, downloadGroup } from "./sourcemap.mjs";

const { Text, Link: AntLink } = Typography;

function buildMapTree(files) {
  const root = { folders: {}, files: [] };
  files.forEach((file) => {
    const parts = sourceMapTreePath(file.url);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.folders[parts[i]]) {
        node.folders[parts[i]] = { name: parts[i], folders: {}, files: [] };
      }
      node = node.folders[parts[i]];
    }
    node.files.push({
      name: parts[parts.length - 1],
      url: file.url,
      size: file.content.length,
    });
  });
  return root;
}

function toAntdTreeData(node) {
  const children = [];
  const folderNames = Object.keys(node.folders).sort();
  for (const name of folderNames) {
    const folder = node.folders[name];
    children.push({
      title: name,
      key: "folder-" + name + "-" + Math.random().toString(36).slice(2, 8),
      icon: <FolderOutlined />,
      children: toAntdTreeData(folder),
    });
  }
  const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  for (const file of sortedFiles) {
    children.push({
      title: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%" }}>
          <Text ellipsis={{ tooltip: file.url }} style={{ flex: 1, minWidth: 0 }}>{file.name}</Text>
          <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>{fileSizeIEC(file.size)}</Text>
        </span>
      ),
      key: "file-" + file.url,
      icon: <FileOutlined />,
      isLeaf: true,
    });
  }
  return children;
}

export default function PopupApp() {
  const [loading, setLoading] = useState(true);
  const [pageUrl, setPageUrl] = useState(null);
  const [latestVersion, setLatestVersion] = useState(null);
  const [files, setFiles] = useState([]);
  const [totalStorageBytes, setTotalStorageBytes] = useState(0);
  const [totalVersions, setTotalVersions] = useState(0);

  const loadState = useCallback(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      const url = tab?.url || "";
      chrome.runtime.sendMessage({ action: "getPopupState", pageUrl: url }, (data) => {
        setLoading(false);
        setPageUrl(url);
        if (!data?.ok) {
          setLatestVersion(null);
          setFiles([]);
          return;
        }
        setLatestVersion(data.latestVersion);
        setFiles(data.files || []);
        setTotalStorageBytes(data.totalStorageBytes || 0);
        setTotalVersions(data.totalVersions || 0);
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

  const treeData = useMemo(() => {
    if (!files.length) return [];
    return toAntdTreeData(buildMapTree(files));
  }, [files]);

  const statsText = useMemo(() => {
    return [
      i18nMessage("popupStoredVersions", [String(totalVersions)]),
      "·",
      i18nMessage("popupStorageUsed", [fileSizeIEC(totalStorageBytes)]),
    ].join(" ");
  }, [totalVersions, totalStorageBytes]);

  return (
    <ConfigProvider theme={{
      algorithm: theme.compactAlgorithm,
      token: { fontSize: 13 },
    }}>
      <Flex vertical style={{ minHeight: 300, maxHeight: 620, overflow: "hidden", minWidth: 560, maxWidth: 840 }}>
        {/* Header */}
        <Flex vertical gap={4} style={{ padding: "14px 18px 12px", borderBottom: "1px solid #dde4ec", background: "#fafbfc" }}>
          <Flex justify="space-between" align="center">
            <Text strong style={{ fontSize: 17, letterSpacing: "-0.02em" }}>
              {i18nMessage("popupHeaderTitle")}
            </Text>
            <Space size="small">
              <Button size="small" icon={<HistoryOutlined />} onClick={handleOpenHistory}>
                {i18nMessage("popupOpenHistory")}
              </Button>
              <Button size="small" icon={<DeleteOutlined />} onClick={handleClearCurrentPage} disabled={!latestVersion}>
                {i18nMessage("popupClearButton")}
              </Button>
            </Space>
          </Flex>
          <Text type="secondary" style={{ fontSize: 12 }}>{statsText}</Text>
        </Flex>

        {/* Body */}
        <Flex vertical flex={1} style={{ overflow: "auto", padding: "0 18px 14px" }}>
          {loading ? (
            <Flex justify="center" align="center" flex={1} style={{ padding: 40 }}>
              <Spin description={i18nMessage("popupLoading")} />
            </Flex>
          ) : !latestVersion ? (
            <Empty
              style={{ margin: "auto", padding: 40 }}
              description={
                <Flex vertical gap={4}>
                  <Text>{i18nMessage("popupEmptyTitle")}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{i18nMessage("popupEmptyHint")}</Text>
                </Flex>
              }
            />
          ) : (
            <Flex vertical gap={8} style={{ paddingTop: 12 }}>
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
                defaultExpandAll
                treeData={treeData}
                onSelect={handleFileSelect}
                style={{ fontSize: 12 }}
              />
            </Flex>
          )}
        </Flex>
      </Flex>
    </ConfigProvider>
  );
}
