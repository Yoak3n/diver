# 0.2.0「多实例互联」接手指南

> 给**从零开始的下一个会话**：读完本文即可接手当前开发，不需要任何对话上下文。
> 硬性代码规范见 [AGENTS.md](../AGENTS.md)（先读！），文档地图见 [index.md](index.md)。

## 1. 现状快照（2026-09-27）

- 仓库 `E:\Project\RustProject\diver`，Tauri 2 + Vue 3 + Node sidecar 桌面陪伴 agent。
- 当前分支 **`feat/multi-instance-interop`**（基线 dev=v0.1.0 `a97ee70`）：
  0.2.0「多实例互联」**P0~P2-5 全部一期落地**，Rust 测试 121 全绿 + CDP 冒烟全链通过。
- ~~工作树有一条别的会话尚未提交的「显示器 canonical 编号 + 截屏契约」线~~
  **已接手提交完毕**（2026-09-27）：crate 层 `8e52a20`、贯通层 `50db5e8`，测试闸全绿
  （`cargo test --workspace` + `vue-tsc --noEmit`）；工作树仅剩 `harness` 子模块指针
  （引擎独立流，**不进 diver 提交**）。共享工作树提交仍须**按文件归属拆清，绝不 `git add -A`**。
- 计划与决策账本在 daily 仓库：`E:\GitVault\daily\Project\Tauri\diver\开发计划\0.2.0\`
  （`多实例互联.md` 为全量设计+排查记录，`codingagent任务委派.md` 为并行立项）。

## 2. 架构速览（30 秒版）

**一壳（diver.exe）+ N sidecar（每实例独立 Node 进程 + 独立 $COS_HOME）**——
多实例核心需求是配置/记忆隔离，否决「一 sidecar 多 agent」。详见
[architecture.md](architecture.md)、[sidecar.md](sidecar.md)。

| 位置 | 职责 |
|---|---|
| `src-tauri/src/commands/` | Tauri IPC 薄适配（只做转换，禁业务分支） |
| `src-tauri/src/app/` | 组装/生命周期（setup / events / tray / shortcut） |
| `src-tauri/src/shell/` | 窗口与桌面（window/{manager,pet}、displays、webview_args…） |
| `src-tauri/src/core/` | 可单测业务（sidecar、tts、plugins、pet_interaction…） |
| `src-tauri/src/config/` | 持久化（instances、groups、pet_model、tts…；禁依赖上层） |
| `src-tauri/src/services/` | 本地 axum RPC（供 sidecar 调用，能力经 `services::start` 注入） |
| `crates/*` | 纯逻辑 crate（geom / memory / presence / search / shot），禁依赖 Tauri |
| `src/` | Vue 3 前端（组件 / composables / ipc 薄封装 / pet 桌宠） |
| `cos-plugins/` | Diver 插件（`@diver/<slug>`，命名四同规则见 AGENTS.md） |
| `harness`（子模块） | DSH/cos 引擎——**保持独立，不进 diver 提交** |

依赖单向：`commands → app/shell/core → config/services/crates`。

## 3. 0.2.0 进度账本（分支已落提交）

| 阶段 | 内容 | 提交 |
|---|---|---|
| P0 | 实例清单数据模型 + 设置面板「实例」页 | `ad0a8b1` `6d838ee` |
| P1-1 | 路径分叉 + 记忆双库（实例私有/shared） | `0dc518d` `8ad42c4` |
| P1-2 | 端口协商（DIVER_READY 就绪行）/ 实例注册表 / 身份头记忆路由 | `0313d89` `fb5ca11` `027942f` `c220ff8` |
| P1-3 | 单例常驻 + 快捷键收敛 | `ab5b30c` `0f7bd72` `f6d786b` `96cd4b6` |
| P2-1 | 鉴权 BUG-002 结案（未授权进程注入） | `9d88b0f` `0d4c334` `af6a794` |
| P2-2 | `send_to_peer` + inbox 来源标记 | `b6eafc0` `f7548ac` `b4346f9` |
| P2-3 | 私聊先行（6 提交）+ W2 群聊轮（`4e2cde5` `8568107` `75608ad` `bb178fb`） | 见左 |
| P2-4 | 群组自治一期：groups.json、`group::` RPC 五方法、章带组名、工具五件、多群 UI | `89f982b` `26d178b` `7665060` `ffc7ec7` `110ac75` `8cf5970` |
| P2-5 | 多桌宠一期：实例桌宠窗池（`pet-<id>`，同屏 3 只 160px 错位）、hash 实例绑定+名牌、召唤入口 | `8dbb313` `26c4fd2` `64d258f` `b1aedd5` |
| P2-5 收尾 | 换装定向路由 + 全局模型真源、webview_args 收口、设置页每实例模型选择器 | `ed6c527` `9effec9` `c9a0b80` |
| 收尾 | 显示器 canonical 编号唯一真源 + 事件/截屏编号同源（修「截错屏」） | `8e52a20` `50db5e8` |
| 收尾 | backend handlers.ts（877 行）按域拆 routes/*；plugins.ts（584 行）拆 store/install/装配面 | `6fb0cae` `cd1190f` |

关键机制约定（细节以代码注释与 daily 文档为准）：

- **私聊**：agent 调 `send_to_peer`；对端会话收到带来源标记的章；**邀请裁决=被邀实例 agent 自主**，拒绝必须显式告知+理由。
- **群聊三支柱**：唤醒给机会 / `stay_silent` 不硬回 / inject 收听不吵；章归属按组分章（【群聊「组名」｜来自实例 X】）。
- **多桌宠**：窗口 `pet-<id>`（URL `/#/pet?instance=<id>`），`PETS_CAP=3`，销毁用 `destroy()` 不用 `close()`；点谁互动谁（`pet://focus-instance`）。
- **模型路由**：`pet://model-changed` payload `{id, instanceId?}`——有 `instanceId` 只进目标实例宠；无则全局广播（经典宠 +「跟随全局」宠响应，钉定宠无视）。
- **全局模型真源**：`<config>/pet-model.json`（`config::pet_model`）；**localStorage 各窗隔离**（WebView2 每窗 data 目录），任何跨窗共享状态都必须走壳层配置 + IPC。

## 4. 工作流实务（会话级约定，AGENTS.md 之外）

1. **冒烟只走仓库根 `pnpm tauri dev`**——直接跑 `target\debug\diver.exe` 有白屏史（已结案，别再查前端）。
2. **CDP 冒烟方法**：debug 构建经典桌宠 `--remote-debugging-port=9223`、实例宠 9224；
   Node 22 全局 WebSocket 连 `http://127.0.0.1:9223/json` → `Runtime.evaluate`
   （`awaitPromise:true, returnByValue:true`）；页面内调 IPC 用
   `window.__TAURI_INTERNALS__.invoke(...)`（withGlobalTauri 关着，`window.__TAURI__` 不存在）；
   结果异常要读 `exceptionDetails`，否则错误被吞成 `undefined`。
3. **验证模型/资源归属**用 `performance.getEntriesByType('resource')` 的 model3 条目——
   截图考古不可靠（有过多轮误判）。
4. **测试闸**：动 Rust → `cargo test --workspace` 全绿才能提交；动前端 → `pnpm exec vue-tsc --noEmit`。
5. **单主题提交**；共享工作树时 `git add <明确路径>`，别人的在建文件一个都不带。
6. **PS 5.1 坑**：写 UTF-8 文件用 `[IO.File]::WriteAllText($p,$s,(New-Object System.Text.UTF8Encoding($false)))`
   （`-Encoding UTF8` 带 BOM，曾静默毁掉实例登记档）；cargo 成功也常 `[exit code: 1]`（管道假象，认 "test result: ok."）；
   禁按宽泛模式杀 node.exe（误杀过）。
7. **watch 重建半稳态**：dev app 重编译瞬间前端半加载（事件注册链静默哑、fetch 拒绝），
   排查以「树稳定后复测」为准，勿为瞬态改代码。
8. 设置页/主窗改配置后验证路径：`__TAURI_INTERNALS__.invoke('plugin:event|emit', {event, payload})`
   可模拟跨窗事件（发射窗不收自身事件，测试时注意方向）。

## 5. 坑速查（踩过一次就别再踩）

| 坑 | 症状 | 根治 |
|---|---|---|
| PS5.1 写 BOM | 配置解析失败静默重播种、登记行蒸发 | `load_at` 容 `\u{FEFF}`（有回归测试）；外部写 JSON 用无 BOM |
| capability 漏窗 | `event.listen not allowed on window "pet-x"` 红屏 | tauri.conf 注册的动态窗必须进 capability（`pet-*` 通配） |
| 桌宠窗 `close()` | 收起无效果 | 桌宠拦 close-request，用 `window.destroy()` |
| sync command 建窗 | 主线程挂死 | 窗口创建/销毁一律 async command |
| localStorage 跨窗 | 「跟随全局」落 default | 真源迁壳层 pet-model.json（`config::pet_model`） |
| tauri 2.11 `Monitor::primary` | 编译错（方法不存在） | `primary_monitor()` 身份比对；镜像屏同坐标，比 name（`is_primary`，有测试） |
| EnumDisplayMonitors 序 | 事件说 display 1 实为工具 0、模型截错屏 | 编号唯一真源 `diver_shot::canonicalize_displays`（主屏前 + 几何全序） |
| ReplaceFileW EIO | edit 偶发 Win32 1175 | 直接重试 |
| 游戏反作弊持锁 | diver.exe 落不了盘（如 Endfield.exe） | Restart Manager 查持有者；**先问用户**，勿杀游戏进程 |

## 6. 下一步 backlog（用户拍板后开做）

1. ~~**群管理面板二期**：成员/踢人/改名/邀请记录~~ **已完成**（`02ddb61`，2026-09-27）：
   ops 纯迁移 + services/groups_manage（用户群务，系统事件 inject）+ State 接线 +
   GroupManage.vue 面板；冒烟清单在 daily「P2-4 二期实施」节。
2. ~~**未读计数 + 侧栏收尾**~~ **已完成**（`9ff6b3b`，2026-09-27）：chat/unread
   签名跟踪（基线防历史误报，群流量归群行）+ 侧栏 99+ 徽标 + 切会话清零。
3. ~~**handlers.ts 拆分**（`cos-plugins/backend`，~860 行超限债）~~ **已完成**（`6fb0cae` `cd1190f`）：
   handlers.ts→auth/http/routes/* 纯分发器，plugins.ts→plugin-store/plugin-install/装配面。
   余下超硬限文件：`cos-plugins/memory/src/index.ts`（525）、`cos-plugins/basic-tools/src/fsio.ts`（512）。
4. **docs 债**（见记忆 675ee77a 清单）：diver-presence（L0 HSM/L1 能力矩阵/L2 ProactiveSpeak）、
   首启引导（SetupOverlay + setup://progress）、web-tools 插件、TTS 流式合成+双窗播报（配置已迁
   `config/tts.rs`，旧文档写 `config/tts.json` 过时）、examples/ 与 check-plugin-*.mjs。
5. roadmap 传统项：代码签名（SmartScreen）、语音输入（STT）、自动更新。
6. ~~另一立项：**coding agent 任务委派**~~ **一期已落地**（`a8ff5e5`，2026-09-27，拍板见 daily
   立项文档）：dsh 首发监督闭环（壳层 core/delegate + `@diver/delegate` 工具）。
   **前置**：dsh headless profile 需配有效 key（实测现为占位符 AUTH 401）；
   MCP 通道 / 设置 UI / 自动发现后置。

## 7. 文档地图

| 文档 | 内容 |
|---|---|
| [AGENTS.md](../AGENTS.md) | 代码组织硬规范（文件长度/分层/命令薄适配/单测） |
| [architecture.md](architecture.md) | 三层架构、进程拓扑、启动时序、窗口管理 |
| [development.md](development.md) | 环境、运行、调试、目录结构 |
| [plugins.md](plugins.md) | 插件权威契约（loader、profile、mount 双清单） |
| [live2d-pet.md](live2d-pet.md) | 桌宠渲染/交互/口型/窗口技术 |
| [channels.md](channels.md) | invoke / SSE / `/rpc` 分工 |
| [pet-interaction-events.md](pet-interaction-events.md) | 桌宠互动事件契约（屏幕编号同源规则在此） |
| [roadmap.md](roadmap.md) | 状态与路线 |
| daily `多实例互联.md` | 0.2.0 全量设计、拍板、冒烟证据、排查记录（**事实以此为准**） |
