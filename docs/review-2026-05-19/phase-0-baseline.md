# Phase 0 — Baseline

## 审查对象

**本次审查时间**：2026-05-19  
**代码库**：SourceD（Manifest V3 Chromium 扩展）  
**与历史 review 的主要差异**：`src/background/` 目录自 2026-03-31 版本以来已完成重构，原来的单文件模块（`runtime.mjs`、`runtime-handlers.mjs`、`sessions.mjs`、`storage.mjs`）已拆分为子目录结构，历史 review 中提到的大部分文件已不再存在于原路径。

## 重构后目录结构

```
src/background/
  index.js                    # 启动入口
  shared.mjs                  # 跨模块共享常量、state、工具函数
  runtime/
    index.mjs                 # registerRuntimeListeners / initializeRuntime
    handlers.mjs              # createWebRequestHandler / createPopupPortHandler / createRuntimeMessageHandler
  sessions/
    index.mjs                 # session 管理、buildSessionArtifacts、upsertSessionVersion、retryFailedMapFetch
    fetch.mjs                 # createSourceMapFetcher、fetchTextWithLimits、base64ToUtf8
  storage/
    index.mjs                 # persistVersionState、deleteVersions、loadVersionFiles、importSourceMapsForPage 等
    db.mjs                    # IndexedDB 访问封装（getDb、ensureStorageReady、raw 查询函数）
    compaction.mjs            # compactStorageData、runCleanupTasks、cleanupLegacyDataTables
    compression.mjs           # encodeBlobContent（gzip）、decodeBlobContent
    utils.mjs                 # storedBlobBytes、withStoredByteSize、prepareBlobMapForStorage、uniqueBlobId
```

## 历史已知问题回顾

| 历史 ID | 描述 | 当前状态 |
|--------|------|---------|
| H1 | `sessions.mjs:116` 复用版本时不刷新 `lastSeenAt` → 可被提前清理 | **已修复**：`upsertSessionVersion` 中 `updateExistingVersionMeta` 现在明确更新 `lastSeenAt` |
| H2 | 异步消息通道在 rejection 时不回复，导致通道悬挂 | **已修复**：所有 `return true` 路径都有 `.catch()` 分支，能回传 `ok: false` |
| H3 | 启动时监听器注册先于 settings 加载 | **已修复**：`initializeRuntime()` 以 `Promise.all([ensureStorageReady(), loadSettings()])` 串联完成后才调用 `registerRuntimeListeners()` |
| H4 | 新版本写入内存在持久化提交前 | **已修复**：`state.versionIndex[newId] = meta` 移到了 `tx.oncomplete` 回调中 |
| H5 | compaction 误用 `all_maps_missing` 标注部分缺失情况 | **部分改善**：当前逻辑对每条 map entry 逐个处理，只将 `recoveredRefsByVersion[meta.id]` 为空时标记为 `all_maps_missing`；仍无法区分"全部丢失"与"部分丢失"（因为有内容的 ref 才进入 recovered 集合） |

## 技术栈与风险分布

| 层 | 模块 | 风险等级 |
|---|------|---------|
| 接入/边界层 | `runtime/handlers.mjs` | 中 |
| 应用编排层 | `runtime/index.mjs`、`sessions/index.mjs` | 中 |
| 领域/状态层 | `shared.mjs`（state）、`sessions/index.mjs` | 高 |
| 基础设施/持久化层 | `storage/index.mjs`、`storage/db.mjs`、`storage/compaction.mjs` | 高 |
| 工具函数 | `sessions/fetch.mjs`、`storage/compression.mjs`、`storage/utils.mjs` | 中 |

## 重点风险类型（预判）

- 异步失败路径 / 半完成状态写入窗口
- compaction 中"先清空后写入"的数据窗口
- 内联 source map base64 解码边界
- `loadStoredMapEntriesRaw` 并发 pending 计数的竞态
- `retryFailedMapFetch` 的状态一致性
- `fetchTextWithLimits` 的 `httpError` 路径传递是否完整
