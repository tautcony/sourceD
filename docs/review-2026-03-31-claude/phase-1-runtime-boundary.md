# Phase 1 审查报告: 运行时与边界层

> 日期: 2026-03-31
> 文件数: 3
> 发现: P0(2) / P1(3) / P2(2) / INFO(1)

## 已审查文件
- `src/background/index.js`
- `src/background/runtime.mjs`
- `manifest.json`

## Findings

### [P0-1] `fetchSourceMap` 缺少超时控制和响应大小限制

- 位置: `src/background/sessions.mjs` `fetchSourceMap`（跨 phase 但入口在 runtime 的 webRequest 监听中触发）
- 触发条件: 页面加载的任何 `.js` 文件触发 fetch，先获取完整 JS 内容，再获取 source map 内容
- 影响:
  1. 恶意或超大 JS/map 文件可导致 service worker 内存耗尽（无 `Content-Length` 检查，`resp.text()` 会将整个响应加载到内存）
  2. 慢响应目标可永久挂起 fetch（无 `AbortController`/超时），积累大量挂起 promise
  3. `setTimeout(fn, 300)` 的延迟没有任何节流/去重机制 — 同一 JS URL 可被多次 fetch
- 修复方向:
  - 添加 `AbortController` + 超时（如 30s）
  - 检查 `Content-Length` header，拒绝超过合理阈值（如 50MB）的响应
  - 使用 Set 去重正在 fetch 的 URL，避免重复请求

### [P0-2] `clearAll` 操作存在竞态导致数据残留

- 位置: `src/background/runtime.mjs` `port.onMessage` 中 `clearAll` 分支
- 触发条件: 用户点击 "Clear All"
- 影响: `deleteVersions(Object.keys(state.versionIndex))` 是异步操作，`.then()` 中再次读取 `Object.keys(state.versionIndex)` 作为 `removeVersionsFromIndexes` 的参数。如果在 `deleteVersions` 执行期间有新的 session persist 写入了新的 version，则 `.then()` 中的 keys 会包含这些新 key（尚未从 IDB 删除），但 `removeVersionsFromIndexes` 会从内存索引中清除它们，导致内存与磁盘状态不一致。
- 修复方向: 在调用 `deleteVersions` 前捕获 keys 快照：
  ```js
  const ids = Object.keys(state.versionIndex);
  deleteVersions(ids).then(() => {
    removeVersionsFromIndexes(ids);
    broadcastSummary();
  });
  ```

### [P1-1] `onMessage` 监听器缺少默认分支和消息校验

- 位置: `src/background/runtime.mjs` `chrome.runtime.onMessage.addListener`
- 触发条件: 任何扩展页面或 content script 可向 background 发送任意 `action`
- 影响:
  1. 不被识别的 `action` 会穿透所有 `if` 分支，不调用 `sendResponse`，导致消息通道悬挂直到被 GC
  2. 对 `message.versionId`、`message.pageUrl` 等字段无类型/存在性检查，传入 `undefined` 可能导致 IndexedDB 操作异常
- 修复方向:
  - 添加 `else` 分支调用 `sendResponse({ ok: false, error: "unknown action" })`
  - 对关键字段做基本存在性检查

### [P1-2] `port.onMessage` 监听器中 `deleteVersions` 失败无错误处理

- 位置: `src/background/runtime.mjs` `clearAll` 和 `clearOlderThan7d` 分支
- 触发条件: IndexedDB 事务失败
- 影响: `.then()` 链无 `.catch()`，promise rejection 会变成未捕获 rejection，popup 端永远收不到反馈
- 修复方向: 添加 `.catch()` 处理并通过 port 回传错误

### [P1-3] `webRequest.onBeforeRequest` 中 `fetchSourceMap` 回调不检查 session 是否仍有效

- 位置: `src/background/runtime.mjs` webRequest 监听器内部
- 触发条件: 在 `fetch` 完成前用户已导航离开（session 被 cleanup），`fetchSourceMap` 的回调仍执行
- 影响: 回调中 `session.maps[mapUrl] = content` 会写入已被清理的 session 对象（`state.tabSessions` 中已删除），不会造成崩溃但会导致数据写入一个孤儿对象，触发 `scheduleSessionPersist` 对已废弃 session 的持久化，可能产生错误的 version 记录
- 修复方向: 在 `fetchSourceMap` 回调中检查 `state.tabSessions[session.tabId] === session`

### [P2-1] `initializeRuntime` 错误处理不充分

- 位置: `src/background/index.js`
- 触发条件: `initializeRuntime` 内部 `ensureStorageReady()` 或 `loadSettings()` 抛异常
- 影响: 只 `console.warn` 错误信息，service worker 处于部分初始化状态 — 监听器未注册，所有功能静默失效，用户无任何提示
- 修复方向: 考虑重试机制或至少设置 badge 显示错误状态

### [P2-2] `getPopupState` 同步返回 `undefined` 路径缺少 `return true`

- 位置: `src/background/runtime.mjs` `getPopupState` handler
- 触发条件: `latest` 为 null 时走同步 `sendResponse` 路径
- 影响: 当前行为正确（同步分支不需要 `return true`），但代码结构使同步和异步分支的返回语义不一致 — 如果未来重构容易引入 bug
- 修复方向: INFO 级别，无需立即处理，但建议统一为 `return true` + 异步模式

### [INFO-1] `manifest.json` 使用 `<all_urls>` host permission

- 位置: `manifest.json`
- 影响: 功能上必需（source map 可能来自任何域），但在应用商店审核时可能被要求减少权限范围。README 已说明用途。
- 修复方向: 无需修改，但如果提交到 Chrome Web Store，需准备权限审查材料

## 未覆盖区域
- `scripts/build-dist.mjs` 和 `scripts/package-release.mjs` 未深入审查（构建脚本，风险较低）
