# 开发指南

环境、运行、调试与冒烟测试。

改 Rust 代码前请先读 [AGENTS.md](../AGENTS.md)：文件长度、分层依赖、command 薄适配、可单测等硬性规范。

## 环境要求

- **Node.js ≥ 22**（companion bundle 用原生 type-stripping 直接运行 TS，零构建）
- **pnpm ≥ 10**（workspace：前端 + harness）
- **Rust 工具链**（Tauri 2 依赖；`pnpm tauri dev` 会自动装 CLI）
- **Windows 10/11**（在线 TTS 需网络；tool-pwsh 只在 Windows 启用）

## 安装与运行

```bash
pnpm install     # pnpm workspace：前端 + harness（安装 @deepseek-ai/dsh）
pnpm tauri dev   # 自动拉起 sidecar + Vite(1420) + 窗口
```

> `pnpm dev` 经 `scripts/dev-vite.mjs` 拉起 vite：调大 libuv 线程池并全量预热
> `src/**`，规避 Windows 启动期 fs 风暴占满默认 4 线程池、开窗后模块转换排队
> 数秒的白屏（复现/验证可用 `node scripts/dev-graph-crawl.mjs` +
> `node_modules/.vite/request.log` 逐请求记账）。

首次启动：在设置（⚙）里填入 DeepSeek API Key 即可开始对话。

- Key 存入本地凭据库 `harness/.cos-home-default/.credentials.yaml`（P1-1 起 cos home 按实例分叉 `…-<id>`）
- 模型默认 `deepseek-flash`（可在设置中切换，下次对话生效）

## 目录结构

```
diver/
├─ src/                    # Vue 3 陪伴 UI（聊天、设置、TTS）
│  ├─ api/                 # API 传输层：基址解析/鉴权令牌/JSON/SSE（base.ts + 领域端点模块）
│  ├─ components/          # ChatArea / ComposerBar / MessageBubble / SettingsPanel 等
│  ├─ composables/         # useChat（主窗口，composables/chat/）/ useSettings（settings-{tabs,state,actions}）/ useInstances
│  ├─ ipc/                 # Tauri IPC 前端封装（petWindow / instances…）
│  ├─ views/               # 页面级组件（ChatView / SettingsView / chat/GroupChatView）
│  └─ pet/                 # 桌宠：PetApp.vue / live2d/ / usePetChat（chat/{state,events,io}）/ emotion（emotion-{types,lexicon,map,infer}）/ pet.html
├─ src-tauri/              # Rust 壳
│  ├─ src/commands/        # Tauri IPC 薄适配（system/plugins/shortcuts/tts/tts_player/presence/pet/instances/avatar/groups/config_cmds）
│  ├─ src/app/             # 组装与生命周期（setup/{handlers,service,sidecar_boot} / events / handle / state / tray / shortcut/{manager,action}）
│  ├─ src/shell/           # 窗口与桌面集成（window/{manager,pet} / webview_args（WebView2 参数构造） / displays（显示器 canonical 编号） / lightweight / pet_mouse / notify / cursor）
│  ├─ src/core/            # 可单测业务（sidecar/{process,lifecycle,ports,runtimes,shutdown,reclaim} / instance_registry / delegate（任务委派监督：rpc/manager/notify/supervise/events…）/ explore_policy（Explore 壳调度：driver/jobs/rpc）/ tts/{synth,player,queue} / node_runtime / pet_interaction / pet_models / setup_extract/{read,extract} / setup_progress / timer / presence…）
│  ├─ src/plugins/         # 插件 catalog/profile/preflight/{registry,package,install,uninstall}
│  ├─ src/config/          # 持久化配置（window_startup / instances / groups / tasks / delegate+delegate_overlay / avatar / pet_model（全局模型真源） / pet_window / tts→config_dir/tts.json / mcp / shortcuts / profile…）
│  ├─ src/services/        # 本地服务：axum /rpc（server/rpc/auth/state）+ 领域 handler（memory/{dispatch,params,card_name} / peer / groups/{rpc,list,say,ops,body} / groups_manage / presence / grep / screenshot / registry；notify 经注入闭包）
├─ crates/diver-geom/     # 桌宠几何纯函数（config/shell/core 共用）
├─ crates/diver-memory/    # Rust 记忆后端 crate（SQLite 存储 + 确定性逻辑）
│  └─ src/db/              # store / topics / events / entities / mappers…
├─ crates/diver-presence/  # 陪伴状态机 crate（FSM / 探索策略 / 快照）
├─ crates/diver-search/    # 搜索引擎 crate（无传输层）
├─ crates/diver-shot/      # 屏幕捕获 + JPEG 编码 crate（Win GDI / Wayland portal）
├─ cos-plugins/            # @diver/* 插件工作区（memory / backend / companion / bundle-companion…）
├─ harness/                # Node sidecar workspace（pnpm，自研 cos）
│  ├─ packages/            # 所有 @cos/* 工作区插件包（含 skills / system-prompt）
│  │  └─ profile/          # DSH 对齐的 profile 模型（home/双锚点/平面回退/reconcile）
│  ├─ scripts/harness/plugin.ts    # pnpm 转发：profile 插件管理（harness 侧脚本在 scripts/harness/）
│  ├─ cos-plugins/         # 第三方 @diver/*（本仓库实际在仓库根 ../cos-plugins）
│  └─ .cos-home-<id>/      # 仓库本地 cos home，按实例分叉（默认实例 .cos-home-default；gitignore）
│     └─ profiles/companion/  # companion profile：package.json（dsh.profile.bundles）
│                            # + node_modules + cordis.patch.yml
└─ scripts/                # 冒烟测试脚本
```

