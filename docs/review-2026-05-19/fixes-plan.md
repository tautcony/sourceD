# Fixes Plan — 2026-05-19

## Batch 1：数据安全与正确性（P0/P1，高影响，先行修复）

### Fix 1 · F2-1 / F3-2 — 修复 `loadVersionRefsRaw` 中 `async onsuccess` 竞态

**文件**：`src/background/storage/db.mjs`  
**影响**：P0 级根因之一，遗留 string 格式 entry 在多条并发 pending 时返回不完整 refs  
**复杂度**：中  
**修改方向**：
1. 将 `req.onsuccess` 改为同步函数，先收集所有 `(meta, mapUrl, value)` 三元组
2. 在所有 IDB 请求完成后（`pending === 0` 时），对 string 格式的 value 批量做 `await Promise.all(values.map(v => hashString(v)))`
3. 最终 resolve 完整 refs

```js
// 伪代码
req.onsuccess = () => {   // 非 async
  const value = req.result;
  rawResults.push({ meta, mapUrl, value });
  pending--;
  if (pending === 0) processResults(rawResults).then(resolve).catch(reject);
};

async function processResults(rawResults) {
  const refs = [];
  for (const { meta, mapUrl, value } of rawResults) {
    if (typeof value === "string") {
      const mapHash = await hashString(value);
      refs.push({ ..., mapHash, ... });
    } else if (value && value.blobId) {
      refs.push({ ..., blobId: value.blobId, ... });
    }
  }
  return refs;
}
```

**验证**：新增测试：version 含 2 条遗留 string 格式 mapUrl，验证返回的 refs 数量等于 mapUrls.length。

---

### Fix 2 · F3-1 — 修复 compaction 并发窗口：改为增量 upsert 而非 clear + rewrite

**文件**：`src/background/storage/compaction.mjs`  
**影响**：P0，并发写入版本可能在 compaction 后丢失  
**复杂度**：高  
**修改方向**：
1. 将 `storageCompactionInProgress` flag 的保护扩展到 popupPort 的 `clearAll`、`clearOlderThan7d`、`deleteVersion` 消息（在 handlers 中检查 flag，若 compaction 进行中则排队或拒绝）；
2. 或：**改为增量模式**：计算出需要删除的孤立 versionId 集合和孤立 blobId 集合，通过 `deleteVersions` 删除，而非 `mapStore.clear()` + `blobStore.clear()`。这样每次只删除已确认无用的记录，不存在"先清空后写入"的窗口。  
3. 同时在 `buildCompactedStorageState` 完成后、写事务开始前重新从 DB 读取最新版本列表，用于差分而不是直接以旧快照覆盖。

**验证**：
- 新增测试：在 compaction 进行中并发调用 `deleteVersions`，验证 compaction 结束后两个操作的结果合并正确
- 验证 `mapStore` 和 `blobStore` 内容与预期一致

---

### Fix 3 · F2-2 — 为 `retryFailedMapFetch` 增加 per-versionId 互斥保护

**文件**：`src/background/sessions/index.mjs`  
**影响**：P1，并发重试同一版本导致 blobIndex refCount 损坏  
**复杂度**：低  
**修改方向**：
```js
const retryInProgress = new Set();

export async function retryFailedMapFetch(versionId, mapUrl) {
  const key = `${versionId}::${mapUrl}`;
  if (retryInProgress.has(key)) throw new Error("Retry already in progress");
  retryInProgress.add(key);
  try {
    // ... 原有逻辑
  } finally {
    retryInProgress.delete(key);
  }
}
```

**验证**：新增测试：并发两次调用同一 (versionId, mapUrl)，第二次应抛出 "Retry already in progress"，blobIndex.refCount 最终正确。

---

### Fix 4 · F3-3 — 修复 `persistVersionState` 并发时 blobIndex 内存更新基于陈旧 refCount

**文件**：`src/background/storage/index.mjs`  
**影响**：P1，blobIndex 内存与 DB 不一致  
**复杂度**：中  
**修改方向**：在 `tx.oncomplete` 内更新 `state.blobIndex` 时，不依赖事务外读取的 `current.refCount`，而是从 IDB 写入的新值直接反推，或在 `oncomplete` 后重新读取所有变化的 blobId 的最新记录。  
一个更简单的解法：为 `state.blobIndex` 的 refCount 更新操作添加版本戳或使用"以 DB 为准"的 lazy 加载策略（下次读取时从 DB 刷新），但这会增加复杂度。  
最简修复：在 `oncomplete` 中对每个变化的 blobId，通过 `db.transaction(BLOB_STORE, "readonly").objectStore(BLOB_STORE).get(blobId)` 读取实际写入的 refCount，更新 blobIndex。

