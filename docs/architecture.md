# 总体架构

Diver 是三层架构的桌面陪伴 agent：Rust 负责壳与原生扩展，WebView 承载 Vue 3
陪伴 UI，agent 大脑常驻于 Node sidecar（自研 cos harness，借鉴 DeepSeek Harness）。

借鉴 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的架构理念
（append-only 会话日志、turn/step agent 循环、工具注册表、persona 组装、事件驱动），
**只取其框架、不搬其交互层**：UI 为自研 Vue 单会话陪伴聊天，传输层为自研 HTTP/SSE。

## 三层结构

```
┌──────────────────────────────────────────────────┐
│ Tauri 壳（Rust）                                  │
│  · sidecar 生命周期管理（spawn/就绪检测/日志/重启） │
│  · 插件启停（profile 补丁 + 重启，见 plugins.md）   │
│  · 托盘 / 窗口管理 / 轻量模式 / 开机自启            │
│  · 在线 TTS（MiMo / MiniMax / 火山，reqwest 合成） │
│  · 本地服务（axum）：SQLite 记忆后端 JSON-RPC      │
│  · 单实例（命名管道通知已有实例）                   │
├──────────────────────────────────────────────────┤
│ WebView：Vue 3 陪伴 UI（单会话连续聊天）            │
│  · 流式渲染 / 主动问候横幅 / 设置面板 / 桌宠窗口    │
│  · 设置含「插件」页（list / enable / disable）      │
│  · dev: Vite (localhost:1420) 代理 /api           │
│  · release: sidecar 同源服务静态 UI               │
├──────────────────────────────────────────────────┤
│ Node sidecar（agent 大脑，常驻 cos harness）        │
│  · loader 契约：pluginPaths=@cos/*、              │
│    pluginRoot=开放插件目录、profile=companion      │
│  · 引擎：@cos/*（agent-loop / llm / tools / …）   │
│  · 陪伴插件 @diver/*（cos-plugins/ 或 plugins/）   │
│    backend / memory / basic-tools / mcp / voice   │
│    / llm-commandcode …（bundle insert 组装）       │
│  · 单会话「diver-companion」JSONL 持久化           │
└──────────────────────────────────────────────────┘
```

插件组合、启停状态与壳端管理的完整契约见 **[插件体系与生命周期](plugins.md)**。

## 进程拓扑与端口

| 进程 | 端口 | 说明 |
|---|---|---|
| Node sidecar（dsh） | `DIVER_PORT`（默认 **53620**） | HTTP/SSE 服务；`DIVER_READY` 标志行报告就绪 |
| Vite dev server | **1420**（strictPort） | 仅 dev 构建；`/api` 代理到 53620 |
| Rust 本地服务（axum） | 随机端口（绑定 127.0.0.1:0） | 端口通过 `DIVER_MEMORY_PORT` 环境变量注入 sidecar |

## 启动时序（Tauri `setup`）

```
configure(builder)
 ├─ opener / log / autostart / single-instance 插件注册
 └─ setup:
    1. app.manage(AppState) + Handle::init + 创建托盘
    2. services::start() → axum /rpc（SQLite 记忆后端），
       端口写入 DIVER_MEMORY_PORT
     3. plugins::ensure_profile() + SidecarManager::start()
        → node --import tsx companion.ts
        （统一契约：--profile companion --plugin-root cos-plugins
          --bundles .../bundle-companion --harness harness；
          COS_HOME=harness/.cos-home；检测 DIVER_READY）
     4. 按 window_startup 配置打开主窗口 / 桌宠窗口
```

退出时（`RunEvent::Exit`）主动 `stop()` sidecar；主窗口关闭只隐藏不退出
（`CloseRequested` → `prevent_close` + hide），agent 持续运行。

退出清理三级兜底（`base/sidecar.rs` `stop()`）：
1. `POST /api/shutdown`（令牌校验）→ Node 走 `settle()` 优雅 dispose agent 树后 exit
2. 超时/失败 → `Child::kill()` 强制终止
3. Windows Job Object（KILL_ON_JOB_CLOSE）→ 应用退出/被强杀时整进程树兜底清理

详见 [Node sidecar 与 cos 接入](sidecar.md)、[插件体系与生命周期](plugins.md)。

## 窗口管理

