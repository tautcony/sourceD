import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Button, Space, Typography, Tree, Empty, Spin, Flex, Drawer, Alert } from "antd";
import { DownloadOutlined, EyeOutlined, FolderOutlined, FileTextOutlined } from "@ant-design/icons";
import { fileSizeIEC, i18nMessage } from "../../shared/utils.mjs";
import { buildMapTree, toAntdTreeData } from "../../shared/tree-utils.jsx";
import { downloadGroup, versionZipBaseName, extractSourceFiles } from "../../popup/sourcemap.mjs";
import { runtimeMessageError } from "../../shared/runtime-utils.js";
import CodePreview from "./CodePreview.jsx";

const { Text } = Typography;

export const versionFilesCache = new Map();
const VERSION_FILES_CACHE_MAX = 5;
const EXPAND_ALL_MAP_FILES_LIMIT = 50;
const EXPAND_ALL_SOURCE_FILES_LIMIT = 200;

function versionFilesCacheKey(versionId, sizeMode) {
  return `${versionId}::${sizeMode === "compressed" ? "compressed" : "uncompressed"}`;
}

function cacheVersionFiles(versionId, sizeMode, data) {
  const cacheKey = versionFilesCacheKey(versionId, sizeMode);
  if (versionFilesCache.size >= VERSION_FILES_CACHE_MAX) {
    const firstKey = versionFilesCache.keys().next().value;
    versionFilesCache.delete(firstKey);
  }
  versionFilesCache.set(cacheKey, { files: data.files, failedMapUrls: data.failedMapUrls || [] });
}

function buildSourceTree(sourceFiles) {
  const root = { folders: {}, files: [] };
  sourceFiles.forEach(({ path, content }) => {
    const parts = path.split("/").filter(Boolean);
    /* c8 ignore next */
    if (!parts.length) return;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.folders[parts[i]]) {
        node.folders[parts[i]] = { name: parts[i], folders: {}, files: [] };
      }
      node = node.folders[parts[i]];
    }
    node.files.push({ name: parts[parts.length - 1], path, content, size: content.length });
  });
  return root;
}

/**
 * Compact a single-child folder chain into one node.
 * e.g. src/ → main/ → java/ (each with no files) becomes "src/main/java".
 * Stops when a folder has multiple children or contains files.
 */
function compactFolderChain(name, folder, fullPath) {
  const subNames = Object.keys(folder.folders);
  if (subNames.length === 1 && folder.files.length === 0) {
    const child = subNames[0];
    return compactFolderChain(`${name}/${child}`, folder.folders[child], fullPath + child + "/");
  }
  return { displayName: name, node: folder, path: fullPath };
}

function toSourceTreeData(node, pathPrefix = "") {
  const children = [];
  for (const name of Object.keys(node.folders).sort()) {
    const folder = node.folders[name];
    const folderPath = pathPrefix + name + "/";
    const { displayName, node: compacted, path: compactedPath } = compactFolderChain(name, folder, folderPath);
    children.push({
      title: (
        <span title={displayName} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {displayName}
        </span>
      ),
      key: "sfolder-" + compactedPath,
      icon: <FolderOutlined />,
      children: toSourceTreeData(compacted, compactedPath),
      selectable: false,
    });
  }
  for (const file of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
    children.push({
      title: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0, maxWidth: "100%", whiteSpace: "nowrap", overflow: "hidden" }}>
          <span title={file.name} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{file.name}</span>
          <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>{fileSizeIEC(file.size)}</Text>
        </span>
      ),
      key: "sfile-" + file.path,
      icon: <FileTextOutlined />,
      isLeaf: true,
      _file: file,
    });
  }
  return children;
}

function limitedExpandedKeys(treeData, expandAll) {
  if (expandAll) return undefined;
  const keys = [];
  function collect(nodes) {
    for (const node of nodes) {
      if (!Array.isArray(node.children) || !node.children.length) continue;
      keys.push(node.key);
      // Follow single-child folder chains so the user sees meaningful content on first render
      if (node.children.length === 1 && !node.children[0].isLeaf) {
        collect(node.children);
      }
    }
  }
  collect(treeData);
  return keys;
}

