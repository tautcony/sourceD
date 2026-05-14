# 修复计划

## 批次划分
- Batch A: 立即修复的 P1
- Batch B: 本迭代修复的 P2
- Batch C: 验证与回归补强

## Batch A
- 目标问题:
  - `sourceMaps` 多订阅者并发去重丢 callback
  - `chrome.storage.local` 失败被静默吞掉
- 涉及文件:
  - `src/background/sourceMaps.mjs`
  - `src/background/storage.mjs`
  - `src/background/runtime-handlers.mjs`
  - `tests/background.sourceMaps.test.js`
  - `tests/background.helpers.test.js`
- 建议顺序:
  1. 把 `pendingSourceMapFetches` 改成共享 promise 或 callback 列表
  2. 在完成/失败/超时后统一 fan-out 给所有等待者
  3. 为 `loadSettings/saveSettings` 引入 `chrome.runtime.lastError` 检查与 reject
  4. 核对 `updateSettings`/初始化调用方的错误回传与降级行为
- 验证方式:
  - 新增两个 session 并发请求同一 `jsUrl` 的测试, 断言两个 callback 都收到结果
  - 新增 `chrome.storage.local.get/set` 带 `runtime.lastError` 的测试, 断言 promise reject 且上层返回错误

## Batch B
- 目标问题:
  - `.js` 后缀过滤导致合法脚本漏采集
  - 32 位哈希导致 blob 去重碰撞风险
- 涉及文件:
  - `src/background/runtime-handlers.mjs`
  - `src/background/shared.mjs`
  - `src/background/storage.mjs`
  - `src/background/sessions.mjs`
- 建议顺序:
  1. 放宽 script 识别规则, 仅依赖 `details.type === "script"` 或兼容 `.mjs`/无扩展路径
  2. 为 blob 去重引入更强摘要, 或在复用既有 blob 时额外比对内容
  3. 清点现有持久化数据兼容性, 决定是否需要迁移旧 blob key
- 验证方式:
  - 覆盖 `.mjs` 与无扩展 URL 的 webRequest 用例
  - 构造哈希冲突替身测试, 断言不会复用不同内容到同一 blob 记录

## Batch C
- 目标问题:
  - 回归测试补强, 防止后续再次漏掉宿主失败语义
- 涉及文件:
  - `tests/background*.test.js`
- 建议顺序:
  1. 为 `chrome.storage` 故障添加专门夹具
  2. 为 source map fan-out 添加专门并发测试
  3. 如条件允许, 增加最小浏览器集成验证脚本或手工回归清单
- 验证方式:
  - `npm test`
  - `npm run test:coverage`
  - 手工验证: 切换多个 tab 打开同一站点脚本, 确认 badge 与 popup 一致
