# Phase 3 — 存储/基础设施层（storage/index.mjs、storage/db.mjs、storage/compaction.mjs、storage/compression.mjs、storage/utils.mjs）

## 覆盖文件

- `src/background/storage/index.mjs`（全文）
- `src/background/storage/db.mjs`（全文）
- `src/background/storage/compaction.mjs`（全文）
- `src/background/storage/compression.mjs`（全文）
- `src/background/storage/utils.mjs`（全文）

## Findings

### F3-1 · P0 · `compactStorageData` 使用"先清空再写入"事务——中途失败导致永久数据丢失

**位置**：`storage/compaction.mjs`，`compactStorageData`  
**代码**：
```js
mapStore.clear();
blobStore.clear();

metas.forEach((meta) => {
  if (!desiredIdMap[meta.id]) versionStore.delete(meta.id);
});

storageState.desiredMetas.forEach((meta) => { versionStore.put(meta); });
storageState.desiredRefs.forEach((entry) => { mapStore.put(entry.value, entry.key); });
storageState.desiredBlobs.forEach((blob) => { blobStore.put(blob); });
```
**触发条件**：`mapStore.clear()` 和 `blobStore.clear()` 在同一 IDB 事务中，紧接着写入 `desiredRefs` 和 `desiredBlobs`。IndexedDB 事务在以下情况中止（`tx.onabort`）：quota exceeded、`tx.abort()` 被调用、浏览器内存压力、标签页关闭。  
**风险**：如果 `storageState.desiredBlobs` 数量巨大，在 put 过程中浏览器可能因为 storage quota 触发事务中止；此时 `mapStore` 和 `blobStore` 已经被清空，但新数据只写入了一部分，事务整体回滚。理论上 IDB 事务是原子的，回滚会恢复 `clear()` 删除的数据。**但**：`clear()` 后的 put 操作如果在事务提交前触发 quota exceeded，IndexedDB 规范要求回滚整个事务，应该能恢复原始数据。  

然而，更深层的问题是：`buildCompactedStorageState` 在事务外部执行了大量 `await`（包括 `hashString`、`prepareBlobRecordForStorage`），期间 **没有持有** IDB 事务，因此读写是分两步进行的（先读，再在新事务中写）。在读阶段和写阶段之间，另一个并发操作（如 `persistVersionState`）可能写入了新版本，导致 `compactStorageData` 的 `buildCompactedStorageState` 基于陈旧快照工作，最终在写事务中覆盖掉了并发写入的新版本。  

**具体影响场景**：
1. Tab 触发 `scheduleSessionPersist`（1400ms timer）
2. 用户触发 `cleanupData`（`runCleanupTasks`）
3. `buildCompactedStorageState` 开始读快照（`listAllVersionsRaw`）
4. `scheduleSessionPersist` timer 到期，`storageCompactionInProgress === true`，reschedule
5. `buildCompactedStorageState` 完成计算（基于步骤 3 的旧快照）
6. compaction 写事务执行 `mapStore.clear()` + `blobStore.clear()` + 写入旧快照内容
7. 新版本在步骤 4 被 reschedule，此后写入，但 compaction 已覆盖了期望状态

`storageCompactionInProgress` flag 确实阻止了 `scheduleSessionPersist` 在 compaction 进行中执行，但 flag 在 `compactStorageData()` 函数入口设置，而 `buildCompactedStorageState` 是长时间异步操作，期间 popupPort 的 `clearAll` / `clearOlderThan7d` 操作不受此 flag 保护，可能并发修改 DB。  

**修复方向**：
1. 将 `storageCompactionInProgress` 的保护范围扩展到 popupPort 的删除操作；或  
2. 在 compaction 写事务前重新读取最新版本列表，与 `buildCompactedStorageState` 的结果做差分，而不是无条件清空；或  
3. 改为"非清空式"的 upsert：计算出需要删除的孤立 blob/map，单独删除，而不是 clear()。

---

### F3-2 · P1 · `loadVersionRefsRaw` 中 `onsuccess = async` 导致 IDB 事务在 `await hashString` 处提前关闭

**位置**：`storage/db.mjs`，`loadVersionRefsRaw`  
**代码**：
```js
req.onsuccess = async () => {
  const value = req.result;
  if (typeof value === "string") {
    const mapHash = await hashString(value);   // ← IDB 事务在此点前已自动提交
    refs.push({ ..., mapHash, ... });
  }
  ...
  pending--;
  if (pending === 0) resolve(refs);
};
```
**触发条件**：当存储中存在遗留 string 格式的 map entry 时触发。`onsuccess` 的 async 函数体遇到 `await` 时立即挂起，将控制权返还给微任务队列，IDB 事务此时已没有活跃请求，会自动关闭。  
**影响**：对于 string 格式的 entry，`hashString` 可以正常执行（它不需要 IDB），但后续 `pending--` 的调用时机被延迟，**如果其他 `req.onsuccess` 也在 `await` 前就将 pending 减到 0**，`resolve` 会被提前调用（在所有 async ref 处理完成前），返回不完整的 refs 数组。  
**具体竞态**：假设 version 有 2 条 mapUrl，都是 string 格式。两个 `req.onsuccess` 几乎同时触发，各自 `await hashString`。但如果其中一个先完成 `pending--`（pending 从 2→1→0），`resolve(refs)` 被调用时另一个 async 操作还未 push 进 refs。  
**修复方向**：不在 `onsuccess` 内使用 async/await；改为先同步收集所有 values，在事务 `oncomplete` 后批量做 `Promise.all(values.map(v => hashString(v)))` 处理。（`loadStoredMapEntriesRaw` 中 `onsuccess` 虽然也是 async，但没有 await，不受此影响。）