export default function VersionPanel({ version, sizeMode = "uncompressed" }) {
  const [files, setFiles] = useState(null);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [failedMapUrls, setFailedMapUrls] = useState([]);
  const [retryingUrls, setRetryingUrls] = useState(new Set());
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewRenderKey, setPreviewRenderKey] = useState(0);

  const fullFilesRef = useRef(null);
  const sourceFilesRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingFiles(true);
    setFiles(null);
    setFailedMapUrls([]);
    setPreviewOpen(false);
    setSelectedFile(null);
    fullFilesRef.current = null;
    sourceFilesRef.current = null;

    const cacheKey = versionFilesCacheKey(version.id, sizeMode);
    if (versionFilesCache.has(cacheKey)) {
      if (!cancelled) {
        const cached = versionFilesCache.get(cacheKey);
        setLoadingFiles(false);
        setFiles(cached.files);
        setFailedMapUrls(cached.failedMapUrls);
      }
      return () => { cancelled = true; };
    }
    chrome.runtime.sendMessage({ action: "getVersionFiles", versionId: version.id, includeContent: false }, (resp) => {
      if (cancelled) return;
      const err = runtimeMessageError();
      if (err) {
        console.error("[SourceD] dashboard getVersionFiles failed:", version.id, err);
        setLoadingFiles(false);
        setFiles([]);
        return;
      }
      if (!resp?.ok) {
        console.error("[SourceD] dashboard getVersionFiles returned error:", version.id, resp?.error || "unknown error");
        setLoadingFiles(false);
        setFiles([]);
        return;
      }
      const nextFiles = resp.files || [];
      const nextFailed = resp.failedMapUrls || [];
      cacheVersionFiles(version.id, sizeMode, { files: nextFiles, failedMapUrls: nextFailed });
      setLoadingFiles(false);
      setFiles(nextFiles);
      setFailedMapUrls(nextFailed);
    });
    return () => { cancelled = true; };
  }, [version.id, version.mapCount, sizeMode]);

  useEffect(() => {
    fullFilesRef.current = null;
    sourceFilesRef.current = null;
  }, [files]);

  const ensureFullFiles = useCallback(() => {
    if (fullFilesRef.current?.length) return Promise.resolve(fullFilesRef.current);
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: "getVersionFiles", versionId: version.id, includeContent: true }, (resp) => {
        const err = runtimeMessageError();
        if (err) {
          console.error("[SourceD] dashboard full getVersionFiles failed:", version.id, err);
          reject(err);
          return;
        }
        if (!resp?.ok) {
          const nextError = new Error(resp?.error || "Failed to load version files");
          console.error("[SourceD] dashboard full getVersionFiles returned error:", version.id, nextError.message);
          reject(nextError);
          return;
        }
        fullFilesRef.current = resp.files || [];
        resolve(fullFilesRef.current);
      });
    });
  }, [version.id]);

  const handleDownload = useCallback(() => {
    /* c8 ignore next */
    if (!files?.length) return;
    ensureFullFiles()
      .then((nextFiles) => downloadGroup(nextFiles, null, versionZipBaseName(nextFiles, version)))
      .then(() => { fullFilesRef.current = null; })
      .catch((err) => console.error("[SourceD] version download failed:", err));
  }, [ensureFullFiles, files, version]);

  const handlePreview = useCallback(() => {
    /* c8 ignore next */
    if (!files?.length) return;
    setPreviewLoading(true);
    setPreviewOpen(true);
    ensureFullFiles().then((nextFiles) => {
      setTimeout(() => {
        const extracted = extractSourceFiles(nextFiles);
        sourceFilesRef.current = extracted;
        fullFilesRef.current = null;
        setPreviewRenderKey((k) => k + 1);
        setSelectedFile(null);
        setPreviewLoading(false);
      }, 0);
    }).catch((err) => {
      console.error("[SourceD] version preview file load failed:", err);
      setPreviewLoading(false);
      sourceFilesRef.current = [];
      setPreviewRenderKey((k) => k + 1);
      setSelectedFile(null);
    });
  }, [ensureFullFiles, files]);

  const handleClosePreview = useCallback(() => {
    setPreviewOpen(false);
    setSelectedFile(null);
    fullFilesRef.current = null;
    sourceFilesRef.current = null;
    setPreviewRenderKey((k) => k + 1);
  }, []);

  const handleRetryFetch = useCallback((mapUrl) => {
    setRetryingUrls((prev) => new Set([...prev, mapUrl]));
    chrome.runtime.sendMessage({ action: "retryMapFetch", versionId: version.id, mapUrl }, (resp) => {
      setRetryingUrls((prev) => { const s = new Set(prev); s.delete(mapUrl); return s; });
      if (resp?.ok) {
        setFailedMapUrls(resp.failedMapUrls || []);
        const cacheKey = versionFilesCacheKey(version.id, sizeMode);
        versionFilesCache.delete(cacheKey);
        chrome.runtime.sendMessage({ action: "getVersionFiles", versionId: version.id, includeContent: false }, (r) => {
          if (!r?.ok) return;
          const nextFiles = r.files || [];
          const nextFailed = r.failedMapUrls || [];
          cacheVersionFiles(version.id, sizeMode, { files: nextFiles, failedMapUrls: nextFailed });
          setFiles(nextFiles);
          setFailedMapUrls(nextFailed);
        });
      } else {
        console.error("[SourceD] retryMapFetch failed:", mapUrl, resp?.error);
      }
    });
  }, [version.id, sizeMode]);

  const handleDownloadMapFile = useCallback((url) => {
    ensureFullFiles().then((nextFiles) => {
      const file = nextFiles.find((f) => f.url === url);
      if (!file?.content) return;
      const blob = new Blob([file.content], { type: "application/json" });
      const objectUrl = URL.createObjectURL(blob);
      chrome.downloads.download({ url: objectUrl, filename: url.split("/").pop() || "source.map" }, () => {
        URL.revokeObjectURL(objectUrl);
      });
      fullFilesRef.current = null;
    }).catch((err) => console.error("[SourceD] map file download failed:", err));
  }, [ensureFullFiles]);

  const sourceTreeData = useMemo(() => {
    const srcFiles = sourceFilesRef.current;
    if (!srcFiles?.length) return [];
    return toSourceTreeData(buildSourceTree(srcFiles));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRenderKey]);

  const treeData = useMemo(() => {
    if (!files?.length) return [];
    return toAntdTreeData(buildMapTree(files), "", { onDownloadFile: handleDownloadMapFile });
  }, [files, handleDownloadMapFile]);

  const versionTreeExpandAll = (files?.length || 0) <= EXPAND_ALL_MAP_FILES_LIMIT;
  const versionTreeExpandedKeys = useMemo(
    () => limitedExpandedKeys(treeData, versionTreeExpandAll),
    [treeData, versionTreeExpandAll],
  );

  const sourceTreeExpandAll = (sourceFilesRef.current?.length || 0) <= EXPAND_ALL_SOURCE_FILES_LIMIT;
  const sourceTreeExpandedKeys = useMemo(
    () => limitedExpandedKeys(sourceTreeData, sourceTreeExpandAll),
    [sourceTreeData, sourceTreeExpandAll],
  );

  const sourceFileMap = useMemo(() => {
    const map = {};
    function walk(nodes) {
      for (const n of nodes) {
        if (n._file) map[n.key] = n._file;
        if (n.children) walk(n.children);
      }
    }
    walk(sourceTreeData);
    return map;
  }, [sourceTreeData]);

  const handleTreeSelect = useCallback((selectedKeys) => {
    /* c8 ignore next 2 */
    if (selectedKeys.length && sourceFileMap[selectedKeys[0]]) {
      setSelectedFile(sourceFileMap[selectedKeys[0]]);
    }
  }, [sourceFileMap]);

  useEffect(() => {
    return () => { setPreviewOpen(false); };
  }, []);

  if (loadingFiles) {
    return <Spin size="small" style={{ padding: 16 }} />;
  }

  if (!files?.length && !failedMapUrls?.length) {
    return <Empty description={i18nMessage("dashboardEmptyVersionFiles")} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <Flex vertical gap={8} style={{ padding: "8px 0" }}>
      <Flex justify="space-between" align="center">
        <Space>
          <Text type="secondary">{i18nMessage("dashboardVersionFiles", [String(files?.length || 0)])}</Text>
          <Text type="secondary">{fileSizeIEC(version.byteSize || 0)}</Text>
        </Space>
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={handlePreview} disabled={!files?.length}>
            {i18nMessage("dashboardPreviewSources")}
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={handleDownload} disabled={!files?.length}>
            {i18nMessage("dashboardDownloadVersion")}
          </Button>
        </Space>
      </Flex>
      {files?.length > 0 && (
        <Tree
          showIcon
          blockNode
          indent={16}
          defaultExpandAll={versionTreeExpandAll}
          defaultExpandedKeys={versionTreeExpandedKeys}
          treeData={treeData}
          style={{ fontSize: 12, width: "100%", minWidth: 0, overflow: "hidden" }}
        />
      )}
      {failedMapUrls?.length > 0 && (
        <Flex vertical gap={4}>
          {failedMapUrls.map((mapUrl) => (
            <Alert
              key={mapUrl}
              type="warning"
              showIcon
              style={{ fontSize: 12 }}
              message={i18nMessage("dashboardVersionFileFetchFailed", [mapUrl.split("/").pop() || mapUrl])}
              description={<Text type="secondary" style={{ fontSize: 11, wordBreak: "break-all" }}>{mapUrl}</Text>}
              action={
                <Button
                  size="small"
                  loading={retryingUrls.has(mapUrl)}
                  onClick={() => handleRetryFetch(mapUrl)}
                >
                  {i18nMessage("dashboardRetryFetch")}
                </Button>
              }
            />
          ))}
        </Flex>
      )}
      <Drawer
        title={i18nMessage("dashboardPreviewTitle")}
        open={previewOpen}
        onClose={handleClosePreview}
        destroyOnClose
        width="70vw"
        styles={{ body: { padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" } }}
      >
        {previewLoading ? (
          <Flex justify="center" align="center" style={{ height: "100%" }}>
            <Spin />
          </Flex>
        ) : sourceFilesRef.current && sourceFilesRef.current.length > 0 ? (
          <Flex style={{ height: "100%", overflow: "hidden" }}>
            <div style={{ width: 360, minWidth: 260, borderRight: "1px solid #f0f0f0", overflow: "auto", padding: "8px 0" }}>
              <Tree
                showIcon
                blockNode
                indent={16}
                defaultExpandAll={sourceTreeExpandAll}
                defaultExpandedKeys={sourceTreeExpandedKeys}
                treeData={sourceTreeData}
                onSelect={handleTreeSelect}
                style={{ fontSize: 12, width: "100%", minWidth: 0, overflow: "hidden" }}
              />
            </div>
            <div style={{ flex: 1, overflow: "hidden", padding: 0, display: "flex", flexDirection: "column" }}>
              {selectedFile ? (
                <Flex vertical gap={0} style={{ height: "100%", overflow: "hidden" }}>
                  <Flex justify="space-between" align="center" style={{ padding: "8px 12px", borderBottom: "1px solid #f0f0f0", background: "#fafafa", flexShrink: 0 }}>
                    <Text strong ellipsis={{ tooltip: selectedFile.path }} style={{ minWidth: 0, flex: 1 }}>
                      {selectedFile.path}
                    </Text>
                    <Text type="secondary" style={{ flexShrink: 0, marginLeft: 8, fontSize: 12 }}>
                      {fileSizeIEC(selectedFile.size)}
                    </Text>
                  </Flex>
                  <div style={{ flex: 1, overflow: "hidden" }}>
                    <CodePreview code={selectedFile.content} filename={selectedFile.name} />
                  </div>
                </Flex>
              ) : (
                <Empty description={i18nMessage("dashboardPreviewEmpty")} style={{ marginTop: 80 }} />
              )}
            </div>
          </Flex>
        ) : (
          <Empty description={i18nMessage("dashboardPreviewEmpty")} style={{ marginTop: 80 }} />
        )}
      </Drawer>
    </Flex>
  );
}
