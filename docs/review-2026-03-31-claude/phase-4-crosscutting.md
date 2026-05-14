# Phase 4 审查报告: 横切审查

> 日期: 2026-03-31
> 发现: P0(0) / P1(2) / P2(1) / INFO(1)

## 已审查范围
- 跨模块错误传播一致性
- 安全边界
- 异步流程整体竞态
- 资源释放

## Findings

### [P1-8] 错误传播不一致 — 部分路径吞错误，部分路径透传

- 位置: 多处
- 详情:
  1. `runtime.mjs` 中 `port.onMessage` 的 `clearAll` / `clearOlderThan7d` 分支: `deleteVersions` 失败 → promise rejection 未捕获 → popup 永远不知道操作失败
  2. `runtime.mjs` 中 `onMessage` 的 `deleteVersion` / `deletePageHistory` / `deleteSiteHistory` 分支: 正确使用 `.catch(err => sendResponse({ok: false, ...}))` — 一致性好
  3. `sessions.mjs` 中 `scheduleSessionPersist`: `upsertSessionVersion` 失败只 `console.warn` — 这是合理的（后台自动持久化不宜弹窗），但不一致
  4. `storage.mjs` 中 `ensureStorageReady`: 失败时将 `storageReadyPromise` 置 null 并 re-throw — 允许重试，设计合理
- 影响: `clearAll` 和 `clearOlderThan7d` 是用户显式触发的操作，失败无反馈是行为回归风险
- 修复方向: 统一 `port.onMessage` 中所有操作添加 `.catch()` 并通过 port 回传错误消息

### [P1-9] 内联 base64 source map 的 `atob` 解码无 charset 处理

- 位置: `src/background/sessions.mjs` `fetchSourceMap` 中 `mapRef.startsWith("data:application/json")` 分支
- 触发条件: source map 的 data URL 使用 `charset=utf-8;base64` 或 `charset=utf-16` 等非 ASCII 编码
- 影响:
  1. `mapRef.split(",")[1]` 只以第一个 `,` 分割，如果 base64 部分前有多个逗号（不常见但合规的 data URL 格式），可能截取不正确
  2. `atob()` 仅解码 ASCII → latin1，对于 UTF-8 编码的 source map（最常见），如果 map 内容包含非 ASCII 字符（如注释中的中文），`atob` 解码后得到的是 Latin-1 字节而非正确的 UTF-8 字符串。`JSON.parse` 可能仍然成功，但 `sourcesContent` 中的非 ASCII 字符会乱码
- 修复方向: 使用 `Uint8Array` + `TextDecoder` 处理 base64 解码，正确支持 UTF-8:
  ```js
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  ```

### [P2-9] `isValidSourceMap` 的 XSSI 前缀剥离可能误匹配

- 位置: `src/background/sessions.mjs` `isValidSourceMap`
- 触发条件: source map JSON 以 `)]}'\n` 开头（Google XSSI 保护）
- 影响: `raw.replace(/^\)\]\}'/, "")` 使用正则替换但没有 `\n` 匹配 — 如果 source map 以 `)]}'{` 开头（无换行），替换后变成 `{`，会正常解析。这与 spec 兼容但可能在边缘情况下误处理非 source map 的响应。风险很低。
- 修复方向: 可以更严格地匹配 `)]}'\n` 或 `)]}'` 后接 whitespace

### [INFO-6] 前端 UI 消息通信依赖隐式协议

- 位置: `popup/App.jsx` → `runtime.mjs`, `dashboard/App.jsx` → `runtime.mjs`
- 影响: 前端通过 `chrome.runtime.sendMessage` 发送 action 字符串与 background 通信，消息协议完全靠约定，无类型或 schema 定义。当前规模下不是问题，但增加新 action 时容易遗漏某一端的更新。
- 修复方向: 可选 — 定义一个共享的 action 常量文件

## 未覆盖区域
- 无
