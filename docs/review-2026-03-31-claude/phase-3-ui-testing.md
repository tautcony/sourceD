# Phase 3 审查报告: UI 与测试层

> 日期: 2026-03-31
> 文件数: 8
> 发现: P0(1) / P1(1) / P2(3) / INFO(2)

## 已审查文件
- `src/popup/App.jsx`
- `src/popup/entry.jsx`
- `src/popup/sourcemap.mjs`
- `src/dashboard/App.jsx`
- `src/dashboard/entry.jsx`
- `src/options/App.jsx`
- `src/options/entry.jsx`
- `src/shared/utils.mjs`
- `tests/*.test.{js,jsx}`

## Findings

### [P0-4] `options/App.jsx` 中 `dangerouslySetInnerHTML` 将 i18n 消息作为 HTML 注入

- 位置: `src/options/App.jsx` 两处使用 `dangerouslySetInnerHTML`
  - `optionsWhatItDoesBody` 消息
  - `optionsPermission*` 系列消息
- 触发条件: 当前的 i18n 消息由开发者控制（`_locales/en/messages.json`），内容安全。但 `dangerouslySetInnerHTML` 的使用模式是系统性 XSS 风险：
  1. 如果翻译文件由外部翻译者贡献（crowdsource），恶意翻译可注入任意 HTML/JS
  2. Chrome 扩展的 CSP 默认限制内联 script，但不阻止 HTML 注入（如 `<img onerror>` 在启用某些 CSP 指令时仍可触发）
  3. 当前的 `_locales` 消息中包含 `<code>` 标签 — 这是使用 `dangerouslySetInnerHTML` 的原因
- 影响: 当前内容安全，但作为模式具有 XSS 隐患
- 修复方向:
  - 将 i18n 消息中的 `<code>` 标签改为占位符，在 React 中用 inline `<code>` 组件渲染
  - 或使用白名单 HTML sanitizer（如 DOMPurify）处理后再注入

### [P1-7] `sourcemap.mjs` 中 `defaultZipBaseName` 调用 `timestampSlug()` 不传参数

- 位置: `src/popup/sourcemap.mjs` `defaultZipBaseName` 函数
- 触发条件: 调用 `downloadGroup` 不传 `zipBaseName` 参数时
- 影响: `timestampSlug()` 被调用时 `isoString` 为 `undefined`，函数返回 `"unknown-time"` — 这不是崩溃但文件名中的时间戳始终是 `"unknown-time"`，用户下载的 ZIP 文件名缺少有意义的时间标识
- 修复方向: 传 `new Date().toISOString()` 给 `timestampSlug()`

### [P2-6] `CodePreview` 组件通过 `innerHTML` 注入 highlight.js 输出

- 位置: `src/dashboard/App.jsx` `CodePreview` 组件
- 触发条件: 用户预览从 source map 中提取的源码
- 影响: highlight.js 的输出是经过其内部转义的 HTML（`hljs.highlight` 默认转义 HTML entities），安全性由 hljs 保证。当前实现使用 `codeRef.current.innerHTML = result.value` 是 hljs 的推荐用法，风险可控
- 修复方向: 无需修改，但记录此处信任 hljs 的输出安全性

### [P2-7] `blobToDownload` 将 ZIP 内容转为 data URL 再下载，大文件可能超限

- 位置: `src/popup/sourcemap.mjs` `blobToDownload`
- 触发条件: 生成的 ZIP 文件超过浏览器 data URL 的最大长度限制
- 影响: Chrome 对 data URL 有大小限制（通常 2MB 左右用于导航，但 `chrome.downloads.download` API 对 data URL 的限制可能更高或不同）。如果 source map 包含大量推到 ZIP 的源文件，data URL 可能过长
- 修复方向: 使用 `URL.createObjectURL(blob)` 替代 `FileReader.readAsDataURL`，可处理任意大小的 blob

### [P2-8] Dashboard `SettingsSection` 保存回调中不检查 `sendMessage` 响应

- 位置: `src/dashboard/App.jsx` `SettingsSection.handleSave`
- 触发条件: `updateSettings` 消息响应 `ok: false`
- 影响: 无论 background 返回成功或失败，UI 都会显示 "Saved" 成功消息
- 修复方向: 检查响应的 `ok` 字段，失败时显示错误消息

### [INFO-4] 测试覆盖观察

- 总体: 188 个测试覆盖了主要路径
- **未覆盖的关键路径**:
  1. `fetchSourceMap` 的完整流程（inline base64 和外部 map URL 两个分支）— 仅在集成层面被 mock
  2. `compactStorageData` 的全链路未被直接测试（仅测试了 `buildCompactedStorageState`）
  3. `importSourceMapsForPage` 的错误路径（如 `persistVersionState` 失败后的状态）
  4. `onMessage` handler 中 `cleanupData` 当 `versionIndex` 为空时的快速返回路径 — 虽然实现正确但未被测试
  5. `service worker` 重启后 `ensureStorageReady` 恢复索引 + 旧 session 不复活的场景

### [INFO-5] antd `List` 组件已废弃警告

- 位置: `src/dashboard/App.jsx` `ImportMapsModal` 中使用了 `antd.List`
- 影响: 测试输出中显示 `Warning: [antd: List] The List component is deprecated`
- 修复方向: 迁移到 antd 6 推荐的替代组件

## 未覆盖区域
- `bundles/` 目录（构建产物，不审查）
- `coverage/` 目录（覆盖率报告，不审查）
