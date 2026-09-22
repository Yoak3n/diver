# 通信通道收敛（设计）

> 目标：产品侧沟通方式尽量少、职责清晰，避免「同一件事三条路」。
> 背景讨论：是否精简 `/rpc`、用 `@diver/backend` 扩展 cordis 事件转发来替代。
>
> 相关：[plugins.md](plugins.md) · [plugins-upstream-comparison.md](plugins-upstream-comparison.md)

---

## 1. 现状（收敛前）

| 通道 | 方向 | 用途 |
|---|---|---|
| Tauri `invoke` | WebView → Rust | 窗口/桌宠/在线 TTS/插件启停/MCP 配置/sidecar 状态 |
| HTTP/SSE `:53620` | WebView → Node backend | chat / settings / history / stream / shutdown |
| HTTP `/rpc` | **Node agent → Rust** | memory SQLite、grep |
| 文件（COS_HOME） | 壳 ↔ sidecar 插件 | profile 启停、mcp-servers、diver-settings |

问题不在「通道数量」本身，而在 **UI 同一领域走了 invoke + 文件 + 未来可能再走 RPC**，心智分裂。

---

## 2. 关键区分：事件转发 vs 请求/响应

```text
cordis 事件（backend SSE 可扩展）
  session/event · agent/* · tool/* · compaction/*
  → 单向通知，服务 UI/桌宠「发生了什么」

agent 工具（Node 进程内 ctx.tools）
  remember / grep / … 执行时需要「现在就调用壳能力」
  → 请求/响应，Node 必须能主动打到 Rust
```

| | backend 转发事件 | `/rpc` |
|---|---|---|
| 方向 | Node → UI（推送） | Node → Rust（调用） |
| 时序 | 异步、可丢帧（UI） | 工具执行路径上同步/可 await |
| 能否写记忆、跑 grep | ❌ | ✅ |
| 消费者 | Vue / 桌宠 | memory / basic-tools |

**结论：** 扩展 SSE **不能**消灭 Node→Rust；只能让 UI 不再另开杂讯通道。

---

## 3. 目标架构（产品通道 = 2 + 内部基底）

```text
┌─────────────────────────────────────────────────────────┐
│ 通道 A — 大脑面（唯一 UI 业务入口）                        │
│   Vue / 桌宠  ↔  backend HTTP/SSE  (DIVER_PORT)         │
│   chat · settings · history · stream                     │
│   【扩展】plugins · native 状态 · 更多 cordis 事件帧      │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ 通道 B — 壳面（WebView 专用，保持薄）                      │
│   invoke：窗口/桌宠几何 · TTS · 托盘 · 单实例              │
│   进程：spawn/stop sidecar（壳内部，不对 UI 暴露业务语义） │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ 通道 C — 内部基底（非产品协议）                            │
│   仅当能力必须住在 Rust 时存在                             │
│   形态：/rpc 或未来 stdin；**UI/插件业务 API 禁止依赖**    │
└─────────────────────────────────────────────────────────┘
```

**精简原则：**

1. **一切 agent 业务状态/操作 → 通道 A**（backend）。
2. **一切真·原生壳 UI → 通道 B**（invoke），禁止在 invoke 里复刻 backend 已有语义。
3. **通道 C 不得成为第三套业务 API**；要么能力进 Node（去掉 C），要么 C 保持极窄且无 UI 消费方。

---

## 4. 对「扩展 backend 替代 rpc」的两阶段方案

### 阶段 1 — 先收敛 UI（推荐先做，不删 Rust）

backend 增加（全部走 `:53620`，UI **不再 invoke**）：

