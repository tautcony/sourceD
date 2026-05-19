# Review Summary — 2026-05-19

## 概述

本次审查基于重构后的 SourceD 代码库（background 模块已从单文件拆分为 `runtime/`、`sessions/`、`storage/` 子目录）。历史 2026-03-31 review 中报告的 5 个高/中优先级问题均已修复。本次新发现 **11 个问题**，其中 P0 × 1，P1 × 5，P2 × 3，INFO × 2。

## 统计

| 级别 | 数量 |
|------|------|
| P0   | 1    |
| P1   | 5    |
| P2   | 3    |
| INFO | 2    |
| 合计 | 11   |

## 按优先级汇总

### P0

#### F3-1 · `compactStorageData` 并发窗口导致新写入版本在 compaction 后丢失

`storage/compaction.mjs`：`buildCompactedStorageState` 基于时间点快照（`listAllVersionsRaw`）计算目标状态，然后以 `mapStore.clear()` + `blobStore.clear()` + 重写的模式提交写事务。在快照读取和写事务提交之间，popupPort 的 `clearAll`/`clearOlderThan7d` 等操作不受 `storageCompactionInProgress` flag 保护，可并发修改 DB，导致 compaction 写入陈旧状态（覆盖掉并发写入的新数据）。

### P1

#### F2-1 · `loadVersionRefsRaw` 中 `async onsuccess` 竞态导致 Promise 提前 resolve，返回不完整 refs

`storage/db.mjs`：`req.onsuccess = async () => { const mapHash = await hashString(value); ... pending--; }` — 多个 async 回调的 `await` 点延迟 `pending--`，当其他回调先完成时 `pending` 可能在最后一个 async 操作完成前归零，`resolve(refs)` 被提前调用，返回不完整的 refs 数组，导致部分 map 内容丢失。

#### F2-2 · `retryFailedMapFetch` 并发调用同一 version 导致 blobIndex refCount 损坏

`sessions/index.mjs`：两个并发的 404 重分类调用都以旧 `meta` 为 `previousMeta` 调用 `persistVersionState`，`deltaByBlob` 两次各减 1，blobIndex 中 refCount 变为负值或 blob 被错误删除。

#### F1-4 · `loadSettings` 失败后 `state.storageReadyPromise` 不清除，导致半初始化运行

`runtime/index.mjs`：`ensureStorageReady` 成功但 `loadSettings` 失败时，`state.storageReadyPromise` 已赋值，`state.settings` 为 null，后续 `currentSettings()` 返回默认值（含 `detectionEnabled: true`），即使用户已配置禁用采集也会继续工作。

#### F3-2 · `loadVersionRefsRaw` `async onsuccess` 中 `await` 点导致 IDB 事务处于 inactive 状态

与 F2-1 同根因（`db.mjs` 中 `async onsuccess` 与 IDB 事务生命周期不兼容），在遗留 string 格式 entry 路径下的实际 IDB 事务 inactive 问题。

#### F3-3 · `persistVersionState` 并发调用基于陈旧 refCount 更新 blobIndex

`storage/index.mjs`：`deltaByBlob` 在事务外计算，两个并发调用的 `tx.oncomplete` 都基于事务提交前读取的旧 `state.blobIndex[blobId].refCount` 计算 nextCount，造成 blobIndex 内存与 DB 不一致，进而影响下次 compaction 的引用计数判断。

### P2

#### F1-1 · `getDashboardData` 分支缺少 `return` 语句

`runtime/handlers.mjs`：`sendResponse(...)` 后函数继续执行，没有 `return`，为未来新增代码引入潜在风险。

#### F1-2 · `cleanupData` 兜底路径是永远不执行的死代码

`runtime/handlers.mjs`：`runCleanupTasks || (...)` 中的匿名函数永远不执行，掩盖了如果导入被移除会静默运行不同逻辑的风险。

#### F4-3 · 测试覆盖缺口：多个 P0/P1 缺陷无测试

