# Diver · 桌面陪伴 Agent

基于 **Tauri 2 + Vue 3 + Node sidecar（自研 cos 引擎）** 的桌面陪伴 agent。
借鉴 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的架构理念（append-only 会话日志、turn/step agent 循环、工具注册表、persona 组装、事件驱动），**只取其框架、不搬其交互层**：UI 为自研 Vue 单会话陪伴聊天，传输层为自研 HTTP/SSE，agent 常驻于 Node sidecar，Rust 负责壳与原生扩展。

## 项目介绍

产品形态是「一个常驻桌面的陪伴者」：**主窗口**做单会话连续聊天（流式渲染、图片附件、助手头像、TTS 朗读）；**Live2D 桌宠**常驻屏幕右下角（透明/置顶/无边框），与主窗口共用同一会话与记忆；**Node sidecar** 是 agent 大脑，常驻后台。

三层结构：

| 层 | 职责 |
|---|---|
| Tauri 壳（Rust） | sidecar 生命周期、窗口/托盘/轻量模式、全局快捷键、在线 TTS、axum 本地服务（记忆 / grep / 截图 JSON-RPC） |
| WebView（Vue 3） | 陪伴聊天 UI、设置面板、Live2D 桌宠窗口 |
| Node sidecar | agent 循环 + `@diver/*` 插件（backend / memory / voice / mcp / 提供商…），单会话 JSONL 持久化 |

### 核心能力

- **陪伴聊天**：流式对话、工具调用闭环、会话 JSONL 持久化（跨重启）、压缩摘要内化
- **QQ 接入（OneBot 11）**：群潜水 / 被 @ 必回 / 低概率插话 + 沉默退避；回合级工具收权与出站隐私遮蔽；支持 QQ 图片收发（入站图片进上下文，出站可用近期图句柄 / 直链 / 本地路径），自己的群发言进入会话时间线并落 `group-sent.jsonl` 审计账；语音出话失败降级文本
- **QQ 连接状态灯**：设置「QQ 接入」页实时显示已登录 / 连接中 / 未连接（含最近错误、重连次数与倒计时）/ 插件休眠；`online` 只在 `get_login_info` 成功后成立，不再把「WS 连上后立刻被服务端关闭」误报成已连接。多实例下「接 QQ」全局单选归属（仅归属实例连接，配同一 wsUrl 也不会双回复），设置页统一编辑归属与连接配置
- **多实例**：每实例独立记忆 / 会话 / 人格 / 插件配置与桌宠；互实例消息（send_to_peer）；设置「实例」页管理，QQ 归属在实例间单选
- **Live2D 桌宠**：点按随机动作、情绪驱动动作、TTS 口型同步（按真实音频时长驱动）、模型切换（官方 Hiyori / N.E.K.O YUI）、气泡轻聊
- **关系层记忆**：`remember` / `entity` / `identity` 工具 + 会话末 digest + 实体图谱，Rust SQLite 后端做衰减/激活/遗忘（不做逐轮提取）
- **模型提供商（一切皆插件）**：`deepseek-official` / `commandcode` / `volcark` / `opencode-go` / `mock`，自定义 baseUrl 保存即生效；设置面板配置区由插件声明驱动
- **在线 TTS**：MiMo / MiniMax / 火山，朗读队列 + 口型同步
- **主动陪伴**：presence 存在感状态机（HSM）、日程提醒（设置页配置、30s tick 热生效，到点主动问候 + 原生通知）
- **桌面集成**：全局快捷键唤起、托盘、轻量模式、开机自启、单实例、图片附件、助手头像；sidecar 崩溃落态与 backend 重启请求自动拉起，断线页可一键重启，启动失败直接给出日志路径
- **插件开放**：引擎与插件均为磁盘 TS 源码，改文件重启 sidecar 即生效；设置页可启停

### 目录结构

```
src/         Vue 3 陪伴 UI + Live2D 桌宠（src/pet/）
src-tauri/   Rust 壳：app / shell / core / commands / config / services / plugins 分层
crates/      diver-geom / diver-memory / diver-presence / diver-search / diver-shot
harness/     自研 cos 引擎（Node sidecar workspace，submodule）
cos-plugins/ @diver/* 插件源码 + bundle-companion
scripts/     冒烟测试与打包脚本
```

代码分层与硬性规范见 [AGENTS.md](AGENTS.md)，完整目录说明见 [docs/development.md](docs/development.md)。

## 开发指引

### 环境要求

- Node.js ≥ 22、pnpm ≥ 10
- Rust 工具链（Tauri 2 依赖）
- Windows 10/11 或 Linux（X11/Wayland；在线 TTS 需可访问服务商 API）

### 快速开始

```bash
pnpm install       # pnpm workspace：前端 + harness
pnpm pet:fetch     # 首次：拉取 Live2D 桌宠模型（可选 pnpm pet:models 安装 YUI）
pnpm tauri dev     # 自动拉起 sidecar + Vite(1420) + 窗口
```

首次启动后在设置（⚙）里填入 DeepSeek API Key 即可对话：Key 存本地凭据库
`harness/.cos-home-default/.credentials.yaml`（P1-1 起 cos home 按实例分叉 `…-<id>`），模型默认 `deepseek-flash`（可切换）。

### 日常开发

- **改插件**：`@diver/*` 源码在 `cos-plugins/`，重启 sidecar 即生效；启停走设置页「插件」
  （写 profile patch）。契约见 [docs/plugins.md](docs/plugins.md)。
- **独立调试 sidecar / 类型检查 / 日志 / 常见问题**：见 [docs/development.md](docs/development.md)。
- **冒烟测试**：`node scripts/smoke.mjs`（对话 + 流式）、`smoke2.mjs`（工具调用闭环）、
  `memory-test.mjs`（记忆）、`presence.mjs`（主动问候）等。
- **打包分发**：`pnpm bundle:release` 产出 Windows NSIS 安装包与 Linux AppImage / deb
  （随包 Node + 开放插件，升级按 seed manifest 对账），见 [docs/distribution.md](docs/distribution.md)。

改 Rust 代码前请先读 [AGENTS.md](AGENTS.md)：文件长度、分层依赖、command 薄适配、可单测等硬性规范。

## 最近版本

v0.2.4（2026-10-26）：OneBot 图片收发、自己发言记账与连接状态灯；sidecar 自动重启与统一日志路径；会话落盘消息 id 改随机 UUID，修复跨重启撞号导致的丢轮。完整变更见 [docs/plugins.md](docs/plugins.md) 与 [Releases](https://github.com/Yoak3n/diver/releases)。

## 后续方向

语音输入（STT）、代码签名、自动更新。详见 [docs/roadmap.md](docs/roadmap.md)。
