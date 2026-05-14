# Phase 0 审查报告: Baseline

> 日期: 2026-03-31
> 文件数: 8
> 发现: P0(0) / P1(2) / P2(2) / INFO(0)

## 已审查文件
- `README.md`
- `src/background/index.js`
- `src/background/runtime.mjs`
- `src/background/runtime-handlers.mjs`
- `src/background/sessions.mjs`
- `src/background/storage.mjs`
- `src/background/shared.mjs`
- `src/background/sourceMaps.mjs`

## Baseline
- 技术栈: Manifest V3 扩展, background service worker, React 19, IndexedDB, Vitest
- 本次范围: 当前 `background` 模块与对应测试重构后的现状
- 历史背景:
  - 已存在 `docs/review-2026-03-31-claude/`
  - 已存在 `docs/review-2026-03-31-codex/`
  - 本次审查仅报告当前代码仍然成立的问题, 不重复已修复项

## 风险分层
- 接入/边界层: `src/background/runtime.mjs`, `src/background/runtime-handlers.mjs`
- 领域与状态层: `src/background/sessions.mjs`, `src/background/shared.mjs`
- 基础设施与集成层: `src/background/storage.mjs`, `src/background/db.mjs`, `src/background/sourceMaps.mjs`
- 测试与验证层: `tests/background*.test.js`

## 本次优先复查的高风险模式
- 默认分支 / 未知输入 / 非法状态: 已检查 runtime message 与 popup port 分发
- 异步失败路径 / rejection / 协议未闭合: 已检查 source map 抓取、storage 回调、IndexedDB 事务
- 半完成状态窗口: 已检查 session -> storage 持久化链
- 编码 / 摘要 / 隐式键协议: 已检查 `base64ToUtf8`, `hashString`, `blobStoreKey`, `mapStoreKey`
- 测试 mock 偏离真实宿主行为: 已检查 `chrome.storage`, 并发抓取和 IndexedDB 异常路径

## 漏检复盘
- 已主动复查的高风险模式:
  - 默认分支 / 未知输入: runtime/popup 分发已覆盖
  - 异步失败 / 前提失效: source map fetch, storage callback, transaction hook 已覆盖
  - 半完成状态 / 重建窗口: session 持久化、compaction 已覆盖
  - 渲染 / 导出 / 编码: 本 phase 不作为重点, 仅核对 background 编码与摘要
- 本 phase 仍然证据不足的点:
  - 浏览器真实 `chrome.storage.local` 错误语义只做了 API 级代码审查, 未在真实浏览器环境复现

## 未覆盖区域
- UI 渲染与导出链路不在本次重点范围
