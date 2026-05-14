# 代码审查汇总

> 日期: 2026-03-31
> 范围: `src/background/*`, `tests/background*.test.js`
> Phase 数: 5

## 统计
- P0: 0
- P1: 2
- P2: 3
- INFO: 0

## 高优先级问题
1. [P1] `src/background/sourceMaps.mjs:35` 按 `jsUrl` 去重时直接丢弃后续 callback, 同一脚本跨 tab/页面并发只会通知第一个 session。
2. [P1] `src/background/storage.mjs:250` 和 `src/background/storage.mjs:259` 忽略 `chrome.storage.local` 失败语义, 会让设置“假成功”并导致内存/持久化状态分叉。

## 各 Phase 摘要
- Phase 0: 建立了本次 background 重构后的基线, 复用历史 review 作为背景但仅报告当前仍成立的问题。
- Phase 1: 在接入层确认 2 个边界问题: source map 多订阅者并发丢回调, 以及 `.js` 后缀过滤导致合法脚本漏采集。
- Phase 2: 在状态与持久化层确认 2 个问题: storage callback 失败被静默吞掉, 以及 32 位哈希去重仍可能跨版本污染 blob。
- Phase 3: 测试层没有新增产品缺陷, 但仍缺少对上述两类真实宿主故障的回归测试。
- Phase 4: 做了横向反证复盘, 未发现新的系统性问题。

## 跨模块问题
- `sourceMaps -> runtime-handlers -> sessions` 链路对“共享工作结果需要广播给多个上游调用者”的建模仍然不完整。当前只有去重, 没有 fan-out。
- `storage -> runtime-handlers -> UI` 链路对 Chrome callback API 的失败语义建模不足。当前把 callback 到达误当成成功, 使上层协议返回与真实持久化结果脱节。
- `shared.hashString -> storage blob dedupe` 是高杠杆工具函数风险点。摘要算法一旦碰撞, 影响不是单条记录失败, 而是跨版本内容串写。

## 差异化反证复盘
- 已横向复查的模式:
  - 默认分支 / 交互协议闭合
  - 异步失败 / 超时 / 取消 / 幂等
  - 状态写入顺序 / 半提交 / 重建窗口
  - 渲染 / 导出 / 编码 / 时间 / 摘要
- 这一轮复盘新增发现:
  - 无

## 未覆盖区域
- 真实浏览器环境中的 `chrome.storage.local` 故障与原生 IndexedDB 事件顺序仍缺少浏览器级验证
- UI 层和导出链路不在本次审查范围
