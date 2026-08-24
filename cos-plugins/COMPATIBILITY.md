# 第三方插件兼容性验证：测试方案与测试报告

> 对象：`@diver/memory`（关系层记忆）与 `@diver/backend`（后端连接服务）
> 组装：`@diver/bundle-companion`（第三方 bundle，`--bundles` 应用）
> 部署形态：`cos-plugins/` 独立第三方插件目录（工作区外），经 `pnpm add file:` 安装、bundle 补丁层挂载
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
| 插件 | `@diver/memory`、`@diver/backend`（`cos-plugins/`，`file:` 安装） |
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
- **bundle 组装**：`--bundles @diver/bundle-companion` 经 `node_modules` 解析第三方 bundle，`requires` 校验通过后 insert memory + backend 两行。
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
- 插件与框架核心完全解耦：`@cos/sidecar/plugins.ts` 不再静态导入插件；插件经 `node_modules` 裸包名解析，可独立版本迭代。
- bundle 组装：`@diver/bundle-companion` 声明 `requires`（8 个核心行）并 insert memory + backend，`--bundles` 一键应用；`cordis.patch.yml` 用户补丁层保持干净，仅用于外层程序最终覆盖。
- 已知边界：SEA 单文件构建（`pnpm build:sea`）目前只内联框架核心插件；第三方插件在 SEA 形态下需另行打包（dev/sidecar 形态不受影响）。

### 5. 复现方式

```sh
cd harness
pnpm install --store-dir ./.pnpm-store-local --config.confirmModulesPurge=false   # 链接第三方插件与 bundle
pnpm typecheck                                                                     # 类型检查（含插件）
pnpm tsx scripts/compat-test.ts                                                    # 兼容性验证（13 项断言，经 bundle 组装）
# 手动启动（bundle 组装 + mock 离线）：
#   $env:COS_OVERLAYS="overlays/mock.yml"; pnpm start --bundles @diver/bundle-companion
```

---

## 第三部分：@diver/backend 插件化重构与 provider 配置适配（复核）

> 复核结果：**12 / 12 通过**（退出码 0）。同一 composition 下直连 `/api/health` /
> `/api/settings` 冒烟通过：provider 目录与模型目录来自 harness 适配器注册表，
> 设置面板的配置字段来自适配器自声明的 `providerConfig()`。

> ⚠️ 已移除原 T3.2：它向 `diver-companion` 会话投递"测试消息"并经持久化落盘，
> 会让应用每次启动都在聊天历史里看到它；且 mock 回显会掩盖真实 API 失败。
> 测试数据现完全隔离（临时 `COS_HOME` + 临时持久化根），不触碰应用数据。
> 后端对"持久化 provider 已不在注册表"不再静默钳制到其它适配器——原样采用并
> 在首轮 turn 以 `NO_ADAPTER` 显式报错，配置错位可见而非被 mock 掩盖。

### 1. 后端模块化（解决"一个服务耦合太多模块功能"）

`apply()` 从 260 行装配降为纯组装，职责按模块拆分（各有独立文件、可单独测试）：

| 模块 | 职责 |
|---|---|
| `index.ts` | 纯装配：状态、事件接线、依赖注入、server 生命周期 |
| `agent.ts` | 陪伴 agent 生命周期（单例会话创建/resume、模型切换释放） |
| `providers.ts` | 模型 provider 配置子系统（注册表/凭据/适配器声明，见下） |
| `health.ts` | 健康信息组装 |
| `server.ts` | HTTP server 创建/监听/释放（thin transport） |
| `handlers.ts` / `sse.ts` | 路由分发 / harness 事件 → SSE 映射（保持不变） |
| `state.ts` / `types.ts` | 传输层共享状态 / 共享类型 |

原 `session.ts`（并入 `agent.ts`）与 `settings-registry.ts`（静态全局注册表，被
适配器声明取代）已删除；`./session`、`./settings-registry` 导出同步移除。

### 2. provider 配置适配新版 harness（移除一切硬编码 provider 知识）

