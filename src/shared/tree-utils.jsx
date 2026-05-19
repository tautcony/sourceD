import { Button, Tag, Typography } from "antd";
import { DownloadOutlined, FolderOutlined, FileOutlined, StopOutlined } from "@ant-design/icons";
import { fileSizeIEC, i18nMessage, sourceMapTreePath } from "./utils.mjs";

const { Text } = Typography;

export function buildMapTree(files, failedEntries = []) {
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
      size: Number(file.byteSize) || (file.content != null ? file.content.length : 0),
      refCount: Number(file.refCount) || 1,
    });
  });
  failedEntries.forEach(({ url, httpStatus }) => {
    const parts = sourceMapTreePath(url);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.folders[parts[i]]) {
        node.folders[parts[i]] = { name: parts[i], folders: {}, files: [] };
      }
      node = node.folders[parts[i]];
    }
    node.files.push({
      name: parts[parts.length - 1],
      url,
      size: 0,
      refCount: 0,
      failed: true,
      httpStatus,
    });
  });
  return root;
}

function compactMapFolderChain(name, folder, fullPath) {
  const subNames = Object.keys(folder.folders);
  if (subNames.length === 1 && folder.files.length === 0) {
    const child = subNames[0];
    return compactMapFolderChain(`${name}/${child}`, folder.folders[child], fullPath + child + "/");
  }
  return { displayName: name, node: folder, path: fullPath };
}

export function toAntdTreeData(node, pathPrefix = "", { onDownloadFile } = {}) {
  const children = [];
  const folderNames = Object.keys(node.folders).sort();
  for (const name of folderNames) {
    const folder = node.folders[name];
    const folderPath = pathPrefix + name + "/";
    const { displayName, node: compacted, path: compactedPath } = compactMapFolderChain(name, folder, folderPath);
    children.push({
      title: (
        <span title={displayName} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {displayName}
        </span>
      ),
      key: "folder-" + compactedPath,
      icon: <FolderOutlined />,
      children: toAntdTreeData(compacted, compactedPath, { onDownloadFile }),
    });
  }
  const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  for (const file of sortedFiles) {
    if (file.failed) {
      children.push({
        title: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, width: "100%", minWidth: 0, maxWidth: "100%" }}>
            <Text type="secondary" ellipsis={{ tooltip: file.url }} style={{ flex: 1, minWidth: 0 }}>{file.name}</Text>
            {file.httpStatus ? (
              <Tag color="error" style={{ flexShrink: 0, marginInlineEnd: 0 }}>HTTP {file.httpStatus}</Tag>
            ) : null}
          </span>
        ),
        key: "file-failed-" + file.url,
        icon: <StopOutlined style={{ color: "#ff4d4f" }} />,
        isLeaf: true,
      });
      continue;
    }
    children.push({
      title: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, width: "100%", minWidth: 0, maxWidth: "100%" }}>
          <Text ellipsis={{ tooltip: file.url }} style={{ flex: 1, minWidth: 0 }}>{file.name}</Text>
          {file.refCount > 1 ? (
            <Tag color="gold" style={{ flexShrink: 0, marginInlineEnd: 0 }}>
              {i18nMessage("commonReferenceCount", [String(file.refCount)])}
            </Tag>
          ) : null}
          <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>{fileSizeIEC(file.size)}</Text>
          {onDownloadFile ? (
            <Button
              size="small"
              icon={<DownloadOutlined />}
              style={{ flexShrink: 0, marginLeft: 2 }}
              onClick={(e) => { e.stopPropagation(); onDownloadFile(file.url); }}
            />
          ) : null}
        </span>
      ),
      key: "file-" + file.url,
      icon: <FileOutlined />,
      isLeaf: true,
    });
  }
  return children;
}
