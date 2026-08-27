# Diver · 桌面陪伴 Agent

基于 **Tauri 2 + Vue 3 + DeepSeek Harness 框架**的桌面陪伴 agent。
借鉴 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的架构理念（append-only 会话日志、turn/step agent 循环、工具注册表、persona 组装、事件驱动），**只取其框架、不搬其交互层**：UI 为自研 Vue 单会话陪伴聊天，传输层为自研 HTTP/SSE，agent 常驻于 Node sidecar，Rust 负责壳与原生扩展。

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/index.md](docs/index.md) | 文档中心（分类导航） |
| [docs/architecture.md](docs/architecture.md) | 三层架构、进程拓扑、启动时序、窗口管理、本地服务 |
| [docs/sidecar.md](docs/sidecar.md) | Node sidecar 与 dsh 框架接入、bundle patch 机制、会话持久化与压缩 |
| [docs/live2d-pet.md](docs/live2d-pet.md) | Live2D 桌宠渲染/交互/口型同步/窗口技术 |
| [docs/providers.md](docs/providers.md) | 模型提供商插件体系、端点路由 |
| [docs/memory.md](docs/memory.md) | 关系层记忆（Node 提取插件 + Rust SQLite 后端 + JSON-RPC） |
| [docs/development.md](docs/development.md) | 开发指南：环境、运行、调试、冒烟测试 |
| [docs/roadmap.md](docs/roadmap.md) | 打包分发与后续方向 |

## 架构

```
┌──────────────────────────────────────────────────┐
│ Tauri 壳（Rust）                                  │
│  · sidecar 生命周期管理（spawn/就绪检测/日志/重启） │
│  · 托盘 / 窗口管理 / 轻量模式 / 开机自启 / 单实例   │
│  · 本地 TTS（Windows SAPI 语音朗读）               │
│  · 本地服务（axum）：SQLite 记忆后端 JSON-RPC      │
├──────────────────────────────────────────────────┤
│ WebView：Vue 3 陪伴 UI（单会话连续聊天）            │
│  · 流式渲染 / 主动问候横幅 / 设置面板 / 桌宠窗口    │
│  · dev: Vite (localhost:1420) 代理 /api           │
│  · release: sidecar 同源服务静态 UI               │
├──────────────────────────────────────────────────┤
│ Node sidecar（agent 大脑，常驻进程）               │
│  · @deepseek-ai/dsh-base（仅框架：agent loop、    │
│    会话、LLM 适配器、工具、persona、持久化）        │
│  · cos-plugins/bundle-companion（自研，路径直连）：  │
│    - 陪伴人设 patch（system-prompt 覆盖）          │
│    - companion-web：自有 node:http 传输层          │
│      （静态 UI + JSON/SSE API，不用 dsh 交互层）    │
│    - companion-presence：定时主动问候/提醒          │
│    - companion-memory：关系层记忆（提取/注入/工具） │
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
│  └─ pet/                 # Live2D 桌宠（PetApp/live2d/pet.html）
├─ src-tauri/              # Rust 壳（sidecar 管理、托盘、TTS、本地服务）
│  ├─ src/base/            # sidecar / tts / tray / window / lightweight / timer 等
│  ├─ src/services/        # 本地服务：axum /rpc（SQLite 记忆后端）
│  └─ resources/speak.ps1  # TTS 脚本
├─ crates/diver-memory/    # Rust 记忆后端 crate（SQLite 存储 + 确定性逻辑）
├─ crates/diver-search/    # Rust grep 搜索后端 crate（ripgrep 引擎库）
├─ harness/                # Node sidecar workspace（pnpm，自研 cos）
│  ├─ packages/profile/    # DSH 对齐的 profile 模型（通用；diver 用直连模式）
│  ├─ cos-plugins/         # 第三方 @diver/*（本仓库实际在仓库根 ../cos-plugins）
│  │                       # diver 直连：bundle 路径 = ../cos-plugins/bundle-companion
│  └─ .cos-home/           # 仓库本地 cos home（凭据、会话、设置、记忆；gitignore）
├─ docs/                   # 项目文档（本仓库的文档中心）
└─ scripts/                # 冒烟测试脚本（smoke/smoke2/presence/readlog/memory-test/opencode-test）
```