`src-tauri/src/base/window/` 统一管理窗口生命周期：

- **WindowType**：`Main`（主聊天窗口）/ `Pet`（Live2D 桌宠，透明/置顶/无边框/跳过任务栏）
- **Manager**：`show_window` / `close_window` / `destroy_window` / `toggle_window`，
  维护 `WindowState` 缓存，避免重复创建
- **轻量模式**（`base/lightweight.rs`）：窗口关闭计时器触发，隐藏窗口后 sidecar 与
  桌宠继续运行，到点恢复主窗口
- **启动配置**（`config/window_startup.rs`）：`auto_open_main` / `auto_open_pet`
  持久化在 app data 目录，Tauri command `get/set_window_startup_config` 读写
- **单实例**：第二个实例启动时经命名管道通知已有实例（回调把主窗口带到前台），自身退出

## 本地服务（services/）

Tauri 侧用 axum 起一个只监听 `127.0.0.1` 的 HTTP 服务，供 Node sidecar 调用
（sidecar 作为 agent 进程不直接持有 SQLite 连接）：

- `POST /rpc`：统一 JSON-RPC 入口（`{ method, params }` → `{ ok, data }` / `{ ok: false, error }`）
- 当前路由：`grep::*` 前缀 → `grep::dispatch`（grep 搜索，`spawn_blocking` 跑
  `diver-search` 引擎）；其余 → `memory::dispatch`（见 [关系层记忆](memory.md)）
- 扩展方式：`ServiceState` 加字段 → `rpc::route` 按 method 前缀分流 → merge 进 Router

grep 搜索后端（crates/diver-search）：用 `grep-regex` / `grep-searcher` / `ignore`
库进程内嵌入 ripgrep 引擎（与 rg 同源目录语义），免去打包 rg.exe 二进制的负担。
Node 侧 `@diver/basic-tools` 的 grep 工具经同一 `/rpc` 通道调用
`grep::search`（参数 `pattern` / `path` / `include?` / `maxMatches?` /
`maxBytesPerLine?`），错误带稳定 code（`INVALID_PATTERN` / `INVALID_TARGET` 等）。

数据目录：`app_data_dir()`（Windows 下为 `%APPDATA%/com.diver.companion/`），
SQLite 文件 `diver-memory.sqlite3`。

## Tauri command（invoke）

`base/cmd.rs` 暴露给前端：

| command | 说明 |
|---|---|
| `get_sidecar_status` / `restart_sidecar` / `get_sidecar_url` | sidecar 状态 / 重启 / UI 地址 |
| `list_plugins` / `set_plugin_enabled` / `toggle_plugin` / `get_plugin_paths` | 插件启停（见 [plugins.md](plugins.md)） |
| `get/set_tts_config` / `tts_list_voices` / `tts_list_models` / `tts_synthesize` | 在线 TTS 配置与合成（MiMo / MiniMax / 火山） |
| `show_main_window` | 从托盘/桌宠唤起主窗口 |
| `get/set_window_startup_config` | 窗口启动配置读写 |

sidecar 状态变更通过事件 `sidecar://status` 推给前端。

## 关键设计（对应 DSH 理念）

| 理念 | Diver 实现 |
|---|---|
| append-only 会话日志 | cos persistence JSONL，UI/模型历史都从日志派生 |
| turn/step agent 循环 | `@cos/agent-loop`：流式 chunk、工具闭环等 |
| 工具注册表 + 执行管线 | `@cos/tools`；能力面由 `@diver/*` 插件注册 |
| persona 组装 | bundle / profile patch 覆盖 `system-prompt` 行 |
| 一切皆可 patch / 可插拔 | profile + bundle + 壳端启停（[plugins.md](plugins.md)） |
| 事件驱动 UI | session/event + agent/* → SSE → Vue |

## 前端通信

`src/api.ts` 封装 sidecar HTTP API（`/api/health`、`/api/chat`、`/api/settings`、
`/api/question-answer`），`streamEvents` 用 EventSource/SSE 消费流式事件；
`composables/useChat.ts`（主窗口）与 `pet/usePetChat.ts`（桌宠）各自连接同一 SSE，
消息互通（共用同一会话/记忆）。TTS 由前端调 `tts_synthesize` 合成后经 `<audio>` 播放，口型同步在桌宠侧按真实音频时长驱动。