## 独立调试 sidecar

dev 与壳使用**同一 loader 契约**（profile + pluginRoot + bundle + harness）：

```powershell
cd harness
pnpm install
$env:COS_HOME = "$PWD\.cos-home-default"
$env:DIVER_PORT = "53620"
node --import tsx --expose-internals ../cos-plugins/companion/src/companion.ts `
  --profile companion `
  --plugin-root ..\cos-plugins `
  --bundles ..\cos-plugins\bundle-companion `
  --harness .
# 然后访问 http://127.0.0.1:53620/api/health
```

也可以：`pnpm start:companion`（脚本若未传参，以 `companion-boot.ts` 默认布局为准）。

### 插件启停（设置页 / profile）

- UI：设置 → **插件** → 开关（写 `$COS_HOME/profiles/companion/cordis.patch.yml` 并重启 sidecar）
- 手动：在 profile patch 中写 `- id: <行id>` + `disabled: true`，重启 sidecar 生效
- 契约、catalog、坑位见 [plugins.md](plugins.md)

### 修改第三方插件（cos-plugins）

`@diver/*` 源码在 `cos-plugins/`，经 `pluginRoot` 解析。改文件后**重启 sidecar 即生效**。
新增插件需同时改 bundle `cordis.patch.yml` insert 与 `plugins.json` catalog（见 plugins.md §7）。

### 本地服务（Rust 记忆后端 + grep 搜索）

`pnpm tauri dev` 启动时 Rust 侧自动起 axum 服务（随机端口），端口经
`DIVER_MEMORY_PORT` 注入 sidecar 环境。`snapshot` 可快速验证：

```powershell
# 找到日志中的端口，或任意 JSON-RPC 探测：
# POST http://127.0.0.1:<port>/rpc  { "method": "stats", "params": {} }
# grep 搜索：{ "method": "grep::search", "params": { "pattern": "...", "path": "..." } }
```

Rust 侧单测：`cargo test -p diver-search`（引擎）、`cargo test -p diver-shot`（截图引擎；Wayland 路径可 `cargo check -p diver-shot --target x86_64-unknown-linux-gnu`）、`cargo test -p diver services::grep` / `services::screenshot`（RPC 层）。

## 类型检查

```bash
pnpm typecheck              # harness + 全部 cos-plugins（根目录）
cd cos-plugins/memory && npx tsc --noEmit   # 单插件独立检查
```

插件类型面见 `@cos/plugin-api`（`harness/packages/plugin-api`）；契约与 P1 说明见
[plugins.md](plugins.md)。

```bash
node scripts/smoke.mjs        # 基础对话 + 流式
node scripts/smoke2.mjs       # 工具调用闭环 + 历史
node scripts/presence.mjs     # 观察主动问候
node scripts/readlog.mjs      # 查看会话日志
node scripts/memory-test.mjs  # 记忆插件：喂事实 → recall 验证
```

冒烟脚本自动携带本地服务鉴权令牌（P2-1 / BUG-002）：取 `DIVER_TOKEN` 环境变量，
缺省回落 debug 形态壳端落盘的 `<app_data>/service-token`（`scripts/service-auth.mjs`）。
手动 curl `/api` 或 `/rpc` 时同样需要 `Authorization: Bearer <令牌>`（`GET /api/health`
与 `/api/shutdown` 除外）。

