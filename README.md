# Diver · 桌面陪伴 Agent

基于 **Tauri 2 + Vue 3 + DeepSeek Harness 框架**的桌面陪伴 agent「小潜」。
借鉴 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的架构理念（append-only 会话日志、turn/step agent 循环、工具注册表、persona 组装、事件驱动），**只取其框架、不搬其交互层**：UI 为自研 Vue 单会话陪伴聊天，传输层为自研 HTTP/SSE，agent 常驻于 Node sidecar，Rust 负责壳与原生扩展。

## 架构

```
┌──────────────────────────────────────────────────┐
│ Tauri 壳（Rust）                                  │
│  · sidecar 生命周期管理（spawn/就绪检测/日志/重启） │
│  · 托盘 / 窗口管理 / 轻量模式 / 开机自启            │
│  · 本地 TTS（Windows SAPI 语音朗读）               │
├──────────────────────────────────────────────────┤
│ WebView：Vue 3 陪伴 UI（单会话连续聊天）            │
│  · 流式渲染 / 主动问候横幅 / 设置面板               │
│  · dev: Vite (localhost:1420) 代理 /api           │
│  · release: sidecar 同源服务静态 UI               │
├──────────────────────────────────────────────────┤
│ Node sidecar（agent 大脑，常驻进程）               │
│  · @deepseek-ai/dsh-base（仅框架：agent loop、    │
│    会话、LLM 适配器、工具、persona、持久化）        │
│  · @diver/companion bundle（自研）：               │
│    - 陪伴人设 patch（system-prompt 覆盖）          │
│    - companion-web：自有 node:http 传输层          │
│      （静态 UI + JSON/SSE API，不用 dsh 交互层）    │
│    - companion-presence：定时主动问候/提醒          │
│  · 单会话「diver-companion」JSONL 持久化            │
│    （跨重启陪伴记忆）                              │
└──────────────────────────────────────────────────┘
```

**关键设计**（对应 DSH 理念）：

