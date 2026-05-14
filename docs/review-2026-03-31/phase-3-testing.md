# Phase 3 审查报告: 测试与验证层

> 日期: 2026-03-31
> 文件数: 5
> 发现: P0(0) / P1(0) / P2(1) / INFO(0)

## 已审查文件
- `tests/background.test.js`
- `tests/background.helpers.test.js`
- `tests/background.runtime-modules.test.js`
- `tests/background.db.test.js`
- `tests/background.sourceMaps.test.js`

## Findings

### [P2] 现有测试仍未锁住两类真实宿主故障: `chrome.storage.lastError` 与多订阅者 source map 去重
- 位置: `tests/background*.test.js`
- 触发条件: 未来修改 `loadSettings()/saveSettings()` 或 `pendingSourceMapFetches` 逻辑时
- 影响: 虽然当前 coverage 很高, 但两条最关键的宿主语义仍未被回归测试约束:
  - `chrome.storage.local.get/set` 回调失败语义
  - 同一 `jsUrl` 被多个 session 并发订阅时, 每个订阅者都必须收到结果
- 修复方向: 增加针对 `chrome.runtime.lastError` 的 storage 测试夹具, 以及 `pendingSourceMapFetches` 多 callback 协调测试

## 漏检复盘
- 已主动复查的高风险模式:
  - 默认分支 / 未知输入: runtime message / popup action 未知输入已有测试
  - 异步失败 / 前提失效: fetch timeout, cleanup failure, import failure, updateSettings failure 已覆盖
  - 半完成状态 / 重建窗口: session persist / compaction / blob refcount 已覆盖
  - 渲染 / 导出 / 编码: 本 phase 仅检查 background 相关测试
- 本 phase 仍然证据不足的点:
  - 测试大量依赖手写 fake IndexedDB, 无法完全模拟浏览器原生 IDB 事件顺序

## 未覆盖区域
- 无新增未覆盖目录
