# Phase 1 审查报告: 接入与边界层

> 日期: 2026-03-31
> 文件数: 2
> 发现: P0(0) / P1(1) / P2(1) / INFO(0)

## 已审查文件
- `src/background/runtime.mjs`
- `src/background/runtime-handlers.mjs`

## Findings

### [P1] source map 去重按 `jsUrl` 丢弃后续回调, 同源脚本跨 tab/页面并发时只会通知第一个调用者
- 位置: `src/background/sourceMaps.mjs:33`
- 触发条件: 两个 tab 或两个页面几乎同时请求同一个脚本 URL, 第二次 `fetchSourceMap(jsUrl, callback)` 在第一次完成前进入
- 影响: 第二个调用直接 `return`, 它的 callback 永远不会收到 map 内容; 结果是只有第一个 session 会写入 `session.maps`, 其他页面会漏记、漏持久化、badge 数偏小
- 修复方向: 把 `pendingSourceMapFetches` 从 `Set<jsUrl>` 改成 `Map<jsUrl, callback[]>` 或共享 promise, 在完成后向所有等待者广播结果

### [P2] `webRequest` 入口把脚本 URL 限制为 `.js` 后缀, 会漏掉合法的 module/extensionless script
- 位置: `src/background/runtime-handlers.mjs:25`
- 触发条件: 站点通过 `/assets/app`, `/runtime/module.mjs`, 指纹路径或不带 `.js` 的 script URL 提供 JavaScript, 但 `details.type === "script"`
- 影响: background 明明已经拿到了浏览器判定的 `script` 请求, 却因为 URL 后缀过滤直接跳过; 这会导致真实脚本的 source map 永久漏采集
- 修复方向: 以 `details.type === "script"` 为主判断, `.js` 后缀检查降为启发式白名单或直接移除; 如担心误报, 可在抓到内容后再识别 `sourceMappingURL`

## 漏检复盘
- 已主动复查的高风险模式:
  - 默认分支 / 未知输入: `onMessage`, `onConnect`, `onBeforeRequest` 已有默认回错或忽略
  - 异步失败 / 前提失效: message handler 的 rejection 回复已完整, webRequest 回调也检查了 session 是否仍有效
  - 半完成状态 / 重建窗口: 本 phase 不负责持久化写入, 仅检查入口是否把错误传播出去
  - 渲染 / 导出 / 编码: 不属于本 phase
- 本 phase 仍然证据不足的点:
  - 未在真实浏览器里验证 `details.type === "script"` 对所有脚本资源的覆盖面, 但当前 `.js` 后缀过滤本身已经构成明确风险

## 未覆盖区域
- `chrome.runtime.onMessage` 的 sender 身份边界未发现当前可利用缺陷, 但未来如引入 content script 应复查
