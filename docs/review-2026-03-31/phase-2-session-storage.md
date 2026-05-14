# Phase 2 审查报告: 状态与持久化层

> 日期: 2026-03-31
> 文件数: 4
> 发现: P0(0) / P1(1) / P2(1) / INFO(0)

## 已审查文件
- `src/background/sessions.mjs`
- `src/background/storage.mjs`
- `src/background/db.mjs`
- `src/background/shared.mjs`

## Findings

### [P1] `chrome.storage.local` 失败不会反馈给调用方, 设置可以“假成功”并让内存状态与持久化状态分叉
- 位置: `src/background/storage.mjs:250`, `src/background/storage.mjs:259`
- 触发条件: `chrome.storage.local.get/set` 因 quota、宿主禁用、浏览器异常等失败并通过 `chrome.runtime.lastError` 报错
- 影响: `loadSettings()` 和 `saveSettings()` 都只会 `resolve`, 不检查 `chrome.runtime.lastError`; UI 会收到成功响应, 但磁盘并未成功加载/保存, service worker 重启后配置回退, 当前内存状态与真实持久化状态分叉
- 修复方向: 在 callback 中检查 `chrome.runtime.lastError`; `loadSettings()` 应 reject 或降级并附带错误上下文, `saveSettings()` 应 reject 让上层消息明确回错

### [P2] 32 位 `hashString()` 作为 blob 去重键仍然可能跨版本污染内容, 当前只防住了同一 session 内碰撞
- 位置: `src/background/shared.mjs:65`, `src/background/sessions.mjs:29`, `src/background/storage.mjs:45`
- 触发条件: 同一 `siteKey` 下两个不同 source map 内容碰撞到同一个 32 位哈希
- 影响: `blobStoreKey(siteKey, mapHash)` 会把不同内容映射到同一 blob 记录; 后续 `putBlobRecordWithRefCount()` 可能覆盖已有 blob 内容, 让旧版本引用到新内容, 形成静默数据损坏
- 修复方向: 改用更强摘要算法, 或在命中既有 blob 时比对内容后再决定复用; 仅检查“同一批 artifacts 内是否碰撞”不足以保护历史数据

## 漏检复盘
- 已主动复查的高风险模式:
  - 默认分支 / 未知输入: `importSourceMapsForPage`, `loadVersionFiles`, `deleteVersions` 的空输入分支已复查
  - 异步失败 / 前提失效: `persistVersionState`, `deleteVersions`, `ensureStorageReady` 已复查
  - 半完成状态 / 重建窗口: session -> storage 更新链和 compaction 重建链已复查, 未发现此前已修复问题回归
  - 渲染 / 导出 / 编码: 本 phase 重点复查了摘要与键协议
- 本 phase 仍然证据不足的点:
  - IndexedDB 真实浏览器事务异常路径主要靠代码审查, 未做浏览器侧 fault injection

## 未覆盖区域
- `v8 ignore` 标注过的浏览器竞态/事务失败钩子不再作为单测缺口, 但真实宿主行为仍建议用手工回归验证
