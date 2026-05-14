# 修复计划

## 批次划分

### Batch A: 立即修复的 P0/P1（安全和数据完整性）

**优先级最高，建议在当前迭代内完成。**

#### A1. 修复 `clearAll` 竞态 (P0-2)
- 目标问题: `clearAll` 在 `deleteVersions` 前后读取不同快照的 `state.versionIndex`
- 涉及文件: `src/background/runtime.mjs`
- 修复: 在 `.then()` 前捕获 `const ids = Object.keys(state.versionIndex)`，后续使用 `ids`
- 验证: 添加测试模拟在 deleteVersions 执行期间有新 version 写入的场景

#### A2. 修复 `upsertSessionVersion` 幽灵记录 (P0-3)
- 目标问题: 新建 version 时 `persistVersionState` 成功但后续步骤失败导致 `versionsByPage` 缺少条目
- 涉及文件: `src/background/sessions.mjs`
- 修复: 将 `ensurePageBucket(pageUrl).unshift(newId)` 和 `state.versionIndex[newId] = meta` 移到 `prunePageHistory` 之前
- 验证: 添加测试 mock `prunePageHistory` 失败，验证 version 仍在索引中可见

#### A3. 消除 `dangerouslySetInnerHTML` (P0-4)
- 目标问题: `options/App.jsx` 中 i18n 消息通过 `dangerouslySetInnerHTML` 注入
- 涉及文件: `src/options/App.jsx`, `_locales/en/messages.json`, `_locales/zh_CN/messages.json`
- 修复: 将 `<code>xxx</code>` 模式从 i18n 消息中移除，改为在 React 中拆分为文本+`<code>` 组件
- 验证: 确认 options 页面渲染正确，移除 `dangerouslySetInnerHTML`

#### A4. 给 `fetchSourceMap` 添加安全边界 (P0-1)
- 目标问题: 无超时、无大小限制、无去重、回调不检查 session 有效性
- 涉及文件: `src/background/sessions.mjs`
- 修复:
  1. 使用 `AbortController` 添加 30s 超时
  2. 检查 `Content-Length`，拒绝超过 50MB 的响应
  3. 使用 `Set` 记录正在 fetch 的 URL，避免重复
  4. 回调中检查 `state.tabSessions[session.tabId] === session`
- 验证: 添加 `fetchSourceMap` 的单元测试，覆盖超时和大文件场景

#### A5. 给 `port.onMessage` 添加错误处理 (P1-2, P1-8)
- 目标问题: `clearAll` 和 `clearOlderThan7d` 的 `deleteVersions` 失败无反馈
- 涉及文件: `src/background/runtime.mjs`
- 修复: 添加 `.catch()` 处理，通过 port 回传错误
- 验证: 添加测试模拟 deleteVersions 失败场景

#### A6. 给 `onMessage` 添加默认分支 (P1-1)
- 目标问题: 未知 action 不调用 sendResponse
- 涉及文件: `src/background/runtime.mjs`
- 修复: 在最后添加 `sendResponse({ ok: false, error: "unknown action" })`
- 验证: 添加测试发送未知 action

#### A7. 修复 inline base64 source map 解码 (P1-9)
- 目标问题: `atob` 无法正确处理 UTF-8 编码的 source map
- 涉及文件: `src/background/sessions.mjs`
- 修复: 使用 `Uint8Array` + `TextDecoder` 替代 `atob`
- 验证: 添加测试使用包含非 ASCII 字符的 base64 source map

### Batch B: 本迭代修复的 P1

#### B1. `fetchSourceMap` 回调检查 session 有效性 (P1-3)
- 涉及文件: `src/background/sessions.mjs`, `src/background/runtime.mjs`
- 修复: 在回调中添加 `if (state.tabSessions[session.tabId] !== session) return`
- 已包含在 A4 中

#### B2. 修复 `defaultZipBaseName` 时间戳 (P1-7)
- 涉及文件: `src/popup/sourcemap.mjs`
- 修复: 将 `timestampSlug()` 改为 `timestampSlug(new Date().toISOString())`
- 验证: 确认下载的 ZIP 文件名包含实际时间

#### B3. 评估 `hashString` 碰撞风险 (P1-4)
- 涉及文件: `src/background/shared.mjs`
- 修复: 短期在 `buildSessionArtifacts` 中添加碰撞检测；长期迁移到 `crypto.subtle.digest`
- 验证: 添加测试验证碰撞检测逻辑

#### B4. `compactStorageData` 数据窗口保护 (P1-6)
- 涉及文件: `src/background/storage.mjs`
- 修复: 在 compact 执行前设置标志位暂停 session persist，完成后恢复
- 验证: 添加测试验证 compact 期间不会丢失新写入的数据

### Batch C: 技术债或需要更大改造

#### C1. `blobToDownload` 改用 `createObjectURL` (P2-7)
- 涉及文件: `src/popup/sourcemap.mjs`
- 修复: 将 `FileReader.readAsDataURL` 替换为 `URL.createObjectURL`

#### C2. Dashboard `SettingsSection` 检查保存响应 (P2-8)
- 涉及文件: `src/dashboard/App.jsx`
- 修复: 检查 `sendMessage` 回调中的 `ok` 字段

#### C3. 迁移 `antd.List` 到推荐替代组件 (INFO-5)
- 涉及文件: `src/dashboard/App.jsx`
- 修复: 根据 antd 6 迁移指南替换

#### C4. `getDb` 处理 `onblocked` 事件 (P2-3)
- 涉及文件: `src/background/storage.mjs`
- 修复: 添加 `req.onblocked` handler

#### C5. 补充缺失的测试覆盖 (INFO-4)
- 涉及文件: `tests/`
- 覆盖: `fetchSourceMap` 全路径、`compactStorageData` 全链路、`importSourceMapsForPage` 错误路径

## 建议执行顺序

```
A1 → A2 → A3 → A4 → A5/A6 → A7 → B2 → B3 → B4 → C1–C5
```

- A1/A2 是数据完整性问题，修复范围最小（改几行代码），应最先修复
- A3 是安全问题但当前内容安全，优先级略低于数据问题
- A4 修复范围较大，需要仔细设计去重和超时机制
- Batch B 和 Batch C 可在后续迭代中处理
