import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Button, Space, Typography, Tree, Empty, Spin, Flex, ConfigProvider,
  Card, Collapse, Statistic, Form, InputNumber, Switch, Tag, App, Drawer, Input, Modal,
} from "antd";
import {
  ReloadOutlined, DownloadOutlined, DeleteOutlined,
  FolderOutlined, FileOutlined, GlobalOutlined,
  FileTextOutlined, ClockCircleOutlined, EyeOutlined, ClearOutlined, UploadOutlined,
} from "@ant-design/icons";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import json from "highlight.js/lib/languages/json";
import "highlight.js/styles/github.css";
import { i18nMessage, fileSizeIEC, sourceMapTreePath, uiLocale } from "../shared/utils.mjs";
import { downloadGroup, versionZipBaseName, extractSourceFiles } from "../popup/sourcemap.mjs";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("json", json);

const { Title, Text } = Typography;

function guessLanguage(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map = { js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", css: "css", scss: "css", less: "css", html: "xml", htm: "xml", svg: "xml", vue: "xml", json: "json" };
  return map[ext] || null;
}

function CodePreview({ code, filename }) {
  const codeRef = useRef(null);
  useEffect(() => {
    /* c8 ignore next */
    if (!codeRef.current || !code) return;
    /* c8 ignore next 2 */
    const lang = guessLanguage(filename
      || "");
    if (lang) {
      try {
        const result = hljs.highlight(code, { language: lang });
        codeRef.current.innerHTML = result.value;
      } catch {
        codeRef.current.textContent = code;
      }
    } else {
      codeRef.current.textContent = code;
    }
  }, [code, filename]);

  return (
    <pre style={{ margin: 0, padding: 12, overflow: "auto", fontSize: 12, lineHeight: 1.5, background: "#f6f8fa", borderRadius: 4, minHeight: 200, maxHeight: "calc(100vh - 200px)" }}>
      <code ref={codeRef} style={{ fontFamily: "'Menlo', 'Consolas', 'Courier New', monospace", whiteSpace: "pre" }} />
    </pre>
  );
}

function formatShortDate(iso) {
  if (!iso) return i18nMessage("commonUnknown");
  return new Date(iso).toLocaleDateString(uiLocale(), { month: "2-digit", day: "2-digit" });
}

function formatVersionTime(iso) {
  if (!iso) return i18nMessage("commonUnknown");
  return new Date(iso).toLocaleString(uiLocale(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

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

function toAntdTreeData(node, pathPrefix = "") {
  const children = [];
  for (const name of Object.keys(node.folders).sort()) {
    const folder = node.folders[name];
    const folderPath = pathPrefix + name + "/";
    children.push({
      title: name,
      key: "folder-" + folderPath,
      icon: <FolderOutlined />,
      children: toAntdTreeData(folder, folderPath),
    });
  }
  for (const file of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
    children.push({
      title: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>
          <Text ellipsis={{ tooltip: file.url }} style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>{file.name}</Text>
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

function buildSourceTree(sourceFiles) {
  const root = { folders: {}, files: [] };
  sourceFiles.forEach(({ path, content }) => {
    const parts = path.split("/").filter(Boolean);
    /* c8 ignore next */
    if (!parts.length) return; // skip empty paths
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

function toSourceTreeData(node, pathPrefix = "") {
  const children = [];
  for (const name of Object.keys(node.folders).sort()) {
    const folder = node.folders[name];
    const folderPath = pathPrefix + name + "/";
    children.push({
      title: name,
      key: "sfolder-" + folderPath,
      icon: <FolderOutlined />,
      children: toSourceTreeData(folder, folderPath),
      selectable: false,
    });
  }
  for (const file of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
    children.push({
      title: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0, maxWidth: "100%", whiteSpace: "nowrap", overflow: "hidden" }}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{file.name}</span>
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

function groupPagesByDomain(pages) {
  const buckets = {};
  pages.forEach((page) => {
    const siteKey = page.siteKey || i18nMessage("commonUnknown");
    if (!buckets[siteKey]) {
      buckets[siteKey] = { siteKey, pages: [], versionCount: 0, lastSeenAt: null };
    }
    buckets[siteKey].pages.push(page);
    buckets[siteKey].versionCount += page.versions.length;
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

// ─── Version Panel ──────────────────────────────────────────────────────────────

function VersionPanel({ version }) {
  const [files, setFiles] = useState(null);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sourceFiles, setSourceFiles] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ action: "getVersionFiles", versionId: version.id }, (resp) => {
      setLoadingFiles(false);
      setFiles(resp?.ok ? (resp.files || []) : []);
    });
  }, [version.id]);

  const handleDownload = useCallback(() => {
    /* c8 ignore next */
    if (!files?.length) return;
    downloadGroup(files, null, versionZipBaseName(files, version))
      .catch((err) => console.error("[SourceD] version download failed:", err));
  }, [files, version]);

  const handlePreview = useCallback(() => {
    /* c8 ignore next */
    if (!files?.length) return;
    const extracted = extractSourceFiles(files);
    setSourceFiles(extracted);
    setSelectedFile(null);
    setPreviewOpen(true);
  }, [files]);

  const sourceTreeData = useMemo(() => {
    if (!sourceFiles?.length) return [];
    return toSourceTreeData(buildSourceTree(sourceFiles));
  }, [sourceFiles]);

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

  const treeData = useMemo(() => {
    if (!files?.length) return [];
    return toAntdTreeData(buildMapTree(files));
  }, [files]);

  if (loadingFiles) {
    return <Spin size="small" style={{ padding: 16 }} />;
  }

  if (!files || !files.length) {
    return <Empty description={i18nMessage("dashboardEmptyVersionFiles")} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <Flex vertical gap={8} style={{ padding: "8px 0" }}>
      <Flex justify="space-between" align="center">
        <Space>
          <Text type="secondary">{i18nMessage("dashboardVersionFiles", [String(files.length)])}</Text>
          <Text type="secondary">{fileSizeIEC(version.byteSize || 0)}</Text>
        </Space>
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={handlePreview}>
            {i18nMessage("dashboardPreviewSources")}
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={handleDownload}>
            {i18nMessage("dashboardDownloadVersion")}
          </Button>
        </Space>
      </Flex>
      <Tree showIcon blockNode defaultExpandAll treeData={treeData} style={{ fontSize: 12, width: "100%", minWidth: 0, overflow: "hidden" }} />
      <Drawer
        title={i18nMessage("dashboardPreviewTitle")}
        open={previewOpen}
        onClose={() => { setPreviewOpen(false); setSelectedFile(null); }}
        destroyOnClose
        size="70vw"
        styles={{ body: { padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" } }}
      >
        {sourceFiles && sourceFiles.length > 0 ? (
          <Flex style={{ height: "100%", overflow: "hidden" }}>
            <div style={{ width: 360, minWidth: 260, borderRight: "1px solid #f0f0f0", overflow: "auto", padding: "8px 0" }}>
              <Tree
                showIcon
                blockNode
                defaultExpandAll
                treeData={sourceTreeData}
                onSelect={handleTreeSelect}
                style={{ fontSize: 12, width: "100%", minWidth: 0, overflow: "hidden" }}
              />
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: 0 }}>
              {selectedFile ? (
                <Flex vertical gap={0}>
                  <Flex justify="space-between" align="center" style={{ padding: "8px 12px", borderBottom: "1px solid #f0f0f0", background: "#fafafa" }}>
                    <Text strong ellipsis={{ tooltip: selectedFile.path }} style={{ minWidth: 0, flex: 1 }}>
                      {selectedFile.path}
                    </Text>
                    <Text type="secondary" style={{ flexShrink: 0, marginLeft: 8, fontSize: 12 }}>
                      {fileSizeIEC(selectedFile.size)}
                    </Text>
                  </Flex>
                  <CodePreview code={selectedFile.content} filename={selectedFile.name} />
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

// ─── Settings Form ──────────────────────────────────────────────────────────────

function SettingsSection({ settings, onReload }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();

  useEffect(() => {
    if (settings) {
      form.setFieldsValue({
        retentionDays: settings.retentionDays,
        maxVersionsPerPage: settings.maxVersionsPerPage,
        autoCleanup: !!settings.autoCleanup,
        detectionEnabled: settings.detectionEnabled !== false,
        fetchDelayMs: settings.fetchDelayMs,
        fetchTimeoutMs: settings.fetchTimeoutMs,
        maxMapBytes: settings.maxMapBytes,
      });
    }
  }, [settings, form]);

  const handleSave = useCallback((values) => {
    setSaving(true);
    chrome.runtime.sendMessage({
      action: "updateSettings",
      settings: {
        retentionDays: Number(values.retentionDays) || 30,
        maxVersionsPerPage: Number(values.maxVersionsPerPage) || 10,
        autoCleanup: !!values.autoCleanup,
        detectionEnabled: values.detectionEnabled !== false,
        fetchDelayMs: Number(values.fetchDelayMs) || 300,
        fetchTimeoutMs: Number(values.fetchTimeoutMs) || 30_000,
        maxMapBytes: Number(values.maxMapBytes) || 50 * 1024 * 1024,
      },
    }, (resp) => {
      setSaving(false);
      if (!resp?.ok) {
        message.error(resp?.error || i18nMessage("dashboardSaveFailed"));
        return;
      }
      message.success(i18nMessage("dashboardSaved"));
      onReload();
    });
  }, [message, onReload]);

  return (
    <Form form={form} layout="vertical" onFinish={handleSave} style={{ maxWidth: 400 }}>
      <Form.Item label={i18nMessage("dashboardSettingRetentionDays")} name="retentionDays">
        <InputNumber min={1} max={365} style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item label={i18nMessage("dashboardSettingMaxVersions")} name="maxVersionsPerPage">
        <InputNumber min={1} max={100} style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item name="autoCleanup" valuePropName="checked">
        <Switch checkedChildren={i18nMessage("dashboardSettingAutoCleanup")} unCheckedChildren={i18nMessage("dashboardSettingAutoCleanup")} />
      </Form.Item>
      <Form.Item name="detectionEnabled" valuePropName="checked">
        <Switch checkedChildren={i18nMessage("dashboardSettingDetectionEnabled")} unCheckedChildren={i18nMessage("dashboardSettingDetectionEnabled")} />
      </Form.Item>
      <Form.Item label={i18nMessage("dashboardSettingFetchDelayMs")} name="fetchDelayMs">
        <InputNumber min={0} max={5000} style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item label={i18nMessage("dashboardSettingFetchTimeoutMs")} name="fetchTimeoutMs">
        <InputNumber min={500} max={120_000} style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item label={i18nMessage("dashboardSettingMaxMapBytes")} name="maxMapBytes">
        <InputNumber min={1024 * 1024} max={500 * 1024 * 1024} style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>
          {i18nMessage("dashboardSaveSettings")}
        </Button>
      </Form.Item>
    </Form>
  );
}

function ImportMapsModal({ open, importing, onCancel, onImport }) {
  const [pageUrl, setPageUrl] = useState("");
  const [title, setTitle] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) {
      setPageUrl("");
      setTitle("");
      setSelectedFiles([]);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [open]);

  const handleFileChange = useCallback((event) => {
    const nextFiles = Array.from(event.target.files || []);
    setSelectedFiles(nextFiles);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmedUrl = pageUrl.trim();
    if (!trimmedUrl || !selectedFiles.length) return;

    const files = await Promise.all(selectedFiles.map(async (file) => {
      const text = typeof file.text === "function"
        ? await file.text()
        : await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result || "");
          reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
          reader.readAsText(file);
        });

      return {
        name: file.name,
        mapUrl: file.webkitRelativePath || file.name,
        content: String(text || ""),
      };
    }));

    onImport({
      pageUrl: trimmedUrl,
      title: title.trim(),
      files,
    });
  }, [onImport, pageUrl, selectedFiles, title]);

  return (
    <Modal
      title={i18nMessage("dashboardImportTitle")}
      open={open}
      onCancel={onCancel}
      onOk={handleSubmit}
      okText={i18nMessage("dashboardImportConfirm")}
      okButtonProps={{ disabled: !pageUrl.trim() || !selectedFiles.length, loading: importing }}
      cancelButtonProps={{ disabled: importing }}
      destroyOnHidden
    >
      <Flex vertical gap={12}>
        <Text type="secondary">{i18nMessage("dashboardImportHelp")}</Text>
        <Input
          value={pageUrl}
          onChange={(event) => setPageUrl(event.target.value)}
          placeholder={i18nMessage("dashboardImportUrlPlaceholder")}
          aria-label={i18nMessage("dashboardImportUrlLabel")}
        />
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={i18nMessage("dashboardImportTitlePlaceholder")}
          aria-label={i18nMessage("dashboardImportPageTitleLabel")}
        />
        <Flex vertical gap={8}>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".map,application/json"
            onChange={handleFileChange}
            aria-label={i18nMessage("dashboardImportFileLabel")}
          />
          {selectedFiles.length ? (
            <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
              {selectedFiles.map((file, index) => (
                <Flex
                  key={`${file.name}-${index}`}
                  justify="space-between"
                  align="center"
                  style={{
                    width: "100%",
                    minWidth: 0,
                    padding: "8px 12px",
                    borderTop: index === 0 ? "none" : "1px solid #f0f0f0",
                  }}
                >
                  <Text ellipsis={{ tooltip: file.name }} style={{ minWidth: 0 }}>{file.name}</Text>
                  <Text type="secondary" style={{ marginLeft: 8, flexShrink: 0 }}>{fileSizeIEC(file.size || 0)}</Text>
                </Flex>
              ))}
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {i18nMessage("dashboardImportEmpty")}
            </Text>
          )}
        </Flex>
      </Flex>
    </Modal>
  );
}

// ─── Main Dashboard App ─────────────────────────────────────────────────────────

function DashboardContent() {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [pages, setPages] = useState([]);
  const [distribution, setDistribution] = useState([]);
  const [settings, setSettings] = useState(null);
  const [totalVersions, setTotalVersions] = useState(0);
  const [totalStorageBytes, setTotalStorageBytes] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const loadData = useCallback(() => {
    setLoading(true);
    chrome.runtime.sendMessage({ action: "getDashboardData" }, (data) => {
      setLoading(false);
      setPages(data?.pages || []);
      setDistribution(data?.distribution || []);
      setSettings(data?.settings || { retentionDays: 30, maxVersionsPerPage: 10, autoCleanup: true, detectionEnabled: true, fetchDelayMs: 300, fetchTimeoutMs: 30_000, maxMapBytes: 50 * 1024 * 1024 });
      setTotalVersions(data?.totalVersions || 0);
      setTotalStorageBytes(data?.totalStorageBytes || 0);
    });
  }, []);

  useEffect(() => {
    const locale = chrome.i18n.getUILanguage() || "en";
    document.documentElement.lang = /^zh\b/i.test(locale) ? "zh-CN" : "en";
    document.title = i18nMessage("dashboardPageTitle");
    loadData();
  }, [loadData]);

  const [cleaning, setCleaning] = useState(false);
  const handleCleanup = useCallback(() => {
    setCleaning(true);
    chrome.runtime.sendMessage({ action: "cleanupData" }, (resp) => {
      setCleaning(false);
      if (!resp?.ok) {
        message.error(resp?.error || "Cleanup failed");
        return;
      } else {
        const details = (resp.cleaned || []).map((v) => `${v.pageUrl} (${v.reason}, ${v.mapCount} maps)`).join("\n");
        const stats = resp.stats || {};
        const reclaimedBytes = Number(stats.reclaimedBytes) || 0;
        const removedVersions = Number(stats.removedVersions) || 0;
        const removedMaps = Number(stats.removedMaps) || 0;
        const changed = reclaimedBytes > 0 || removedVersions > 0 || removedMaps > 0 || (resp.cleaned || []).length > 0;

        if (changed) {
          const cleanedCount = removedVersions || (resp.cleaned || []).length;
          const content = `${i18nMessage("dashboardCleanupDone", [String(cleanedCount)])} · ${i18nMessage("dashboardCleanupOptimized", [String(removedMaps), fileSizeIEC(reclaimedBytes)])}`;
          message.success({
            content,
            duration: 5,
          });
        } else {
          message.info(i18nMessage("dashboardCleanupNone"));
        }

        if (details) {
          console.info("[SourceD] Cleaned versions:\n" + details);
        }

        loadData();
      }
    });
  }, [loadData, message]);

  const groups = useMemo(() => groupPagesByDomain(pages), [pages]);

  const stopHeaderAction = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleDeleteVersion = useCallback((event, versionId) => {
    stopHeaderAction(event);
    chrome.runtime.sendMessage({ action: "deleteVersion", versionId }, () => {
      loadData();
    });
  }, [loadData, stopHeaderAction]);

  const handleDeletePage = useCallback((event, pageUrl) => {
    stopHeaderAction(event);
    chrome.runtime.sendMessage({ action: "deletePageHistory", pageUrl }, () => {
      loadData();
    });
  }, [loadData, stopHeaderAction]);

  const handleDeleteSite = useCallback((event, siteKey) => {
    stopHeaderAction(event);
    chrome.runtime.sendMessage({ action: "deleteSiteHistory", siteKey }, () => {
      loadData();
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
      loadData();
    });
  }, [loadData, message]);

  const domainCollapseItems = useMemo(() => {
    return groups.map((group) => ({
      key: group.siteKey,
      label: (
        <Flex justify="space-between" align="center" style={{ overflow: "hidden" }}>
          <Flex vertical gap={2} style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
            <Flex align="center" gap={8} style={{ minWidth: 0 }}>
              <GlobalOutlined style={{ flexShrink: 0 }} />
              <Text strong ellipsis={{ tooltip: group.siteKey }}>{group.siteKey}</Text>
            </Flex>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {i18nMessage("dashboardDomainSummary", [String(group.pages.length), String(group.versionCount)])}
            </Text>
          </Flex>
          <Flex align="center" gap={8} style={{ flexShrink: 0, marginLeft: 12 }}>
            <Tag color="blue">{group.versionCount}</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {i18nMessage("dashboardLastUpdated", [formatShortDate(group.lastSeenAt)])}
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
      ),
      children: (
        <Collapse
          size="small"
          items={group.pages.map((page) => ({
            key: page.pageUrl,
            label: (
              <Flex justify="space-between" align="center" style={{ overflow: "hidden" }}>
                <Flex vertical gap={2} style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
                  {/* c8 ignore next 2 */}
                  <Text strong ellipsis={{ tooltip: page.title || page.pageUrl }}>{page.title || page.pageUrl}</Text>
                  <Text type="secondary" ellipsis={{ tooltip: page.pageUrl }} style={{ fontSize: 12 }}>{page.pageUrl}</Text>
                </Flex>
                <Flex align="center" gap={8} style={{ flexShrink: 0, marginLeft: 12 }}>
                  <Tag>{page.versions.length}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {i18nMessage("dashboardLastUpdated", [formatShortDate(page.versions[0]?.lastSeenAt)])}
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
            ),
            children: (
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
                        <Tag>{i18nMessage("dashboardCapturedAt", [formatVersionTime(version.createdAt)])}</Tag>
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
                  children: <VersionPanel version={version} />,
                }))}
              />
            ),
          }))}
        />
      ),
    }));
  }, [groups, handleDeletePage, handleDeleteSite, handleDeleteVersion]);

  return (
    <ConfigProvider theme={{ token: { fontSize: 13 } }}>
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
            <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>
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
            <Collapse items={domainCollapseItems} />
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
            <Flex gap={16} wrap="wrap">
              {distribution.map((item) => (
                <Card size="small" key={item.siteKey} style={{ minWidth: 0, flex: "1 1 220px", maxWidth: "100%", overflow: "hidden" }}>
                  <Flex vertical gap={4} style={{ overflow: "hidden" }}>
                    <Text strong ellipsis={{ tooltip: item.siteKey }}>{item.siteKey}</Text>
                    <Flex gap={4} wrap="wrap">
                      <Tag>{i18nMessage("dashboardDistributionVersions", [String(item.versionCount)])}</Tag>
                      <Tag>{i18nMessage("dashboardDistributionMaps", [String(item.mapCount)])}</Tag>
                      {/* c8 ignore next */}
                      <Tag>{fileSizeIEC(item.byteSize || 0)}</Tag>
                    </Flex>
                  </Flex>
                </Card>
              ))}
            </Flex>
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
