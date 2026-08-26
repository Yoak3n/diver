# 开发指南

环境、运行、调试与冒烟测试。

## 环境要求

- **Node.js ≥ 22**（companion bundle 用原生 type-stripping 直接运行 TS，零构建）
- **pnpm ≥ 10**（workspace：前端 + harness）
- **Rust 工具链**（Tauri 2 依赖；`pnpm tauri dev` 会自动装 CLI）
- **Windows 10/11**（TTS 使用系统 SAPI；tool-pwsh 只在 Windows 启用）

## 安装与运行

```bash
pnpm install     # pnpm workspace：前端 + harness（安装 @deepseek-ai/dsh）
pnpm tauri dev   # 自动拉起 sidecar + Vite(1420) + 窗口
```

首次启动：在设置（⚙）里填入 DeepSeek API Key（或 opencode-go Key，可选）即可开始对话。

- Key 存入本地凭据库 `harness/.cos-home/.credentials.yaml`
- 模型默认 `deepseek-v4-flash`（可在设置中切换，下次对话生效）

## 目录结构

```
diver/
├─ src/                    # Vue 3 陪伴 UI（聊天、设置、TTS）
│  ├─ components/          # ChatArea / ComposerBar / MessageBubble / SettingsPanel 等
│  ├─ composables/         # useChat（主窗口）/ useSettings
│  └─ pet/                 # 桌宠：PetApp.vue / live2d.ts / usePetChat / pet.html
├─ src-tauri/              # Rust 壳
│  ├─ src/base/            # sidecar / tts / tray / window(Manager) / lightweight /
│  │                       # timer / state / init / cmd / handle
│  ├─ src/config/          # window_startup 配置
│  ├─ src/services/        # 本地服务：axum /rpc + memory RPC handler
│  └─ resources/speak.ps1  # TTS 脚本
├─ crates/diver-memory/    # Rust 记忆后端 crate（SQLite 存储 + 确定性逻辑）
├─ harness/                # Node sidecar workspace（pnpm，自研 cos）
│  ├─ packages/            # 所有 @cos/* 工作区插件包
│  │  └─ profile/          # DSH 对齐的 profile 模型（home/双锚点/平面回退/reconcile）
│  ├─ scripts/plugin.ts    # pnpm 转发：profile 插件管理
│  ├─ cos-plugins/         # 第三方 @diver/*（本仓库实际在仓库根 ../cos-plugins）
│  └─ .cos-home/           # 仓库本地 cos home（凭据、会话、设置、记忆；gitignore）
│     └─ profiles/companion/  # companion profile：package.json（dsh.profile.bundles）
│                            # + node_modules + cordis.patch.yml
└─ scripts/                # 冒烟测试脚本
```

## 独立调试 sidecar

diver 直连模式（默认）直接以路径引用 `cos-plugins/` 源码，零安装：

```powershell
cd harness
pnpm install
# 启动自研 cos 的常驻 HTTP sidecar（Rust 壳即以此方式拉起）：
$env:COS_HOME = "$PWD\.cos-home"; $env:DIVER_PORT = "3620"
node --import tsx --expose-internals packages/sidecar/src/companion.ts
# 然后访问 http://127.0.0.1:3620/api/health
```

也可以：`pnpm start:companion`（等价于上面 node 命令，不设端口则用默认 3620）。

### 修改第三方插件（cos-plugins）

`@diver/*` 源码在仓库根 `cos-plugins/`，companion 以
`pluginPaths` 直连加载（bundle 路径 = `../cos-plugins/bundle-companion`）。
改 `cos-plugins/` 下的文件后**重启 sidecar 即生效**，无需任何安装步骤。
（通用 profile 形态仍可用：`pnpm plugin --profile <name> -- add <pkg>`。）

### 本地服务（Rust 记忆后端 + grep 搜索）

`pnpm tauri dev` 启动时 Rust 侧自动起 axum 服务（随机端口），端口经
`DIVER_MEMORY_PORT` 注入 sidecar 环境。`snapshot` 可快速验证：

```powershell
# 找到日志中的端口，或任意 JSON-RPC 探测：
# POST http://127.0.0.1:<port>/rpc  { "method": "stats", "params": {} }
# grep 搜索：{ "method": "grep::search", "params": { "pattern": "...", "path": "..." } }
```

Rust 侧单测：`cargo test -p diver-search`（引擎）与 `cargo test -p diver services::grep`（RPC 层）。

## 冒烟测试

```bash
node scripts/smoke.mjs        # 基础对话 + 流式
node scripts/smoke2.mjs       # 工具调用闭环 + 历史
node scripts/presence.mjs     # 观察主动问候
node scripts/readlog.mjs      # 查看会话日志
node scripts/memory-test.mjs  # 记忆插件：喂事实 → recall 验证
node scripts/opencode-test.mjs # opencode-go provider 直测
```

## 日志

- Rust 侧日志：`tauri-plugin-log` 输出到控制台 + Webview + 文件
  （`%APPDATA%/diver/logs/app.log`，见 `base/init.rs`）
- sidecar 日志：stdout/stderr 实时转发到 Rust 控制台（前缀 `[sidecar]` / `[sidecar:err]`），
  同时缓存在 `SidecarStatus.logs`（环形 300 条）供 UI 查看
- 会话 JSONL：`harness/.cos-home/sessions/`（通用事件流格式：`id`/`parentId` 链 + `message` 块 `user`/`assistant`/`toolResult`，明文，方便第三方工具读取）

## 常见问题

| 现象 | 处理 |
|---|---|
| 启动报 "harness 未安装" | 根目录执行 `pnpm install`（sidecar 入口 `node_modules/@deepseek-ai/dsh/lib/bin.js`） |
| 端口被占 | `DIVER_PORT` 覆盖默认 3620；Vite 1420 为 strictPort。3620 若被上一会话残留的 sidecar 占用，`tauri dev` 启动前会自动回收（命令行匹配 `companion.ts`/`cos-sidecar.exe`）；被其他进程占用则中止并提示释放 |
| 改了 bundle 不生效 | 确认重启了 sidecar（不是只刷新窗口）；bundle 是符号链接，直接生效 |
| 桌宠不显示 | 检查启动配置 `auto_open_pet`（设置面板可改）；`pnpm tauri dev` 下默认全开 |