**验证**：新增测试：两个并发 `persistVersionState` 调用，验证 blobIndex 中 refCount 与 blobStore 实际值一致。

---

## Batch 2：逻辑修复与防御（P1/P2，中等影响）

### Fix 5 · F1-4 — `loadSettings` 失败时清除 `storageReadyPromise`

**文件**：`src/background/runtime/index.mjs`  
**影响**：P1，半初始化状态下 settings 为 null  
**复杂度**：低  
**修改方向**：
```js
export function initializeRuntime() {
  chrome.action.setBadgeText({ text: "" });
  return Promise.all([ensureStorageReady(), loadSettings()]).then((results) => {
    registerRuntimeListeners();
    return results;
  }).catch((err) => {
    // 清除已缓存的 promise，允许重试
    state.storageReadyPromise = null;
    throw err;
  });
}
```

**验证**：新增测试：模拟 `loadSettings` 失败，验证 `state.storageReadyPromise` 被清除，`state.settings` 不为 stale 值。

---

### Fix 6 · F1-1 — 为 `getDashboardData` 分支添加 `return`

**文件**：`src/background/runtime/handlers.mjs`  
**影响**：P2，缺少 return 语句  
**复杂度**：极低  
**修改方向**：
```js
if (message.action === "getDashboardData") {
  sendResponse({ ... });
  return;  // ← 添加
}
```

---

### Fix 7 · F1-2 — 移除 `cleanupData` 中的死代码兜底路径

**文件**：`src/background/runtime/handlers.mjs`  
**影响**：P2，死代码混淆意图  
**修改方向**：直接调用 `runCleanupTasks()`，移除 `|| (() => {...})` 兜底。

---

### Fix 8 · F3-5 — `decodeBlobContent` 对 `DecompressionStream` 不存在的防御

**文件**：`src/background/storage/compression.mjs`  
**影响**：INFO/P2  
**修改方向**：
```js
if (record.compression === "gzip") {
  if (typeof DecompressionStream !== "function") {
    console.error("[SourceD] DecompressionStream not available, cannot decode gzip blob");
    return null;
  }
  return decoder.decode(await runTransformStream(DecompressionStream, "gzip", bytes));
}
```

---

### Fix 9 · F2-5 — `base64ToUtf8` data URI 格式校验

**文件**：`src/background/sessions/fetch.mjs`  
**影响**：INFO，伪造 map 键在 UI 中显示为假 URL  
**修改方向**：
```js
const commaIdx = mapRef.indexOf(",");
if (commaIdx === -1) {
  console.warn("[SourceD] inline map missing data URI comma", mapRef.slice(0, 80));
  fanOut(`${jsUrl}.map`, null);
  return;
}
const b64 = mapRef.slice(commaIdx + 1);
```

---

## Batch 3：测试补充（F4-3）

### Fix 10 — 补充缺失测试

| 测试项 | 目标文件 |
|--------|---------|
| `loadVersionRefsRaw` 多 string entry 并发处理 refs 完整性 | `tests/background.db.test.js` |
| `retryFailedMapFetch` 并发调用互斥保护 | `tests/background.sourceMaps.test.js` 或新增 |
| `decodeBlobContent` `DecompressionStream` 不可用时返回 null | `tests/background.compression.test.js` |
| data URI 无逗号时 fanOut null 且不记录假 URL | `tests/background.sourceMaps.test.js` |
| `initializeRuntime` loadSettings 失败后 `storageReadyPromise` 清除 | `tests/background.test.js` |

## 推荐执行顺序

1. **Fix 1**（`loadVersionRefsRaw` async onsuccess）—— 影响所有遗留数据加载路径，先行
2. **Fix 2**（compaction 增量模式）—— 最高影响，但复杂度高，可分两步：先扩展 flag 保护范围，再改增量模式
3. **Fix 3**（retryFailedMapFetch 互斥）—— 低复杂度，优先实施
4. **Fix 5**（loadSettings 失败清除 promise）
5. **Fix 4**（persistVersionState blobIndex 内存同步）—— 需要较多测试配合
6. **Fix 6 / Fix 7**（getDashboardData return、死代码清理）—— 极低成本，随手修复
7. **Fix 8 / Fix 9**（decodeBlobContent 防御、data URI 校验）
8. **Fix 10**（测试补充）—— 贯穿前面所有修复
