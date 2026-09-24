# Windows 分发（打包安装包）

Diver 用 **NSIS 安装包**（`.exe`）分发（排除 MSI 格式）。应用本体是 Tauri 2
壳，agent 大脑是一个 **Node sidecar**（自研 cos harness）。分发采用**随包 Node
方案**：把 node.exe + npm + 引擎源码（`@cos/*`）+ 插件源码（`@diver/*`）全部打进
安装包 —— **用户机器无需安装 Node**，且引擎与插件**全部开放**（源码可改）。

## 快速开始

```sh
pnpm install          # 首次
pnpm bundle:release   # 一键产出 NSIS 安装包
```

产物：

```
src-tauri/target/release/bundle/nsis/Diver_0.1.0_x64-setup.exe   # NSIS 安装器
src-tauri/resources/sidecar/                                      # 打进安装包的 sidecar 运行时
```

## 构建流程（bundle:release 做了什么）

`scripts/bundle-release.mjs` 编排：

1. **前端构建**：`pnpm build`（Vite → `dist/`）
2. **随包 Node**：复制 `node.exe` + `npm`（从开发机 Node 安装目录）
3. **引擎源码**：复制 `harness/packages/`（全部 `@cos/*` 包源码）+ `cordis.yml`
4. **引擎依赖**：在随包 `harness/` 里跑 `pnpm install`（用 lockfile，生成自洽的
   `node_modules`，含 tsx —— TS loader，运行时必需）
5. **插件源码**：复制 `cos-plugins/` 的 6 个 `@diver/*` 插件到 `plugins/`
6. **插件依赖**：`@cos/*` 链接到引擎源码、`cordis`/`yaml`/`zod`/MCP SDK 真实复制
7. **辅助脚本**：`install-deps.mjs`（一键装插件依赖）、`plugin-doctor.mjs`（诊断）
8. **NSIS 打包**：`pnpm tauri build`

## 安装包内容与运行时布局

```
安装到 %LOCALAPPDATA%\Diver（perUser，无需管理员）
├─ Diver.exe                     # Tauri 壳
└─ resources/
   ├─ tts.json                  # 在线 TTS 配置
   └─ sidecar/                   # sidecar 运行时（本目录即进程 cwd）
      ├─ node.exe                # 随包 Node 运行时
      ├─ node_modules/npm/       # 随包 npm（插件依赖安装用）
      ├─ harness/                # 引擎源码（@cos/*）+ node_modules（含 tsx）
      ├─ plugins/                # ★ 开放插件目录（@diver/* TS 源码）
      ├─ bundles/bundle-companion/  # 插件装配配置（cordis.patch.yml）
      ├─ dist/                   # 前端 UI（backend 静态托管）
      ├─ cordis.yml / secrets.example.yml
      ├─ install-deps.mjs        # 一键装插件依赖
      └─ plugin-doctor.mjs       # 插件诊断
```

用户数据（会话 / 记忆 / 工作区 / 设置）保存在 **用户数据目录**，与安装目录隔离：

```
%APPDATA%\com.diver.companion\cos\
├─ sessions/          # 会话 JSONL
├─ workspace/         # 文件工具工作区
├─ memory/            # 关系层记忆（SQLite）
├─ diver-settings.json
└─ mcp-servers.json   # MCP 服务配置（$COS_HOME 下，sidecar 插件读取）
```

> **MCP 配置位置约定**：`mcp-servers.json` 必须与 `diver-settings.json` 同目录
> （`$COS_HOME`，即 `<app_data>/cos/`）。Tauri 壳与 sidecar 插件的路径解析完全一致：
> 壳把文件写到 `$COS_HOME/mcp-servers.json`，并以 `DIVER_MCP_CONFIG_FILE` 显式注入
> 插件。早期版本曾误写到 `$COS_HOME` 的父目录（`<app_data>/`），新版本启动时
> 自动把旧文件迁移到正确位置（仅当目标缺失时）。

升级安装**不会**清掉用户数据，也不会覆盖用户在 `plugins/`/`harness/` 里的修改。

## 插件开放（核心设计）

引擎（`harness/packages/`）与插件（`plugins/`）**全部是 TS 源码**，运行时由
`companion-bundle.ts` + `companion-boot.ts` 加载：

- **核心行**（`@cos/*`）：`pluginPaths` → `harness/packages/<pkg>/src/index.ts`
- **第三方/内部行**（`@diver/*`）：`pluginRoot` → `plugins/<name>`
- **组合层**：`bundles/bundle-companion/cordis.patch.yml`（mount 真相）
- **启停**：`$COS_HOME/profiles/companion/cordis.patch.yml`（壳设置页写入）