## 运行

```bash
# 1. 安装依赖（pnpm workspace：前端 + harness）
pnpm install

# 2. 拉取 Live2D 桌宠模型（模型文件不入库，首次运行前执行一次）
pnpm pet:fetch

# 3. 开发运行（自动拉起 sidecar + Vite + 窗口）
pnpm tauri dev
```

首次启动后：在设置（⚙）里填入 DeepSeek API Key（或 opencode-go Key，可选）即可开始对话。
Key 存入本地凭据库（`harness/.cos-home/.credentials.yaml`），模型默认 `deepseek-v4-flash`（可切换）。

### 独立调试 sidecar

```bash
cd harness
$env:COS_HOME = "$PWD\.cos-home"; $env:DIVER_PORT = "53620"
node --import tsx --expose-internals packages/sidecar/src/companion.ts
# 然后访问 http://127.0.0.1:53620/api/health
```

### 修改第三方插件（cos-plugins）

`@diver/*` 源码在仓库根 `cos-plugins/`，companion 以 `pluginPaths` 直连加载
（bundle 路径 = `../cos-plugins/bundle-companion`）。改 `cos-plugins/` 下的
文件后**重启 sidecar 即生效**，无需安装。

### 冒烟测试

```bash
node scripts/smoke.mjs    # 基础对话 + 流式
node scripts/smoke2.mjs   # 工具调用闭环 + 历史
node scripts/presence.mjs # 观察主动问候
node scripts/readlog.mjs  # 查看会话日志
node scripts/memory-test.mjs  # 记忆插件：喂事实 → recall 验证
node scripts/opencode-test.mjs # opencode-go provider 直测
```

## 功能速览

### Live2D 桌宠

屏幕右下角常驻 **Live2D 桌宠**（透明/置顶/无边框，`src/pet/`）：pixi-live2d-display +
Cubism 4 Core，模型为官方示例「Hiyori」；点按随机动作、底部气泡面板轻量聊天
（最近 8 条）、回复自动 TTS 朗读 + **口型同步**（ParamMouthOpenY 正弦驱动）。
主窗口关闭（隐藏到托盘）不影响桌宠；与主窗口共用同一会话/记忆。
详见 [docs/live2d-pet.md](docs/live2d-pet.md)。

### 模型提供商（一切皆插件）

设置面板配置区由插件声明驱动（`lib/settings-registry.ts`），无硬编码输入框。
已注册：`deepseek-official`（DeepSeek 官方 API）与 `opencode-go`
（opencode.ai Zen Go 网关，26 个模型，按模型表自动路由
chat/completions / responses / anthropic 三端点）。
详见 [docs/providers.md](docs/providers.md)。

### 关系层记忆

长期记忆系统，双端架构：Node 插件提供**主动 `remember` 工具、会话末 digest 归纳、
压缩摘要内化与常驻注入**；**Rust SQLite 后端**（`crates/diver-memory` + 本地 JSON-RPC 服务）
做确定性存储/衰减/激活/遗忘。数据文件 `diver-memory.sqlite3` 位于 app data 目录。
记忆来源：① agent 主动 `remember` 工具；② digest（节流 10 分钟，把最近轮次归纳进关系卡）；
③ compaction 摘要内化。**不再做逐轮 LLM 提取。**
详见 [docs/memory.md](docs/memory.md)。

## 环境要求

- Node.js ≥ 22、pnpm ≥ 10
- Rust 工具链（Tauri 2 依赖）
- Windows 10/11（TTS 使用系统 SAPI）

## 已知限制 / 后续方向

打包分发（Node 运行时随包）、原生通知、全局快捷键、语音输入、日程提醒持久化配置、
模型供应商扩展。详见 [docs/roadmap.md](docs/roadmap.md)。