`tests/`：F2-1、F2-2、F3-1 的触发场景均无测试覆盖；`decodeBlobContent` 降级路径、data URI 格式错误路径也缺失。

### INFO

#### F1-3 · `chrome.tabs.get` 回调中缺少 try/catch

`runtime/handlers.mjs`：`getOrCreateSession` 或 `isValidSourceMap` 抛出异常时，异常会冒泡到 Chrome 的回调层，导致 background service worker 静默崩溃。

#### F4-4 · `sanitizePath` 中保留了一处活跃的 `console.warn`，与 `sanitizeFilename` 行为不一致

`shared/utils.mjs`：低风险噪音，但行为不一致。

## 跨模块系统性问题

### 1. `async onsuccess` 与 IDB 事务生命周期不兼容（F2-1 / F3-2）

`loadVersionRefsRaw` 和 `loadStoredMapEntriesRaw` 中均将 `onsuccess` 声明为 `async` 函数。JavaScript 中 `async` 函数遇到 `await` 会挂起并将控制权归还给事件循环，IDB 事务在此时已没有活跃请求，规范要求其自动 commit。这是一个**跨调用链的系统性反模式**，凡使用这两个函数的所有路径在遗留数据路径下均受影响。

### 2. 内存索引更新与 IDB 事务提交时序（F3-3 / F2-2）

多处代码在 `tx.oncomplete` 中基于事务外读取的旧 state 更新内存索引。MV3 background service worker 是单线程的，`oncomplete` 串行执行，但多个 IDB 事务可以重叠进行（事务是异步提交的），导致"先读后写"的内存更新基于陈旧状态。这是一个**设计级问题**，需要考虑用 per-operation 串行化或每次 oncomplete 后重新从 DB 加载 blobIndex。

### 3. `storageCompactionInProgress` 保护范围不完整（F3-1）

该 flag 只保护了 `scheduleSessionPersist`（在 timer 回调中检查），但未保护 popupPort 的 clearAll、clearOlderThan7d、deleteVersion 操作。需要统一保护边界或改为非清空式 compaction。

## 差异化反证审查（漏检模式横向复查）

| 模式 | 结论 |
|------|------|
| 所有分发入口 / 命令入口是否都有默认分支 | ✅ `createRuntimeMessageHandler` 最末尾有 `sendResponse({ ok: false, error: "unknown action" })` |
| 所有异步链路是否检查失败、取消、超时、幂等/去重 | ⚠️ `retryFailedMapFetch` 缺并发保护（F2-2）；其他链路已有 try/catch |
| 所有状态写入链路是否检查"顺序错误导致半完成状态" | ⚠️ `persistVersionState` blobIndex 更新在 oncomplete 内基于陈旧状态（F3-3）；compaction 并发窗口（F3-1） |
| 所有重建型批处理/清理/迁移链路是否存在"先移除后重建"的数据窗口 | ⚠️ compaction 的 `mapStore.clear()` + `blobStore.clear()` 是先清空后写入，IDB 事务保证原子性，但并发读写窗口未封闭（F3-1） |
| 所有内容渲染点、富文本点、导出链路是否检查安全边界 | ✅ ZIP 导出路径经过 `sanitizePath`，`..` 遍历已防护；无 innerHTML 注入点 |
| 所有高杠杆工具函数是否检查编码、时间、摘要碰撞、兼容性 | ⚠️ `decodeBlobContent` 对 `DecompressionStream` 不存在无防御（F3-5）；`uniqueBlobId` 与 `buildSessionArtifacts` 碰撞处理不一致（F3-4） |

## 未覆盖区域

- `src/dashboard/App.jsx`、`src/dashboard/VersionPanel.jsx`、`src/dashboard/CodePreview.jsx`：本次审查未深入覆盖 dashboard UI 组件的 React 状态管理细节（async state 切换、旧数据闪回）
- `src/options/`：仅覆盖了消息协议层，未审查 options UI 本身
- Playwright 浏览器测试（`tests/__screenshots__`）：截图 baseline 有效性未做验证