| 理念 | Diver 实现 |
|---|---|
| append-only 会话日志 | dsh 的 SessionEvent 日志 + JSONL 持久化，UI/模型历史都从日志派生 |
| turn/step agent 循环 | dsh agent-loop：流式 chunk、工具调用闭环、max-tokens 粘性等 |
| 工具注册表 + 执行管线 | dsh-base 的 tools 服务（web_search 等），工具 schema 进请求 |
| persona 组装 | bundle patch 覆盖 `system-prompt` 行 |
| 一切皆可 patch | profile = dsh-base + companion 两个 bundle 层 + 用户 cordis.patch.yml |
| 事件驱动 UI | session/event + agent/* 事件 → 自有 SSE 协议 → Vue |

## 目录结构

```
diver/
├─ src/                    # Vue 3 陪伴 UI（聊天、设置、TTS）
├─ src-tauri/              # Rust 壳（sidecar 管理、托盘、TTS）
│  ├─ src/base/sidecar.rs  # sidecar 生命周期
│  ├─ src/base/tts.rs      # Windows SAPI 语音
│  └─ resources/speak.ps1  # TTS 脚本
├─ harness/                # Node sidecar workspace（pnpm）
│  ├─ package.json         # 依赖 @deepseek-ai/dsh
│  ├─ companion/           # @diver/companion bundle（link: 符号链接进 profile）
│  │  ├─ cordis.patch.yml  # 人设/权限/工具策略/服务行
│  │  └─ lib/              # TypeScript 插件（Node ≥22.18 原生 type-stripping 直接运行，
│  │                       #   零构建）：web.ts（传输层）、presence.ts（主动问候）、
│  │                       #   session.ts、memory/（关系层记忆）、llm-opencode/（provider）
│  └─ .dsh-home/           # 仓库本地 DSH_HOME（凭据、会话、设置、记忆；gitignore）
│     └─ profiles/companion/
└─ scripts/                # 冒烟测试脚本（smoke/smoke2/presence/readlog/memory-test/opencode-test）
```

## 运行

```bash
# 1. 安装依赖（pnpm workspace：前端 + harness）
pnpm install

# 2. 开发运行（自动拉起 sidecar + Vite + 窗口）
pnpm tauri dev
```

首次启动后：在设置（⚙）里填入 DeepSeek API Key（或 opencode-go Key，可选）即可开始对话。
Key 存入本地凭据库（`harness/.dsh-home/.credentials.yaml`），模型默认 `deepseek-v4-flash`（可切换）。

### 独立调试 sidecar

```bash
cd harness
$env:DSH_HOME = "$PWD\.dsh-home"; $env:DIVER_PORT = "3620"
node node_modules/@deepseek-ai/dsh/lib/bin.js --profile companion
# 然后访问 http://127.0.0.1:3620/api/health
```

### 修改 companion bundle

bundle 以 `link:` 符号链接进 profile（`harness/.dsh-home/profiles/companion/node_modules/@diver/companion`），
改 `harness/companion/` 下的文件后**重启 sidecar 即生效**，无需重装。

### 冒烟测试

```bash
node scripts/smoke.mjs    # 基础对话 + 流式
node scripts/smoke2.mjs   # 工具调用闭环 + 历史
node scripts/presence.mjs # 观察主动问候
node scripts/readlog.mjs  # 查看会话日志
node scripts/memory-test.mjs  # 记忆插件：喂事实 → recall 验证
```

## Live2D 桌宠

启动后屏幕右下角常驻 **Live2D 桌宠**（透明/置顶/无边框窗口，`src/pet/`）：

- **渲染**：pixi-live2d-display + Cubism 4 官方 Core；模型为 Live2D 官方示例「Hiyori」（`public/pet/models/Hiyori/`，4.7MB，含 10 个动作）
- **交互**：
  - 点按桌宠 → 随机播放 TapBody 动作
  - 底部气泡面板直接对话（轻量 SSE 聊天，最近 8 条）
  - 助手回复自动 TTS 朗读 + **口型同步**（ParamMouthOpenY 正弦驱动，按文本时长估算）
  - 顶部手柄拖拽移动（`data-tauri-drag-region`）
- **常驻**：桌宠窗口与主窗口并存；主窗口关闭（隐藏到托盘）不影响桌宠
- 与主窗口共用同一会话/记忆：两边同时连 sidecar SSE，消息互通

技术要点：
- Vite 多页构建（`index.html` 主窗口 + `pet.html` 桌宠），Rust `WindowType::Pet`（transparent/decorations:false/always_on_top/skip_taskbar/不抢焦点，右下角贴靠定位）
- 依赖已 pin：`pixi.js@7` + `pixi-live2d-display@0.4` + `live2dcubismcore`

## 模型提供商（一切皆插件）

设置面板的配置区由**插件声明驱动**：每个 provider 插件通过
`registerProviderConfig({provider, name, fields: [...]})`（`lib/settings-registry.ts`）声明自己的配置
字段（类型/存储位置/必填/提示），UI 动态渲染，**没有硬编码的配置输入框**。字段按 `store` 落位：
`credentials` → dsh 凭据库（`$DSH_HOME/.credentials.yaml`），`settings` → `diver-settings.json`（带 `provider.` 前缀）。

当前已注册的 provider（`provider/model` 存于 `diver-settings.json`，切换后下次对话生效，会话记忆保留）：

| 提供商 | 声明字段 | 说明 |
|---|---|---|
| `deepseek-official` | apiKey（password/credentials，必填） | DeepSeek 官方 API（`deepseek-v4-flash` / `deepseek-v4-pro`） |
| `opencode-go` | apiKey（password/credentials，可选）、baseUrl（text/settings） | opencode.ai Zen Go 网关（26 个模型，无 key 也可用） |

opencode-go 端点路由（按模型表自动选择，`harness/companion/lib/llm-opencode/`）：

- `/v1/chat/completions`（OpenAI 兼容，**全功能含工具调用**）：`glm-5.3/5.2/5.1`、`kimi-k3/k2.7-code/k2.6`、`deepseek-v4-pro/flash`、`mimo-v2.5/pro`、`hy3`
- `/v1/responses`（Responses API，第一版文本流）：`grok-4.5`、`gpt-5.6-luna`
- `/v1/messages`（Anthropic Messages API，第一版文本流）：`minimax-m3/m2.7/m2.5`、`qwen3.8-max/3.7-max/3.7-plus/3.6-plus`

> 文本流端点（responses/messages）暂不支持工具调用；选择这些模型时记忆工具自动不可用，建议聊天用 chat/completions 端点模型。
> 可选鉴权：凭据库或环境变量 `OPENCODE_API_KEY`（无 key 时网关可裸请求）。

## 关系层记忆插件

按 `docs/` 设计文档（关系层记忆）实现的记忆系统，作为 companion bundle 的第三个插件
（`harness/companion/lib/memory/`），数据落在 `$DSH_HOME/memory/`（即 `harness/.dsh-home/memory/`）：

```
memory/
├─ topics.json           # 主题层：每主题一行（id 不透明稳定、canonical_name 标签、aliases、
│                        #   state_summary、weight、tier、activation_count、时间锚点）
├─ events.jsonl          # 事件层：append-only 真相源（陈述原文，永不修改）
├─ relation-card.json    # 关系卡：profile（关于用户）/ agent_model（关于自己）/ relationship
├─ promises.json         # 承诺（open/done/expired）
└─ self-history.jsonl    # 行为史（建议去重等）
```

| 机制 | 实现 |
|---|---|
| 快提取（每轮） | `session/event` 配对 turn pair → LLM 抄字面事实（三类事实 diff + 陈述 + 承诺 + 建议） |
| 实体消解 resolve_topic | 词法阻塞（别名/规范名命中）→ LLM 仲裁；**保守偏置：不确定 → 新建（uncertain）** |
| 状态合并 llm_merge | 同主题新陈述合并进旧状态；`correct` 替换 |
| 常驻注入 | `systemPrompt.section`（order 15）：关系卡 + Mode B（近期经历/未完成承诺/今天事件），永不检索 |
| 衰减/激活/遗忘 | episodic 0.05/天、trivia 0.15/天线性衰减；用户提起 → activation+1 权重恢复 ≥0.6；低于阈值系统遗忘 |
| Agent 工具面 | `remember` / `recall` / `inventory` / `demote`（只加强/减弱，不亲手删，可逆） |
| 会话末 digest | 节流 10 分钟：统计 + 会话摘要 → 模式/关系/缺口 → 关系卡更新 |

验证过的行为：agent 每轮自动 `remember`；跨轮"小本本"记忆一致；recall 型问题（名字/忌口/爱好）
零工具调用、纯靠注入回答正确；人设自然成长（"记忆压力测试满分"）。

## 环境要求

- Node.js ≥ 22、pnpm ≥ 10
- Rust 工具链（Tauri 2 依赖）
- Windows 10/11（TTS 使用系统 SAPI）

## 已知限制 / 后续方向

- [ ] 打包分发：Node 运行时随包（sidecar 打包策略）
- [ ] 原生通知：agent 主动消息到达时托盘通知
- [ ] 全局快捷键唤起窗口
- [ ] 语音输入（麦克风）
- [ ] 日程提醒的持久化配置界面
- [ ] 模型供应商扩展（自定义 base URL）
