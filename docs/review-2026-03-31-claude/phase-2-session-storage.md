# Phase 2 审查报告: 会话与存储层

> 日期: 2026-03-31
> 文件数: 3
> 发现: P0(1) / P1(3) / P2(3) / INFO(2)

## 已审查文件
- `src/background/sessions.mjs`
- `src/background/shared.mjs`
- `src/background/storage.mjs`

## Findings

### [P0-3] `upsertSessionVersion` 新建 version 时先写磁盘后更新内存，失败不回滚已成功的内存写入

- 位置: `src/background/sessions.mjs` `upsertSessionVersion` 新建 version 分支（最后一个代码路径）
- 触发条件: 首次保存 session 时 `persistVersionState` 成功，但后续 `prunePageHistory` 失败
- 影响: 如果 `prunePageHistory` 抛异常，`persistVersionState` 已将数据写入 IDB 和更新了 `state.versionIndex`（在 `persistVersionState` 的 `tx.oncomplete` 回调中），但 `.then()` 链中后续的 `ensurePageBucket(...).unshift(newId)` 和 `state.versionIndex[newId] = meta` 不会执行，导致:
  1. IDB 中有 version 记录但 `state.versionsByPage` 中缺少对应条目 — version 变成"幽灵记录"，无法通过 UI 看到或删除
  2. 下次 service worker 重启时 `rebuildIndexes` 会重建索引修复此问题，但在当前生命周期内数据不一致

  注意: 测试 `"does not leave a new version in memory when persistence fails"` 仅覆盖了 `persistVersionState` 本身失败的路径，未覆盖中间步骤失败。

- 修复方向: 将 `ensurePageBucket(...).unshift(newId)` 和 `state.versionIndex[newId] = meta` 的更新放在 `persistVersionState` 内部的 `tx.oncomplete` 中，确保原子性；或在 `.then()` 中将内存更新提前到 `prunePageHistory` 之前

### [P1-4] `hashString` 使用 32 位 FNV-1a 哈希，碰撞概率非平凡

- 位置: `src/background/shared.mjs` `hashString`
- 触发条件: 两个不同内容的 source map 恰好产生相同的 32 位哈希
- 影响: `blobStoreKey` 使用 `siteKey::mapHash` 作为 blob 去重键。如果同一个站点下两个不同内容的 map 发生碰撞，后者会覆盖前者的 blob 内容（或引用计数错误），导致下载出的源码文件损坏
- 修复方向:
  - 短期: 在 `buildSessionArtifacts` 中对碰撞情况做检测（比较 content）
  - 长期: 使用 crypto.subtle.digest('SHA-256', ...) 替代，在 service worker 中可用

### [P1-5] `persistVersionState` 中内存索引更新与 IDB 事务不原子

- 位置: `src/background/storage.mjs` `persistVersionState` 的 `tx.oncomplete` 回调
- 触发条件: 在 `tx.oncomplete` 执行期间，另一个并发操作读取 `state.blobIndex`
- 影响: `tx.oncomplete` 中循环更新 `state.blobIndex`，在循环中间状态是不一致的，但 JavaScript 单线程保证循环内不会被中断。实际风险较低，但如果 `deltaByBlob` 键很多且有 `setTimeout` 回调排队等待执行，理论上没有中断点，因此标记为 P1 观察项。
- 修复方向: 无需立即修改，但建议将索引更新放入一个单独的 commit 函数中做 batch 更新

### [P1-6] `compactStorageData` 中 `mapStore.clear()` + `blobStore.clear()` 的清空-重写策略存在数据窗口风险

- 位置: `src/background/storage.mjs` `compactStorageData`
- 触发条件: compact 事务执行时，另一个标签页的 session persist 完成写入
- 影响: `compactStorageData` 在事务开始时 `clear()` 整个 MAP_STORE 和 BLOB_STORE，然后重新写入。IDB 事务保证原子性，所以事务要么全部成功要么全部失败，不存在中间状态。但如果在 `buildCompactedStorageState`（读阶段）和实际事务（写阶段）之间有新数据写入，新数据会在 compact 事务中被丢弃。
- 修复方向: 在 compact 事务执行前暂停 session persist 调度，或在事务后重新扫描新写入

### [P2-3] `getDb` 未处理 IndexedDB `onblocked` 事件

- 位置: `src/background/storage.mjs` `getDb`
- 触发条件: 其他标签页或同一扩展的其他实例持有旧版本数据库连接时
- 影响: `indexedDB.open` 的 `onblocked` 事件永远不会被处理，`dbPromise` 会永久 pending，所有后续操作都会卡住
- 修复方向: 添加 `req.onblocked` handler，设置超时或向用户报错

### [P2-4] `loadStoredMapEntriesRaw` 中所有 `meta.mapUrls` 为空时正确处理，但单个 get 失败会 reject 整个批次

- 位置: `src/background/storage.mjs` `loadStoredMapEntriesRaw`
- 触发条件: IDB 中某个 map entry 的 get 失败
- 影响: 任何一个 `req.onerror` 触发都会 reject 整个 promise，导致上层操作完全失败。对于 compaction 流程来说这意味着整个 compact 操作失败。
- 修复方向: 考虑单条失败时跳过而非 reject 整个批次，尤其在 compaction 场景下

### [P2-5] `rebuildIndexes` 中 `blobs` 参数为 `undefined` 时不会崩溃但 blobIndex 会丢失数据

- 位置: `src/background/shared.mjs` `rebuildIndexes`
- 触发条件: 调用方传入 `undefined` 作为 blobs 参数
- 影响: `(blobs || []).forEach(...)` 已正确处理 undefined。实际不是 bug，但 `rebuildIndexes` 在执行前会先清空 `state.blobIndex = {}`，如果只传了 versions 没传 blobs，旧的 blobIndex 数据会丢失。当前唯一调用方 `ensureStorageReady` 总是同时传入二者。
- 修复方向: 无需修改，记录为设计约束

### [INFO-2] `versionLabel` 使用 `en-US` locale 硬编码

- 位置: `src/background/shared.mjs` `versionLabel`
- 影响: 用户浏览器若设为其他 locale，version label 中的日期格式仍为 en-US 格式
- 修复方向: 使用 `chrome.i18n.getUILanguage()` 获取用户 locale（但 background service worker 中对此的支持需验证）

### [INFO-3] `state` 对象是可变全局单例

- 位置: `src/background/shared.mjs`
- 影响: 整个 background 模块共享 `state` 可变引用，任何模块都可以修改。当前项目规模下不是问题，但如果扩展功能增长，可能成为维护性风险。
- 修复方向: 无需立即处理

## 未覆盖区域
- 无