---

### F3-3 · P1 · `persistVersionState` 中 `tx.oncomplete` 内写入 `state.versionIndex` 时使用的 `deltaByBlob` 与事务外的 `state.blobIndex` 可能不同步

**位置**：`storage/index.mjs`，`persistVersionState`  
**代码**：
```js
tx.oncomplete = () => {
  state.versionIndex[persistedMeta.id] = persistedMeta;

  Object.keys(deltaByBlob).forEach((blobId) => {
    const current = state.blobIndex[blobId];
    const nextCount = (current ? current.refCount : 0) + deltaByBlob[blobId];
    ...
  });
};
```
**风险**：`deltaByBlob` 基于 `previousRefs`（事务开始前加载的旧 refs）计算。如果两个并发 `persistVersionState` 调用在彼此提交之前都读取了旧 refs，两个 `tx.oncomplete` 都会以旧的 `state.blobIndex[blobId].refCount` 为基础加减，造成 blobIndex 与数据库实际 refCount 不一致（IDB 中已正确写入，内存中错误）。  
**触发条件**：高频采集场景中，两个 tab 几乎同时完成 session persist 时触发。  
**影响**：内存中 blobIndex 的 refCount 偏差导致：compaction 后续若依赖 blobIndex 做引用计数判断则出错；`storedBlobBytes` 计算错误；blob 被误判为孤立并在下次 compaction 中删除。  
**修复方向**：在 `tx.oncomplete` 内通过重新读取 DB 的方式同步 blobIndex（代价较高），或在内存更新时用原子化的 Map 操作（单线程 JS 中同一时间只有一个 oncomplete 回调执行，但多个事务可以并发进行）。实际上 JS 是单线程的，但多个 IDB 事务可以重叠进行，`oncomplete` 以 task 粒度串行执行，因此**此处实际上不会出现 oncomplete 并发**——但 `deltaByBlob` 的计算发生在事务**开始前**（`loadVersionRefsRaw` 是在事务外执行的），因此两个并发调用的快照可能都是旧状态。这是真实问题。

---

### F3-4 · P2 · `uniqueBlobId` 的碰撞解决策略（`::dup1`、`::dup2`）可能在 compaction 中累积历史后缀造成键膨胀

**位置**：`storage/utils.mjs`，`uniqueBlobId`  
**代码**：
```js
export function uniqueBlobId(blobMap, preferredBlobId, content) {
  let candidate = preferredBlobId;
  let suffix = 1;
  while (blobMap[candidate] && blobMap[candidate].content !== content) {
    candidate = `${preferredBlobId}::dup${suffix}`;
    suffix++;
  }
  return candidate;
}
```
**触发条件**：SHA-256 哈希碰撞概率极低，在正常使用中不会发生。但如果两个不同内容的文件恰好产生相同的 `blobStoreKey(siteKey, mapHash)`（即相同 siteKey + SHA-256 碰撞），会生成后缀键。  
**更实际的风险**：`buildSessionArtifacts` 在 `blobs[blobId] && blobs[blobId].content !== content` 时抛出 `hash collision detected`，而 `importSourceMapsForPage` 调用 `uniqueBlobId`（不抛出），两者处理策略不一致，compaction 也使用 `uniqueBlobId`。这意味着 compaction 会静默接受 hash 碰撞并创建 `::dup1` 键，而 session 采集会抛出错误并中断版本保存。  
**修复方向**：统一策略：要么所有路径都使用 `uniqueBlobId`（宽松），要么都做碰撞检测（严格）。

---

### F3-5 · INFO · `decodeBlobContent` 未处理 `DecompressionStream` 不存在的环境

**位置**：`storage/compression.mjs`  
**代码**：
```js
export async function decodeBlobContent(record) {
  ...
  if (!record.compression || record.compression === "identity") {
    return decoder.decode(bytes);
  }
  // 假设 compression === "gzip"
  return decoder.decode(await runTransformStream(DecompressionStream, "gzip", bytes));
}
```
`encodeBlobContent` 有 `typeof CompressionStream !== "function"` 的 fallback（降级为 identity），但 `decodeBlobContent` 对 `DecompressionStream` 不存在的情况没有防御。若在不支持 `DecompressionStream` 的环境中读取已压缩的 blob（如测试环境或老版本 Chrome），会直接抛出 `ReferenceError: DecompressionStream is not defined`。  
**修复方向**：在 `decodeBlobContent` 中对 `DecompressionStream` 存在性做检查，若不可用则记录错误并返回 null（以触发 graceful degradation）。

## 漏检复盘

- 检查了 IDB `onblocked` 处理 —— 已置 `state.dbPromise = null` 并 reject，允许重试
- 检查了 compaction 中 `storageCompactionInProgress` flag 在 finally 中清除 —— 正确
- 检查了 `withStoredByteSize` 中 storedByteSize 计算 —— refs 为空时返回 0，正确
- 检查了 `deleteVersions` 中 blobIndex 内存更新（oncomplete 内）—— 与 F3-3 相同问题，但 deleteVersions 通常不会并发
- 检查了 `cleanupLegacyDataTables` 对 DB 存储结构的只读查询 —— 无问题
- 检查了 `buildCompactedStorageState` 中 `upgradedRefs` 的双重计数风险（entry 处理阶段和 finalization 阶段各自累加）—— 存在可能的重复统计，但仅影响统计数字，不影响数据正确性