| 操作 | 做法 | 生效方式 |
|---|---|---|
| **启停** | 设置 → 插件；或改 profile patch | 重启 sidecar |
| **修改** | 编辑 `plugins/<name>/src/*.ts`（或 `harness/packages/*`） | 重启应用即生效 |
| **删除包体** | 删 `plugins/<name>/` + 从 bundle/catalog 移除 | 重启应用即生效（P4 前需手动） |
| **新增** | 目录 + bundle insert + `plugins.json` catalog | 重启应用即生效 |
| **装依赖** | 在 sidecar 目录跑 `node install-deps.mjs` | 用随包 npm 安装 |
| **诊断** | 在 sidecar 目录跑 `node plugin-doctor.mjs` | 检查一致性 |

> 完整生命周期契约与深水区分期见仓库内 [docs/plugins.md](plugins.md)。

### 新增插件约定

1. 目录 `plugins/<name>/`：`package.json`（`main` → `src/index.ts`，`name` 形如
   `@diver/<name>`）+ `src/index.ts`（导出 `name`/`inject`/`apply`）
2. 相对导入**必须带 `.ts` 扩展名**（Node ESM + tsx 要求）
3. 依赖：在 sidecar 目录跑 `node install-deps.mjs`；import `@cos/*` 不需要（引擎提供）
4. 装配：`bundles/bundle-companion/cordis.patch.yml` 的 `insert` 加一行；
   同步 `plugins.json` catalog（显示名/描述）
5. 重启应用生效；设置 → 插件 应出现新行

## release 启动链

```
Diver.exe
 └─ spawn: resources/sidecar/node.exe --import file:///.../harness/node_modules/tsx/dist/loader.mjs
            --expose-internals resources/sidecar/harness/packages/sidecar/src/companion-bundle.ts
            --profile companion
            --bundles resources/sidecar/bundles/bundle-companion
            --plugin-root resources/sidecar/plugins
            --harness resources/sidecar/harness
    cwd      = resources/sidecar            （cordis.yml / secrets.yml 从这读）
    COS_HOME = %APPDATA%\com.diver.companion\cos
    DIVER_PORT = 53620
    DIVER_UI_DIST = resources/sidecar/dist
    └─ @cos/boot 组装 → pluginPaths(@cos/*) + pluginRoot(plugins/) + profile 启停
       → @diver/backend HTTP/SSE :53620 → WebView 加载 http://127.0.0.1:53620
```

Rust 侧（`src-tauri/src/core/sidecar/`）：
- **debug 构建**：`node --import tsx <repo>/harness/.../companion.ts`（开发）
- **release 构建**：随包 `node.exe` + `companion-bundle.ts`（打包形态）

## 常见问题

### 为什么随包 tsx 而不是 Node 原生 TS？

Node 22 的原生 type-strip 是"纯剥离"模式，**不支持 TS 参数属性**
（`constructor(private x: string)`），而 `@cos/*` 引擎大量使用。tsx 用 esbuild
完整编译，支持全部 TS 语法。tsx 已作为运行时依赖装进随包 `harness/node_modules`。

### 安装包体积

node.exe（~82MB）+ npm（~11MB）+ 引擎源码 + 插件 + 依赖 ≈ 解压后 ~100MB，
NSIS 压缩后 ~40–50MB。**已放弃 SEA 烘焙**（体积更小但插件不可启停/不可开放编辑）；
随包 Node + 开放 `plugins/` 换来可插拔与无 postject 签名问题。

### 用户改了插件但没生效？

重启 Diver（sidecar 随应用启动）。如果改了 `cordis.patch.yml` 也需要重启。
用 `node plugin-doctor.mjs` 检查目录与配置是否一致。

### 插件依赖安装失败？

确认在 **sidecar 运行时目录**（`resources/sidecar/`）运行 `node install-deps.mjs`，
且插件 `package.json` 声明了 `dependencies`。需要联网（随包 npm 从 registry 拉包）。

### SmartScreen / 杀毒误报

无 postject 注入，`node.exe`/`Diver.exe` 保持原签名。正式分发建议给
`Diver.exe`（Tauri 产物）加 EV 代码签名。

## 维护

- **改了引擎或插件源码**：重新 `pnpm bundle:release`
- **只重组装资源**（不跑 tauri build）：`pnpm bundle:release --assemble-only`
- **调试 sidecar**：
  ```sh
  cd src-tauri/resources/sidecar
  $env:COS_HOME = "$env:APPDATA\com.diver.companion\cos"
  $env:DIVER_PORT = "3699"
  .\node.exe --import file:///$((Get-Location).Path -replace '\\','/')/harness/node_modules/tsx/dist/loader.mjs `
    --expose-internals .\harness\packages\sidecar\src\companion-bundle.ts `
    --profile companion `
    --bundles .\bundles\bundle-companion --plugin-root .\plugins --harness .\harness
  # 观察 stdout：应出现 DIVER_READY http://127.0.0.1:3699
  ```
- **NSIS 安装器细节**：见 `src-tauri/tauri.conf.json` 的 `bundle.windows.nsis`
