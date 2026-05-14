# 代码审查汇总

> 日期: 2026-03-31
> 范围: 整个仓库 (`/Users/tautcony/Documents/repos/SourceD`)
> Phase 数: 5 (Phase 0 baseline + Phase 1–4)

## 统计
- P0: 4
- P1: 9
- P2: 9
- INFO: 6

## 高优先级问题

### P0

| ID | 标题 | 位置 | Phase |
|---|---|---|---|
| P0-1 | `fetchSourceMap` 缺少超时控制和响应大小限制 | `sessions.mjs` | 1 |
| P0-2 | `clearAll` 操作竞态导致数据残留 | `runtime.mjs` | 1 |
| P0-3 | `upsertSessionVersion` 新建 version 时部分步骤失败导致幽灵记录 | `sessions.mjs` | 2 |
| P0-4 | `options/App.jsx` 中 `dangerouslySetInnerHTML` 的 XSS 隐患 | `options/App.jsx` | 3 |

### P1

| ID | 标题 | 位置 | Phase |
|---|---|---|---|
| P1-1 | `onMessage` 监听器缺少默认分支和消息校验 | `runtime.mjs` | 1 |
| P1-2 | `port.onMessage` 中 `deleteVersions` 失败无错误处理 | `runtime.mjs` | 1 |
| P1-3 | `fetchSourceMap` 回调不检查 session 是否仍有效 | `runtime.mjs` | 1 |
| P1-4 | `hashString` 32 位 FNV-1a 碰撞概率 | `shared.mjs` | 2 |
| P1-5 | `persistVersionState` 内存索引更新非原子 | `storage.mjs` | 2 |
| P1-6 | `compactStorageData` 清空-重写策略数据窗口 | `storage.mjs` | 2 |
| P1-7 | `defaultZipBaseName` 时间戳始终为 "unknown-time" | `sourcemap.mjs` | 3 |
| P1-8 | 错误传播不一致 — `clearAll`/`clearOlderThan7d` 吞错误 | `runtime.mjs` | 4 |
| P1-9 | inline base64 source map 的 `atob` 无 charset 处理 | `sessions.mjs` | 4 |

## 各 Phase 摘要

- **Phase 0 (Baseline)**: 识别了 5 个源码模块目录、6 个 UI 文件。测试全部通过，lint 无错误。
- **Phase 1 (运行时与边界层)**: 发现 2 个 P0 和 3 个 P1。主要集中在 `fetchSourceMap` 缺少安全边界、消息监听器健壮性不足、以及 `clearAll` 竞态。
- **Phase 2 (会话与存储层)**: 发现 1 个 P0 和 3 个 P1。核心问题是 `upsertSessionVersion` 的事务原子性缺陷和哈希碰撞风险。IndexedDB 操作整体健壮。
- **Phase 3 (UI 与测试层)**: 发现 1 个 P0 和 1 个 P1。`dangerouslySetInnerHTML` 是唯一的 P0 问题。测试覆盖良好但缺少若干关键失败路径。
- **Phase 4 (横切审查)**: 发现 2 个 P1。错误传播不一致和 base64 解码问题跨越多个模块。

## 跨模块问题

1. **错误传播一致性**: `onMessage` 中的异步处理器一致地使用 `.catch()` 回传错误，但 `port.onMessage` 中的处理器（`clearAll`, `clearOlderThan7d`）遗漏了错误处理 — 这是同一模块中的不一致。
2. **内存-磁盘一致性**: `persistVersionState` 的 `tx.oncomplete` 准确更新内存索引，但上层调用者（`upsertSessionVersion`）的后续步骤如果失败，可能导致内存索引与 IDB 数据不一致。service worker 重启时 `rebuildIndexes` 可自愈，但当前生命周期内不一致。
3. **fetch 安全**: `fetchSourceMap` 是唯一的远程数据入口点，缺少超时、大小限制和去重，且回调不检查 session 有效性。

## 未覆盖区域

- `scripts/build-dist.mjs` 和 `scripts/package-release.mjs` — 构建脚本，风险较低
- `bundles/` 和 `coverage/` — 生成产物
- `_locales/` 翻译文件 — 内容由开发者控制，已在 P0-4 中标记为 `dangerouslySetInnerHTML` 的间接风险源
