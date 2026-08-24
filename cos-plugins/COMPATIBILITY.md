# 第三方插件兼容性验证：测试方案与测试报告

> 对象：`@diver/memory`（关系层记忆）与 `@diver/backend`（后端连接服务）
> 组装：`@diver/bundle-companion`（第三方 bundle，`--bundles` 应用）
> 部署形态：`cos-plugins/` 独立第三方插件目录（工作区外）；diver 项目以**直连模式**运行——bundle 路径 = `../cos-plugins/bundle-companion`、插件按 `pluginPaths` 从 cos-plugins 源码加载（通用 DSH profile 形态仍保留：`pnpm plugin --profile <name> add …` 装进 `<home>/profiles/<name>`）
> 验证日期：2026-08-24

---

## 第一部分：兼容性验证测试方案

### 1. 测试目标

验证两个第三方插件在 harness 框架下的完整兼容性：

1. **初始化加载**：插件包能被 loader 按裸包名解析、`apply()` 正常执行、服务注册无异常。
2. **核心功能**：memory 的工具面/常驻注入、backend 的 HTTP 端点均可用。
3. **跨模块交互**：插件与框架核心服务（sessions / llm / tools / systemPrompt / agentLoop / credentials / sessionPersistence）的协作正确。
4. **异常场景**：后端缺失、凭据缺失、非法 provider 等边界情况下优雅降级、不崩溃。

### 2. 测试环境

| 项 | 值 |
|---|---|
| 框架 | harness（cordis 4.0.0-rc.7，`@cos/*` 工作区包） |
| 插件 | `@diver/memory`、`@diver/backend`（`cos-plugins/` 源码，diver 直连加载；通用形态经 `pnpm plugin` 安装进 profile） |
| 组装 | `@diver/bundle-companion`（`cos-plugins/bundle-companion/`，`--bundles` 应用） |
| Provider | mock（`overlays/mock.yml`，离线无 key 运行） |
| 运行 | `pnpm tsx scripts/compat-test.ts`（自动断言） |

### 3. 测试用例矩阵

| 编号 | 维度 | 用例 | 预期 |
|---|---|---|---|
| T1.1 | 初始化加载 | boot 组合树（bundle 组装第三方插件） | 启动成功，无未捕获异常 |
| T1.2 | 初始化加载 | memory `apply()` 执行 | 4 个记忆工具（remember/recall/inventory/demote）注册成功 |
| T1.3 | 初始化加载 | backend `apply()` 执行 | HTTP server 监听 3620，health 端点可达 |
| T2.1 | 核心功能 | memory 常驻注入 | `memory:relation-card` systemPrompt section 已注册 |
| T2.2 | 核心功能 | backend `/api/health` | 返回 200，含 provider/model/memoryPort 等字段 |
| T2.3 | 核心功能 | backend `/api/settings` | 返回 200 |
| T3.1 | 跨模块交互 | backend ↔ agentLoop | `createAgent(resume)` 创建/恢复陪伴 agent |
| T3.2 | 跨模块交互 | memory ↔ sessions | `session/event` 事件流监听，消息投递 + turn 完成无异常 |
| T3.3 | 跨模块交互 | memory ↔ llm | `digestSession` 直连 `ctx.llm.stream`，后端缺失时优雅降级 |
| T3.4 | 跨模块交互 | web ↔ sessionPersistence | `/api/history` 读取持久化事件返回 200 |
| T4.1 | 异常场景 | Rust 后端未启动（`DIVER_MEMORY_PORT` 未配置） | memory 拉取快照失败仅告警，插件继续运行 |
| T4.2 | 异常场景 | API Key 未配置（deepseek provider） | `/api/chat` 返回 400 明确提示 |
| T4.3 | 异常场景 | 未知 provider | agent 创建成功但首轮 turn 以 error 结束，进程不崩溃 |

### 4. 执行方式

```sh
cd harness
pnpm tsx scripts/compat-test.ts   # 自动断言，退出码 0 = 全部通过
```

---

## 第二部分：兼容性测试报告

### 1. 执行结果汇总

**通过 13 / 13**（退出码 0）

| 编号 | 用例 | 结果 | 实测详情 |
|---|---|---|---|
| T1.1 | boot 组合树（bundle 组装） | ✅ PASS | `cordis.yml` + `@diver/bundle-companion` 组合树就绪 |
| T1.2 | memory apply() | ✅ PASS | 已注册: remember, recall, inventory, demote |
| T1.3 | backend apply() | ✅ PASS | health 端点可达（`127.0.0.1:3620`） |
| T2.1 | memory 常驻注入 | ✅ PASS | `memory:relation-card` 已注册 |
| T2.2 | backend /api/health | ✅ PASS | `{"ok":true,"persona":"小潜","provider":"mock","model":"mock-1","modelConfigured":true,...}` |
| T2.3 | backend /api/settings | ✅ PASS | 返回 200 |
| T3.1 | backend ↔ agentLoop | ✅ PASS | agent `diver-companion` 就绪（resume 语义） |
| T3.2 | memory ↔ sessions | ✅ PASS | 消息投递 + turn 完成无异常 |
| T3.3 | memory ↔ llm | ✅ PASS | digestSession 调用完成（后端缺失时优雅降级） |
| T3.4 | backend ↔ sessionPersistence | ✅ PASS | /api/history 返回 200 |
| T4.1 | Rust 后端未启动 | ✅ PASS | store 调用不抛未捕获异常（仅告警 `DIVER_MEMORY_PORT 未配置`） |
| T4.2 | API Key 未配置 | ✅ PASS | 400: 尚未配置 API Key，请先在设置中配置 |
| T4.3 | 未知 provider | ✅ PASS | 首轮 turn 以 error 结束（NO_ADAPTER），进程不崩溃 |

