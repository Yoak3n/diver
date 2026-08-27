# Node sidecar 与 dsh 框架接入

agent 大脑是一个**常驻 Node 进程**。运行时核心已迁移为仓库内自研的 cos harness
（`harness/`，`@cos/*` 工作区插件，DSH profile 模型：`<home>/profiles/<name>` 自带
package.json + node_modules + cordis.patch.yml），陪伴场景的第三方插件
（`@diver/backend` / `@diver/memory`，源码在 `cos-plugins/`）以 **diver 直连
模式**加载：bundle 路径 = `../cos-plugins/bundle-companion`，插件按
`pluginPaths` 从 cos-plugins 源码解析，由 `@diver/bundle-companion` 组装。
Rust `base/sidecar.rs` 以 `node --import tsx .../companion.ts` 拉起（详见
`docs/development.md`）。本页说明接入方式。

## 角色与生命周期

- sidecar 由 Rust `base/sidecar.rs` 启动：`node --import tsx packages/sidecar/src/companion.ts`（diver 直连 cos-plugins）
  - `COS_HOME` → `harness/.cos-home`（仓库本地，gitignore）
  - `DIVER_PORT` → sidecar HTTP 端口（默认 53620）
  - `DIVER_MEMORY_PORT` → Rust 本地服务端口（统一本地 RPC：记忆 + grep 搜索）
  - stdout 检测 `DIVER_READY` 标志行 → 状态置 Running，UI 开始连接
- 主窗口隐藏/销毁不影响它；应用退出时由 Rust 主动 stop（记忆保留在磁盘）

## dsh 只取框架、不搬交互层

| dsh 能力 | Diver 用法 |
|---|---|
| agent loop（turn/step、流式 chunk、工具闭环、max-tokens 粘性） | 原样使用 |
| SessionEvent 日志 + JSONL 持久化 | 原样使用（`session-persistence-jsonl`，明文） |
| tools 服务（web_search 等） | 原样使用，工具 schema 进请求 |
| persona（system-prompt） | companion patch 覆盖 |
| 交互层 / Web UI | **不用**，自研 `web.ts`（node:http 静态 UI + JSON/SSE API） |
| bundle / patch 机制 | profile = dsh-base + companion bundle + 用户 cordis.patch.yml |

## Profile 组装

`harness/.cos-home/profiles/companion/` 是运行时组装出的 profile：
cos 核心（`cordis.yml` 基础行）与 `cos-plugins/bundle-companion`（路径直连）两层
+ profile/用户 `cordis.patch.yml`。
顺序：base 行 → companion bundle 覆盖/插入行 → 用户 patch。

## cordis.patch.yml 要点

| 节 | 配置 | 说明 |
|---|---|---|
| `system-prompt` | `includeHarnessIdentity: false` + 精简 persona | 覆盖 base 身份行；persona 只保留运行环境事实，不预设身份；身份形成期引导由 `@diver/memory` 动态注入（卡片为空时提示用 identity 工具，成型后消失） |
| `approval` | `policy: never` | 陪伴场景免审批（工具面已裁剪） |
| `permission` | `presets: workspace-write` / `defaultPreset: workspace-write` | 与 approval 保持一致 |
| `tool-bash` | `disabled: true` | Windows 下 bash 无 PTY 持久化 |
| `tool-pwsh` | 仅 Windows 启用 | dsh-pwsh-sandbox 执行器，每次调用新进程 |
| `fs-sandbox` | `disabled: true` | 换成无沙箱的 `fs-local`（用户确认的决策，安全边界放宽） |
| `sandbox-policy` | `mode: workspace-write` | shell 仍受工作区沙箱约束 |
| 开发向工具 | subagent/workflow/ralph/todo/goal/jobs/skill/plan-mode/编辑器 全禁用 | 陪伴场景裁剪，省 token |
| `compaction-basic` | `thresholdRatio: 0.38` / `retainTokens: 32768` / `maxTokens: 4096` | 窗口 1M token，达到 40 万压缩为摘要 |

服务行（`insert`）：

| id | 模块 | 说明 |
|---|---|---|
| `fs-local` | `@deepseek-ai/dsh-fs-local` | 本地文件系统（无沙箱） |
| `tool-ask-user` | `@deepseek-ai/dsh-tool-ask-user` | 对话中向用户提问/选择 |
| `diver-companion-web` | `@diver/companion/web` | 自有传输层：静态 UI + JSON/SSE API（`DIVER_UI_DIST` 指向构建产物） |
| `diver-companion-presence` | `@diver/companion/presence` | 主动问候：启动问候 + 9:00 / 13:30 / 21:00 定时 |
| `diver-companion-memory` | `@diver/companion/memory` | 关系层记忆（见 [记忆](memory.md)），digest 节流 10 分钟 |
| `diver-companion-voice` | `@diver/voice` | 对话风格提示词节（`diver:voice`）：引导输出口语化/短句/情绪色彩明确，与桌宠情绪动作闭环 |
| `diver-llm-opencode` | `@diver/companion/llm-opencode` | opencode.ai Zen Go 网关 provider |

## companion bundle 插件

`harness/companion/lib/`（TypeScript 直接运行，零构建）：

| 文件 | 职责 |
|---|---|
| `web.ts` | HTTP 传输层：静态 UI、`/api/health` `/api/chat`（SSE 流式）、`/api/settings`、`/api/question-answer`；模型/provider 切换、SSE 广播、provider 声明聚合 |
| `presence.ts` | 定时主动问候（boot greeting + schedule），有会话才触发 |
| `session.ts` | cosHome/workspace 定位、`diver-settings.json` 读写、`ensureCompanionAgent` |
| `settings-registry.ts` | provider 配置插件注册表（驱动设置面板动态渲染） |
| `memory/` | 关系层记忆：`index.ts`（插件主体）、`extract.ts`（LLM 提取/digest）、`store-rpc.ts`（Rust 后端客户端 + 同步视图缓存） |
| `llm-opencode/` | opencode-go provider 适配器（chat/responses/anthropic 三端点） |

## 会话持久化与压缩

- 会话：单会话 `diver-companion` JSONL（`$COS_HOME/sessions/`，通用事件流格式：`id`/`parentId` 链 + `message` 块，明文），跨重启陪伴记忆
- 压缩：`compaction-basic` 达到阈值把早期消息压缩为摘要、保留最近 32k token 完整
  （约最近三四十轮），请求规模稳定在 ~40k~400k 有界区间；产生的
  `compaction/summary` 事件由 memory 插件监听并内化为长期记忆