| API / 事件 | 说明 |
|---|---|
| `GET /api/plugins` | 列表（读 profile + catalog + registry） |
| `POST /api/plugins/toggle` | 写 profile disabled → 请求重启 |
| `POST /api/plugins/install` / `uninstall` | P4 逻辑迁到 Node（pnpm 在 sidecar 内执行）或 backend 编排 |
| `GET /api/profile` · `POST /api/profile` | active_profile / safe 切换 |
| `GET /api/native/status` | 包装 native-bridge 探测 |
| SSE 扩展 | `plugin/*`、`agent/*` 活体帧、`tool/*` 摘要（桌宠/设置用） |
| 重启约定 | backend 写 `$COS_HOME/restart-requested` 后 `POST /api/shutdown`；壳监控退出见标志则自动再 spawn |

**invoke 保留且仅剩：** `speak` / 窗口与桌宠 / `get_sidecar_status`（进程级）/ 必要时 `restart_sidecar`。

**RPC 此阶段仍在：** memory/grep 内部使用；UI 不感知。

效果：产品心智 = **业务一条 HTTP + 壳若干 invoke**；`/rpc` 降级为实现细节。

### 阶段 2 — 真正去掉通道 C（若坚持「无 RPC」）

必须把「住在 Rust 的能力」搬进 Node，否则工具链断裂：

| 能力 | 现状 | 去 RPC 方案 | 代价 |
|---|---|---|---|
| 记忆 | Rust SQLite `/rpc` | ① Node 内 SQLite（better-sqlite3 等）② 或 JSON/append-only 存储 + TS 衰减逻辑 | ① 原生模块/ABI；② 失去现 crates/diver-memory 测试与性能 |
| grep | `diver-search` `/rpc` | ① Node spawn `rg`（PATH）② 或纯 JS 有限搜索 | ① 依赖用户机器 rg；② 大仓库性能/语义退化 |
| 未来原生 | 设计为 `/rpc` | 一律先做 Node 插件；非做不可再评估 IPC | Rust 资产利用率下降 |

阶段 2 完成后删除：`src-tauri/src/services/{rpc,memory,grep}.rs`、`DIVER_MEMORY_PORT`、`nativeRpc` 的 UI 用途；`native-bridge` 若仍存在则仅作文档/探测或一并删除。

**不建议**用「backend 转发事件」冒充阶段 2：事件不能完成 `store.updateCard` / `grep::search`。

---

## 5. SSE 事件目录（阶段 1 扩展建议）

| 事件 | 载荷要点 | 消费者 |
|---|---|---|
| `chat/*` / assistant 流 | 现有 sse.ts | 主聊天 |
| `plugin/list-changed` | 简表 | 设置页刷新 |
| `agent/live` | 工具名/推理尾/状态（桌宠） | 桌宠气泡 |
| `native/status` | 探测摘要（可选节流） | 诊断 |
| `profile/changed` | companion/safe | 设置页 |

帧格式保持现有 SSE 风格，避免第二套序列化。

---

## 6. 决策表

| 主张 | 判定 |
|---|---|
| UI 走 backend 扩展，减少 invoke 业务面 | ✅ 该做 |
| 用 SSE 事件替代 memory/grep 的 RPC | ❌ 方向错误 |
| 业务能力尽量实现在 cos 插件（Node） | ✅ 产品向 |
| 保留极窄 Rust `/rpc` 作为内部基底 | ✅ 可接受，须文档化「非产品 API」 |
| 彻底无跨进程 Rust 能力 | ⚠️ 仅当接受记忆/grep 迁出或降级 |

---

## 8. 对照 Desktop：`/rpc` 在上游是否被「别的通道」替代了？

> 证据：`packages/dsh-tauri/src/host/utils/{open,spawn}.ts`（Node 直接 spawn）、
> `packages/dsh-tauri-panel-extension/src/host/service/mcp.ts`（Node 读写 profile YAML）、
> `src-tauri/src/bridge/mod.rs`（Tauri command 面向 **WebView**）、
> `packages/dsh-tauri-pet/.../session-stream`（**Rust 消费** dsh HTTP SSE）。

### 8.1 Desktop 实际拓扑（与直觉相反）

