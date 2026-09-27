# 首启引导（SetupOverlay + setup://progress）

> 首次启动 / 升级安装后的「应用内准备进度」链路：解压依赖、准备 Node 运行时、
> 等 sidecar 就绪。设计原则：**不弹控制台、不闪现**——例行启动全程静默，
> 只有真正有活干（解压 / 下载 Node）时遮罩才点亮。

## 总览

```
release 启动
 ├─ needs_bootstrap() 判定是否有首启工作（setup_progress.rs）
 │    ├─ resources/sidecar 有待解压归档 → extract 阶段
 │    └─ 本地无可用 Node → node 阶段
 ├─ 首启强制弹主窗口（startup.auto_open_main || needs_bootstrap）
 └─ 后台线程编排进度（app/setup.rs）
      start 0%「正在启动助手…」→ sidecar.start() 85%
        → extract（解压，如需）→ node（解析/下载，如需）
        → 轮询 HTTP health → ready 100% done + backend://ready
        → 超时 → error（遮罩保持，显示错误）
```

## 进度契约：`setup://progress`

事件源：`core/setup_progress.rs`。payload（`SetupProgress`）：

| 字段 | 形状 | 说明 |
|---|---|---|
| `phase` | `extract \| node \| start \| ready \| error` | 阶段；`start`=例行拉 sidecar（不点亮遮罩） |
| `message` | string | 展示文案 |
| `percent` | 0–100 | emit 时 clamp |
| `done` | bool | 完成态；`done=true` 不点亮遮罩（防例行「已就绪」闪现） |
| `error` | string? | 仅 error 阶段 |

每次 emit 同时写入进程内 `LAST` 快照；`get_setup_progress` command（WebView 晚
挂载时回放）。前端四条通道兜底：`setup://progress` 事件 + `backend://ready` 事件 +
`get_setup_progress` 轮询 + `getSidecarStatus` 轮询（400ms，防事件早于监听）。

## 遮罩组件：`src/components/SetupOverlay.vue`

非交互进度条（无步骤向导、无跳过按钮）。点亮规则（关键设计）：

- **只在 `phase ∈ {extract, node}` 且 `done=false` 时点亮**——`start` 阶段是每次
  启动都有的例行工作，显示会让遮罩每次启动闪现；
- `ready && done` → 置 100%，280ms 后隐藏；`backend://ready` → 200ms 后隐藏；
- `error` → 显示错误信息并**保持**；sidecar 轮询发现 `crashed` → 显示启动失败。

## 首启判断：`needs_bootstrap`（setup_progress.rs）

- **dev 构建（debug_assertions）恒 false**——依赖走本地 pnpm，无解压/下载。
- release：`resource_dir()/resources/sidecar` 有待解压归档 **或** 本地无可用 Node。
- 不得用进程内 `last_progress()` 判断（每次启动都是 None，会旁路
  「启动时打开主窗口」配置）。

## 两个阶段的实做

### extract（解压运行依赖，`core/setup_extract.rs`）

- 解压 `harness/node_modules.tar.zst|tar` 与 `plugins/node_modules.tar.zst|tar`
  到同级目录；纯 IO，4–16 线程并行，条目路径消毒防 `..` 穿越。
- 幂等 marker：`.deps-extracted`（记时间戳）；**归档比 marker 新 → 升级强制重
  解压**（先清空旧目录）；完成后删归档省磁盘；无事可做时**完全静默**。
- 进度：3% 起 → 8 + 84×(done/total) → 100%。
- ⚠️ 现状：`bundle-release.mjs` 已改为依赖 vendor 化（少数大文件）+ `plugins.seed/`
  播种，**不再生成归档**——extract 链路对新生成的安装包处于休眠/兼容状态
  （见 [distribution](distribution.md)）。

### node（Node 运行时准备，`core/node_runtime/`）

解析顺序（`node_runtime/mod.rs` 头注释）：

1. `DIVER_NODE_BIN` env
2. 旧随包 `resources/sidecar/node.exe`（兼容已解压目录）
3. 应用缓存 `%LOCALAPPDATA%/Diver/runtime/node-*/node.exe`
4. 系统 PATH 上 Node ≥ 22
5. 下载官方 zip 到缓存（3 → 命中后后续启动静默）

仅当本地无 Node 才广播进度（有则全程静默）：0%「正在准备 Node 运行时…」→
逐行 resolve 日志 30% → 100%「Node 就绪（source）」→ 失败 emit_error。

## 完成状态的持久化

**没有显式「引导已完成」标记**（无设置项 / localStorage）。不复发是文件系统
隐式状态：解压有 `.deps-extracted` marker + 归档已删；Node 缓存命中。
主窗口是否自动打开由 `window-startup.json` 独立持久化，与引导无关。

## 测试

- `setup_progress.rs`：归档探测（无 tar → false / 缺 marker → true）
- `setup_extract.rs`：zstd 魔数、路径消毒、tar/zstd 解压、穿越条目跳过（+
  `#[ignore]` 真实归档基准）
- 事件发射与 UI 编排无自动化（人工冒烟：release 安装包首启/二次启动）。