## 插件工具链与示例

### 打包闭包检查

```bash
pnpm bundle:release --assemble-only --skip-frontend   # 先组装 sidecar 资源
node scripts/check-plugin-closure.mjs                 # 打包产物闭包自检（退出码 0=通过）
```

`check-plugin-closure.mjs` 锚定最终产物 `src-tauri/resources/sidecar/`：打包
不变量（无 tar 归档 / 无嵌套 node_modules / tsx+esbuild 在位 / 进程入口在位）、
用户工作区 junction 模拟、**全部随包源码裸 import 按 Node 真实解析**、解析落点
必须 ⊆ sidecar（借道开发机 node_modules 即 FAIL）。CI 在 ts-check job 自动跑
（`.github/workflows/ci.yml`），`bundle-release.mjs` 组装末尾也会自动调用。
旧实现 `check-plugin-deps.mjs` 锚定仓库源码会假绿，**已被取代、无引用**（仅留档）。

### 示例插件（examples/）

| 目录 | 用途 | 加载方式 |
|---|---|---|
| `examples/dsh-compat-example` | DSH 风格注册语法示例（`defineTool` + `ctx.tools.register(definition)`，cos 兼容层的等价别名形式） | pnpm workspace 成员；作为示例插件装配 |
| `examples/hello-tool` | P4 profile 安装/卸载验证用（**非** bundle 行） | `pnpm add file:../../examples/hello-tool` 装进 profile 后随 boot 生效 |

### harness 侧开发脚本（scripts/harness/）

| 脚本 | 用途 |
|---|---|
| `plugin.ts` | `pnpm plugin --profile <name>` 薄转发：profile 插件管理 |
| `dsh-compat-test.ts` | DSH 兼容冒烟：defineTool → register → execute |
| `plugin-config-test.ts` / `plugin-config-persist-test.ts` | 插件配置校验 / 持久化冒烟 |
| `provider-boot-smoke.ts` | boot companion 组合并打印已注册 LLM provider |
| `scaffold.ts` | 插件树脚手架生成器 |

### 运行时随包工具（在 sidecar 运行时目录内跑）

`plugin-doctor.mjs`（装配一致性诊断，`node plugin-doctor.mjs [--plugins <dir>]`）、
`install-deps.mjs`（为用户插件工作区装第三方依赖）。见
[distribution.md](distribution.md)。

### 各插件自带冒烟

`cos-plugins/*/scripts/smoke.ts`（离线逻辑冒烟，esbuild bundle 后 node 运行）；
web-tools 另有需外网的 `live-probe.ts`。

## 日志

- Rust 侧日志：`tauri-plugin-log` 输出到控制台 + Webview + 文件
  （`%APPDATA%/diver/logs/app.log`，见 `app/setup/`）
- sidecar 日志：stdout/stderr 实时转发到 Rust 控制台（前缀 `[sidecar]` / `[sidecar:err]`），
  同时缓存在 `SidecarStatus.logs`（环形 300 条）供 UI 查看
- 会话 JSONL：`harness/.cos-home-default/sessions/`（通用事件流格式：`id`/`parentId` 链 + `message` 块 `user`/`assistant`/`toolResult`，明文，方便第三方工具读取）

## 常见问题

| 现象 | 处理 |
|---|---|
| 启动报 "harness 未安装" | 根目录执行 `pnpm install`（sidecar 入口 `node_modules/@deepseek-ai/dsh/lib/bin.js`） |
| 端口被占 | 缺省随机预选（`DIVER_PORT` 0/缺省 → 壳取空闲端口），一般不会撞；需固定端口时显式 `DIVER_PORT=<port>`。显式端口若被上一会话残留的 sidecar 占用，`tauri dev` 启动前会自动回收（命令行匹配 `companion.ts` / `companion-bundle.ts`）；被其他进程占用则中止并提示释放。Vite 1420 为 strictPort |
| 退出后有残留 sidecar 进程 | 正常退出走三级清理（`/api/shutdown` 优雅退出 → `kill()` → Job Object 兜底），不应残留；若强杀应用后仍有残留，下次启动会自动回收。手动清理：`Stop-Process -Name node -Force`（先确认没有别的 node 任务） |
| 改了 bundle 不生效 | 确认重启了 sidecar（不是只刷新窗口）；bundle 是符号链接，直接生效 |
| 桌宠不显示 | 检查启动配置 `auto_open_pet`（设置面板可改）；`pnpm tauri dev` 下默认全开 |
