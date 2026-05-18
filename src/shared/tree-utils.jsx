import { Tag, Typography } from "antd";
import { FolderOutlined, FileOutlined } from "@ant-design/icons";
import { fileSizeIEC, i18nMessage, sourceMapTreePath } from "./utils.mjs";

const { Text } = Typography;

export function buildMapTree(files) {
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
      size: Number(file.byteSize) || file.content.length,
      refCount: Number(file.refCount) || 1,
    });
  });
  return root;
}

export function toAntdTreeData(node, pathPrefix = "") {
  const children = [];
  const folderNames = Object.keys(node.folders).sort();
  for (const name of folderNames) {
    const folder = node.folders[name];
    const folderPath = pathPrefix + name + "/";
    children.push({
      title: name,
      key: "folder-" + folderPath,
      icon: <FolderOutlined />,
      children: toAntdTreeData(folder, folderPath),
    });
  }
  const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  for (const file of sortedFiles) {
    children.push({
      title: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>
          <Text ellipsis={{ tooltip: file.url }} style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>{file.name}</Text>
          {file.refCount > 1 ? (
            <Tag color="gold" style={{ flexShrink: 0, marginInlineEnd: 0 }}>
              {i18nMessage("commonReferenceCount", [String(file.refCount)])}
            </Tag>
          ) : null}
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
