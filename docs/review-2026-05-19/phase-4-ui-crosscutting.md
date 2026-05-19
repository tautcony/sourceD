# Phase 4 — UI 与横切保障层（popup/sourcemap.mjs、shared/utils.mjs、测试覆盖）

## 覆盖文件

- `src/popup/sourcemap.mjs`（全文）
- `src/shared/utils.mjs`（全文）
- 测试文件结构（tests/ 目录）

## Findings

### F4-1 · P1 · `normalizeSourcePath` 中 `/@fs/` 分支的路径截断逻辑缺乏边界防御，可产生空路径或路径遍历

**位置**：`src/popup/sourcemap.mjs`，`normalizeSourcePath`  
**代码**：
```js
} else if (fileName.startsWith("/@fs/")) {
  var fsPath = fileName.slice(5);
  var knownDir = /\/(src|lib|app|components|pages|views|utils|stores?|router|assets|styles?|api|hooks|composables|types?)\//;
  var m = fsPath.match(knownDir);
  if (m) {
    fileName = fsPath.slice(fsPath.indexOf(m[0]) + 1);
  } else {
    fileName = fsPath.replace(/^(?:[/\\][^/\\]+){1,4}[/\\]/, "");  // 移除前 1-4 个路径段
  }
  result = sanitizePath(fileName);
}
```
**触发条件**：恶意或非常规 source map 文件中 `sources` 字段包含形如 `/@fs/../../../etc/passwd` 的路径。  
**风险分析**：`sanitizePath` 通过遍历 path parts 并对 `..` 做 `parts.pop()` 来防止遍历，这部分是安全的。但 `replace(/^(?:[/\\][^/\\]+){1,4}[/\\]/, "")` 仅移除最多 4 个绝对路径段，对于 5 段以上的绝对路径（如 `/a/b/c/d/e/malicious`）只移除前 4 段，剩余 `/e/malicious`，以 `/` 开头传入 `sanitizePath`，`sanitizePath` 会将其视为相对路径（`split("/")` 后第一个元素为空字符串，被跳过），最终生成 `e/malicious`。这意味着文件始终会被放置在 ZIP 根目录的相对路径下，不会逃出 ZIP，**不是 zip-slip 漏洞**。  
但 `sanitizePath` 对 `..` 的 pop 操作确保路径不会上溯，整个 ZIP 下载链路是安全的。  
**降级为 INFO**：路径最终都经过 `sanitizePath`，`..` 遍历不可能实现，ZIP 内容不会引发真实安全问题。

---

### F4-2 · P2 · `appendFilesToZip` 和 `extractSourceFiles` 中 `consumer.sourceContentFor(src, true)` 的第二参数 `returnNullOnMissing=true` 被忽略了实际含义

**位置**：`src/popup/sourcemap.mjs`  
**代码**：
```js
var content = consumer.sourceContentFor(src, true);
if (!content) return;
```
**风险**：`sourceContentFor(src, true)` 在 source 不存在时返回 null（而非抛出），这是正确的。但 `source-map-js` 的 `SourceMapConsumer` 在某些版本中对 `sources` 中存在但 `sourcesContent` 为 null 的条目行为不一致（有时返回空字符串，有时返回 null）。当前有 `if (!content) return;` 守卫，能过滤掉 null 和空字符串，逻辑正确。  
**无实际缺陷，标记为 INFO**。

---

### F4-3 · P1 · 测试覆盖缺口：F2-1（`loadVersionRefsRaw` IDB 事务提前关闭）、F2-2（retryFailedMapFetch 并发）、F3-1（compaction 并发窗口）均无测试

**位置**：`tests/` 目录  
**当前测试状态**：
- `background.db.test.js`：覆盖了基本的 CRUD 操作
- `background.compression.test.js`：覆盖了编解码基本路径
- `background.sourceMaps.test.js`：覆盖了采集主链路
- `background.test.js`：覆盖了 handler 主链路，mock 了所有 IDB 操作

**缺失测试**：
1. `loadVersionRefsRaw` 遇到 string 格式 entry 时，多条 pending 并发 async 处理的正确性
2. `retryFailedMapFetch` 并发两次调用同一 versionId + mapUrl 的结果（blobIndex refCount 正确性）
3. `compactStorageData` 与并发 `deleteVersions` 之间的状态一致性
4. `decodeBlobContent` 在 `DecompressionStream` 不可用时的行为
5. `base64ToUtf8` 在 data URI 格式错误时（无逗号）的行为

**修复方向**：为每个 F2-1、F2-2、F3-1 缺陷添加专项单元测试，重点验证失败路径和并发场景。

---

### F4-4 · INFO · `sanitizePath` 中的 `console.warn` 被注释掉但 `sanitizePath` 的仍然有一处 warn 调用

**位置**：`src/shared/utils.mjs`  
**代码**：
```js
export function sanitizeFilename(filename) {
  // console.warn("[SourceD] sanitizeFilename: received empty input, using 'unnamed'", filename);
  return "unnamed";
  ...
}

export function sanitizePath(path) {
  if (!path) {
    console.warn("[SourceD] sanitizePath: received empty input, using 'unnamed'", path);  // ← 未注释
    return "unnamed";
  }
```
**风险**：`sanitizePath` 内的 warn 仍然活跃，会在 ZIP 下载中每次遇到空路径时向 background console 输出警告，可能泄露路径信息到扩展日志（用户可见）。低风险，仅为噪音，但行为不一致。  
**修复方向**：与 `sanitizeFilename` 保持一致，注释掉或完全移除该 warn，或明确保留为调试辅助。

## 漏检复盘

- 检查了 `blobToDownload` 中 `URL.revokeObjectURL` 调用时机 —— 在 `chrome.downloads.download` 回调中立即 revoke，但 download 回调时文件可能尚未写入磁盘；Chrome 的 downloads API 会在回调触发前保留 object URL 引用，实际上这是安全的
- 检查了 `parseSourceMap` / `appendFilesToZip` 中 `consumer.destroy()` 调用 —— 在 finally 块中，正确释放
- 检查了 `extractSourceFiles` 中 sources/sourcesContent 数组越界 —— `parsed.sourcesContent[index]` 对数组长度不同时可能返回 undefined，但 `if (!content || !content.trim())` 会过滤掉
- 检查了 `i18nMessage` / `resolveMessage` 中模板替换逻辑 —— 不存在注入风险（纯字符串替换）
- 检查了 download 链路中文件名的 sanitize 覆盖 —— `sanitizeFilename` 已被调用
