# Phase 0 审查报告: Baseline

> 日期: 2026-03-31
> 审查范围: 整个仓库
> 技术栈: Manifest V3 Chrome Extension, React 19 + antd 6, IndexedDB, esbuild, Vitest

## 项目概述

SourceD 是一个 Manifest V3 浏览器扩展，用于检测页面加载的 JavaScript source map，缓存包含 `sourcesContent` 的 map，并允许用户以 ZIP 归档形式下载还原后的源代码。

## 模块边界与职责映射

| 职责层 | 目录/文件 | 风险等级 |
|---|---|---|
| 平台与运行时层 | `src/background/index.js`, `manifest.json`, `scripts/build-dist.mjs` | 中 |
| 接入/边界层 | `src/background/runtime.mjs` (消息监听、webRequest 监听) | **高** |
| 领域与状态层 | `src/background/sessions.mjs`, `src/background/shared.mjs` | **高** |
| 基础设施与集成层 | `src/background/storage.mjs` (IndexedDB 持久化) | **高** |
| UI 接入层 | `src/popup/App.jsx`, `src/dashboard/App.jsx`, `src/options/App.jsx` | 中 |
| 共享工具层 | `src/shared/utils.mjs`, `src/popup/sourcemap.mjs` | 中 |
| 测试层 | `tests/*.test.{js,jsx}` | 中 |

## 现有状态

- **测试**: 188 tests, 6 files, 全部通过
- **Lint**: 无错误/警告
- **Coverage**: 存在 coverage 报告目录，具体覆盖率待确认
- **历史审查**: 无历史 review 记录
- **已知问题**: 无 known issues 文档

## 审查 Phase 计划

鉴于项目规模较小（核心源码约 10 个文件），按以下 phase 划分：

1. **Phase 1 — 运行时与边界层**: `runtime.mjs`, `index.js`, `manifest.json` — 消息协议、webRequest 监听、权限边界
2. **Phase 2 — 会话与存储层**: `sessions.mjs`, `shared.mjs`, `storage.mjs` — 状态管理、IndexedDB 事务、竞态条件、资源释放
3. **Phase 3 — UI 与测试层**: `popup/App.jsx`, `dashboard/App.jsx`, `options/App.jsx`, `sourcemap.mjs`, `utils.mjs`, 测试文件
4. **Phase 4 — 横切审查**: 跨模块系统性风险、错误传播一致性、安全问题

## 高风险关注点

1. **`fetchSourceMap`**: 从任意 URL fetch 内容，涉及 SSRF 风险、无超时控制
2. **`runtime.mjs` 消息处理**: 外部消息入口缺乏校验，`onMessage` action 路由无默认分支
3. **IndexedDB 事务**: 多步事务中内存索引与磁盘状态的一致性
4. **`dangerouslySetInnerHTML`**: `options/App.jsx` 中使用，需确认输入安全性
5. **`hashString`**: 使用 FNV-1a 变体，32 位哈希碰撞概率