### 2. 运行状态记录

- **插件加载日志**：`[memory] 关系层记忆插件就绪`、`[diver] companion backend listening on 127.0.0.1:3620`、`DIVER_READY http://127.0.0.1:3620`。
- **bundle 组装**：`--profile companion` 时 `dsh.profile.bundles` 经双锚点（cos 安装 → profile）解析第三方 bundle，`requires` 校验通过后 insert memory + backend 两行。
- **会话持久化**：`/api/history` 正确返回跨重启的持久化消息（含上一轮测试会话），证明 `diver-companion` 会话 resume 生效。
- **类型检查**：harness 根 `pnpm typecheck` 与两个插件独立 `tsc --noEmit` 均通过。

### 3. 迁移过程中发现并修复的问题

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | `source.kind` 过滤失效 | 新 harness 的 `UserMessage.source.kind` 类型为 `'human' \| 'plugin' \| 'goal'`，旧代码用 `'user'` 判断，会过滤掉全部真实用户消息 | `handlers.ts` / `sse.ts` 改为 `'human'` |
| 2 | `ctx.on('dispose')` 类型错误 | cordis 4 无 `dispose` 事件，改用 effect 生命周期 | `ctx.effect(() => () => {...}, name)` |
| 3 | 工具注册 API 不兼容 | 旧 `defineTool({...})` vs 新 `ctx.tools.register(name, executor, options)` | 4 个记忆工具改写为 `register`，结构化结果序列化为 JSON 字符串 |
| 4 | agent 创建 API 不兼容 | 旧 `ctx.agents.resume/create` vs 新 `ctx.agentLoop.createAgent` | `ensureCompanionAgent` 改写，`resume: true` 统一处理恢复/新建 |
| 5 | 凭据 API 不兼容 | 新 `@cos/credentials` 只读（`get`），无 `resolve(credentialRef)` / `set` | 读取用 `ctx.credentials.get`（try/catch）；写入经 `secrets.ts` 直写 secrets 文件 |
| 6 | 历史读取 API 不兼容 | 旧 `sessionPersistence.readFrom(id, since)` vs 新 `prepare(id)` | `handlers.ts` 改用 `prepare` |
| 7 | `!!js` YAML tag 不被解析 | 新 boot 用 `yaml` 包，不支持 DSH 的 `!!js` 标签 | 移除 `cordis.yml` 中 `uiDist: !!js ...`，改由 `process.env.DIVER_UI_DIST` 读取 |
| 8 | mock provider 被误判未配置 | `isModelConfigured` 只放行 `opencode-go` | 改为仅 `deepseek-official` 需校验 key，其余 provider 放行 |
| 9 | 第三方插件独立 typecheck 失败 | 插件位于工作区外，`@cos/*` / `cordis` 无法从源码位置解析；Context 服务增强（`ctx.llm` 等）在服务包内 | 插件 tsconfig 加 `paths`（`@cos/*` → harness packages）+ `include` harness packages 类型文件 |
| 10 | T4.3 测试预期错误 | `createAgent` 不校验 provider，首轮 turn 才抛 `NO_ADAPTER` | 测试改为验证首轮 turn 以 error 结束且进程不崩溃 |

### 4. 最终验证结论

- 两个第三方插件以独立目录（`cos-plugins/`）部署、经 `@diver/bundle-companion` 组装挂载后，**初始化加载、核心功能、跨模块交互、异常场景** 四个维度全部通过（13/13）。
- 插件与框架核心完全解耦：`@cos/sidecar/plugins.ts` 不再静态导入插件；第三方插件安装在 profile 的 `node_modules`（harness 自身依赖只读），可独立版本迭代。
- bundle 组装：`@diver/bundle-companion` 声明 `requires`（8 个核心行）并 insert memory + backend，`--bundles` 一键应用；`cordis.patch.yml` 用户补丁层保持干净，仅用于外层程序最终覆盖。
- SEA 与第三方插件：SEA 运行时无法对 node_modules 下的 TS 做 type-strip，故 `pnpm build:sea --profile companion --home ./.dsh-home` 在构建期把 profile 的第三方插件烤入同一模块图；新增插件包需重构建（dev/sidecar 形态不受影响，仍是运行时从 profile 解析）。

### 5. 复现方式

```sh
cd harness
pnpm install --store-dir ./.pnpm-store-local --config.confirmModulesPurge=false   # 安装 @cos/profile 等工作区包
pnpm typecheck                                                                    # 类型检查（含插件）
pnpm tsx scripts/compat-test.ts                                                   # 兼容性验证（17 项断言：T0 reconcile + T1-T4 diver 直连 + T5 profile 组装）
# 手动启动（diver 直连 + mock 离线）：
#   $env:COS_OVERLAYS="overlays/mock.yml"; pnpm start:companion
# SEA 构建（第三方插件烤入）：pnpm build:sea --bundle ../cos-plugins/bundle-companion --plugin-root ../cos-plugins
```