后端不再出现 `deepseek-official` / `opencode-go` / `DEFAULT_MODELS` /
`deepseek.apiKey` 等字面量，全部从框架推导：

| harness 注册面 | 后端使用点 |
|---|---|
| `ctx.llm.listProviders()` | provider 目录与显示名（适配器注册的路由） |
| `ctx.llm.listModels(provider)` | 模型下拉（适配器自声明，advisory；不再有 DEFAULT_MODELS 兜底） |
| `LlmAdapter.providerConfig()`（新增，`@cos/llm`） | 配置 schema 由各适配器插件声明，`ctx.llm.listProviderConfigs()` / `adapterConfig()` 汇总 |
| `ctx.credentials.get(ref)` | "已配置"判定（适配器已 `provide`） |
| `credentials.config.file`（新增 `secretFile` getter） | 凭据写入路径（与读取同一文件） |

配套改动：`@cos/llm-deepseek` / `@cos/mock-llm` 实现 `providerConfig()`；
deepseek 的 `DEEPSEEK_API_KEY` 环境变量兜底并入 `@cos/credentials` 的注册
（`provide` 默认携带 envKey）。设置面板（`/api/settings.providers`）仍按
`ProviderConfigDecl` 协议渲染，前端零协议改动；`opencodeConfigured` 字段移除。

### 3. 运行环境修正（此前验证无法通过的根因）

| 问题 | 修复 |
|---|---|
| `@diver/*` 未链接、bundle 解析为空 "补丁" | harness/package.json 声明 `file:` 依赖 + 根 `pnpm install` 链接到 `node_modules/@diver` |
| 插件源码运行时无法解析 `@cos/*`（祖先链无 node_modules） | 根 `pnpm-workspace.yaml` 登记 `cos-plugins/backend|memory|bundle-companion`，根安装为插件生成自有 `node_modules` 链接 |
| `--bundles` 只扫 cwd 的 node_modules | `@cos/boot` 的 `resolveBundle` 增祖先节点扫描（hoisted 布局下 bundle 在 workspace 根） |
| harness 根 typecheck 无法解析 `@cos/llm` / `@diver/*` 子路径 | `harness/tsconfig.json` 增 `@cos/*`、`@diver/*`（含子路径）映射 |
| T4.2 写入位置与后端读取不一致 | shell 设了 `COS_HOME` 时，测试改用 `@diver/backend/session-helpers.cosHome()` 计算设置路径 |
| `.cos-home/sessions/diver-companion.jsonl` 膨胀到 15 万行导致 resume 栈溢出 | 测试前裁剪为最近尾部（测试数据，gitignored）；会话日志现统一存放于 `$COS_HOME/sessions/`（与配置同目录） |
| 会话日志与配置零散（`.sessions` 与 `.cos-home` 同级） | `@cos/persistence` 根锚定 `COS_HOME`（`cordis.yml root: sessions` → `$COS_HOME/sessions`）；既有数据迁移至 `harness/.cos-home/sessions/`，配置与产物同目录统一管理 |

### 4. 会话落盘格式：通用事件流（`.pi/agent` v3 对齐）

`@cos/persistence` 的 `format` 默认 `standard`：落盘文件是通用 agent 会话事件流
（`id`/`parentId` 链 + `message` 块，`user` / `assistant` / `toolResult` 角色、
camelCase `toolCall` 块、assistant 经流式 chunk 丰富 `usage` / `stopReason`）。
框架内部数据流完全不动（session/event 广播、deriveMessages、记忆/压缩照旧）；
读取时解码回内部 `SessionEvent` 供 resume，旧 internal 行可混读（按行识别）。
内部记账事件（turn/start、step/*、assistant/chunk、session/end-seed）不落盘。
实测：真实落盘无内部事件泄漏、resume 无重复追加；codec 单元往返（含工具流）通过。

### 5. 复核命令

```sh
pnpm install            # 仓库根：链接 cos-plugins 工作区插件
cd harness
pnpm typecheck          # 类型检查（含插件与 compat-test）
pnpm tsx scripts/compat-test.ts   # 12/12 通过（数据隔离于临时目录，不触碰应用数据）
```