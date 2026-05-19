# Phase 1 — 接入/边界层（runtime/handlers.mjs、runtime/index.mjs）

## 覆盖文件

- `src/background/runtime/handlers.mjs`（全文）
- `src/background/runtime/index.mjs`（全文）
- `src/background/index.js`

## Findings

### F1-1 · P1 · `getDashboardData` 同步返回，不发送 `return true` — 无法处理异步扩展

**位置**：`runtime/handlers.mjs`，`message.action === "getDashboardData"` 分支  
**代码**：
```js
if (message.action === "getDashboardData") {
  sendResponse({
    pages: summarizePages(),
    distribution: distributionSummary(),
    settings: currentSettings(),
    totalVersions: Object.keys(state.versionIndex).length,
    totalStorageBytes: totalStorageBytes(),
  });
  // 没有 return true，也没有 return
}
```
**触发条件**：当前代码同步调用 `sendResponse`，不返回 `true`，在该操作后代码继续向下穿透，到达下一个 `if` 块（`getVersionFiles`），理论上不会重复触发，因为每个 `if` 互斥。  
**实际风险**：该分支没有任何 `return` 语句，执行完 `sendResponse` 后，消息处理函数继续向下执行到后续所有 `if (message.action === "...")` 块。由于这些块基于 `message.action` 做条件检查，对于已处理的 `getDashboardData` 消息不会再次 `sendResponse`，但会多余地执行完整个 handler 函数体。**关键风险**：一旦后续新增了副作用代码（或有人误以为这里已经 return），这会成为一个危险前提。  
**修复方向**：在 `sendResponse(...)` 后加 `return;`，保持与其他分支一致的风格。

---

### F1-2 · P2 · `cleanupData` 兜底路径存在死代码并引入了非确定性行为

**位置**：`runtime/handlers.mjs`，`message.action === "cleanupData"` 分支  
**代码**：
```js
const runCleanup = runCleanupTasks || (() => {
  if (Object.keys(state.versionIndex).length === 0) { ... }
  return compactStorageData().then(...);
});
```
**触发条件**：`runCleanupTasks` 已从 `compaction.mjs` 导入，在生产环境中始终为真值。兜底匿名函数永远不会被调用。  
**风险**：这个兜底路径是死代码，混淆了代码意图；若将来 `runCleanupTasks` 的导入被意外移除，该兜底会静默运行一个不同的逻辑（缺少 `cleanupLegacyDataTables` 步骤），掩盖问题。  
**修复方向**：移除兜底匿名函数，直接调用 `runCleanupTasks()`，或在 `runCleanupTasks` 不存在时显式抛出错误。

---

### F1-3 · INFO · `chrome.tabs.get` 回调内的错误被静默吞掉

**位置**：`runtime/handlers.mjs`，`createWebRequestHandler`  
**代码**：
```js
chrome.tabs.get(details.tabId, (tab) => {
  if (chrome.runtime.lastError || !tab || !tab.url) return;
  ...
  fetchSourceMap(details.url, (mapUrl, content, httpStatus) => { ... });
});
```
**触发条件**：`chrome.runtime.lastError` 通常在 tab 已关闭时产生；但 `getOrCreateSession`、`fetchSourceMap` 内部如有未捕获异常会向上冒泡到 Chrome 的回调层，导致 background service worker 静默崩溃。  
**风险**：当前依赖 `scheduleSessionPersist` 的 `.catch()` 处理，但 `getOrCreateSession` 和 `isValidSourceMap` 可能抛出，在回调中没有 try/catch。  
**修复方向**：在 `chrome.tabs.get` 的回调体最外层加 try/catch，记录错误后 return。

---

### F1-4 · P1 · `initializeRuntime` 的 Promise 链中，`registerRuntimeListeners` 之后的 `webRequest` 监听在 `loadSettings` 出错时永远不会被取消注册

**位置**：`runtime/index.mjs`，`initializeRuntime`  
**代码**：
```js
return Promise.all([ensureStorageReady(), loadSettings()]).then((results) => {
  registerRuntimeListeners();
  return results;
});
```
**触发条件**：`loadSettings()` 失败时，`registerRuntimeListeners()` 不会被调用，这是正确的；但如果 `ensureStorageReady()` 成功、`loadSettings()` 失败，启动失败时已缓存的 `state.storageReadyPromise`（IDB 已初始化）不会被清除，状态处于"DB 已就绪但 settings 为 null"。  
**风险**：`index.js` 只打印 warning 而不做任何恢复，后续如果有重试逻辑或 SW 重启（MV3 service worker 随时可能被关闭并重新启动），`state.storageReadyPromise` 已被赋值不为 null，但 `state.settings` 仍为 null，`currentSettings()` 会返回 `normalizeSettings()` 的默认值，包括 `detectionEnabled: true`，即使用户配置了禁用也会继续采集。  
**修复方向**：在 `loadSettings` 失败时，设置 `state.storageReadyPromise = null` 或提供明确的启动失败状态，防止半初始化运行。

## 漏检复盘

- 检查了所有 `return true` 路径 —— 仅 `getDashboardData` 缺少显式 return，其他消息均有 `return true`
- 检查了 rejection 回传 —— 所有异步分支均有 `.catch` 并调用 `sendResponse({ ok: false })`
- 检查了 `cleanupData` 兜底路径的并发安全（`storageCompactionInProgress` flag 在 `compactStorageData` 内部设置）
- 检查了 `chrome.tabs.onUpdated` 中 tab teardown 期间 badge 竞态 —— 已有 try/catch 包裹
- 检查了监听器注册顺序 —— `initializeRuntime` 等待 `Promise.all` 才调用 `registerRuntimeListeners`，冷启动期间 `detectionEnabled` 不会在 settings 未加载时运行（历史 H3 已修复）