```text
Desktop React WebView ──invoke──► Rust bridge/*（窗口/插件安装/桌宠/更新…）
         │
         └─ iframe postMessage 桥 ──► 同上（dsh 界面内的 UI 调 Rust）

dsh 宿主（Node）──h3 HTTP──► 被 WebView/Rust **作为客户端调用**
dsh 宿主（Node）──child_process──► OS（open/explorer，不经 Rust）
dsh 宿主（Node）──fs──► DSH_HOME / profile YAML / 插件目录

Rust ──SSE HTTP──► 消费 dsh 的 session-stream（桌宠）
dsh 宿主 ──✖──► 没有通用「Node→Rust 业务 RPC」层
```

| 能力在 Desktop 怎么做 | 通道 |
|---|---|
| 打开 URL / 资源管理器 | **Node `spawn`**，不是 invoke/RPC |
| MCP / 插件清单 | **Node 读写** profile 与 patch YAML |
| 桌宠窗口、安装器、更新 | **WebView invoke → Rust**（UI 发起） |
| 会话增量给桌宠 | **Rust 调 dsh HTTP SSE**（方向：壳→大脑） |

### 8.2 因此对「RPC 能否被替代」的准确回答

| 问法 | Desktop 给出的答案 |
|---|---|
| 有没有另一条 **传输层** 替代 Node→Rust RPC，同时 **继续用 Rust 实现** memory/grep？ | **没有。** 上游根本没建这层 |
| 大脑进程如何获得「桌面/系统能力」？ | **优先在 Node 内做**（fs / spawn / 自己的 HTTP） |
| 壳何时参与？ | **UI 发起** invoke，或 **壳作为客户端** 调 dsh 的 HTTP |
| dsh 是否「调用 Rust 存业务数据」？ | **未采用该模型**；状态多在 DSH_HOME 与 dsh 进程内 |

**结论：**

- Desktop **不是**「用 SSE/事件/HTTP 取代了 RPC」，而是 **把能力下沉到 Node，避免 Node→Rust 业务调用**。
- Diver 的 `/rpc` 对应的是 Desktop **刻意不做** 的那类通道：agent 工具要同步用 Rust 实现。
- 若 **完全对齐 Desktop**，可选路径是：

  | 路径 | 含义 | 代价 |
  |---|---|---|
  | **对齐 Desktop** | memory/grep **改为 Node 实现**；删 `/rpc`；UI 只走 backend；壳 invoke 只留窗口/TTS | 放弃/重写 `diver-memory`、`diver-search`；搜索质量与维护成本上升 |
  | **保持 Diver** | 能力留 Rust；`/rpc` 降级为 **内部基底**；产品面仍收敛到 backend + 薄 invoke | 多一个内部通道，但 UI 心智可统一（阶段 1） |
  | **混用（现状+收敛）** | 同上，并文档化「非产品 API」 | 推荐默认 |

### 8.3 和「backend 多转发 cordis 事件」的关系

- Desktop 的 **host HTTP + UI invoke** 解决的是：**壳/界面如何使用大脑与原生窗**。
- 事件/SSE 解决的是：**状态如何推给 UI / 外置窗**。
- 二者都 **不能** 在保留 Rust 实现的前提下，变成 agent 工具的 Node→Rust 请求通道。

**一句话：** Desktop 证明「可以没有 RPC」的方式是 **别把该能力放在 Rust**；不是「换一种协议继续调 Rust」。

---

## 9. 变更记录

| 日期 | 内容 |
|---|---|
| 初稿 | 澄清事件转发与 RPC 的不可替代边界；给出两阶段收敛方案 |
| 续 | §8：Desktop 实证——无通用 Node→Rust 业务 RPC；能力 Node 化或 UI invoke / 壳调 dsh HTTP |
| 续 | **移除 `@cos/sidecar` stdin/stdout JSON-RPC**（代码与文档）；常驻集成面仅 companion HTTP/SSE |
