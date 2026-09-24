# Windows 分发（打包安装包�?

Diver �?**NSIS 安装�?*（`.exe`）分发（排除 MSI 格式）。应用本体是 Tauri 2
壳，agent 大脑是一�?**Node sidecar**（自�?cos harness）。分�?*不随�?Node**�?
引擎源码（`@cos/*`�? 插件源码（`@diver/*`）打进安装包�?*Node 运行�?*由壳�?
首次启动时解析——优先本�?Node �?22，缺失则下载官方 zip 到应用缓存。安装包
目标体积 **15�?5MB**（对比随�?Node 方案 ~70MB）�?

## 快速开�?

```sh
pnpm install          # 首次
pnpm bundle:release   # 一键产�?NSIS 安装�?
```

产物�?

```
target/release/bundle/nsis/Diver_0.1.0_x64-setup.exe   # NSIS 安装�?
src-tauri/resources/sidecar/                            # 打进安装包的 sidecar 资源
```

## 构建流程（bundle:release 做了什么）

`scripts/bundle-release.mjs` 编排�?

1. **前端构建**：`pnpm build`（Vite �?`dist/`�?
2. **引擎源码**：复�?`harness/packages/`（全�?`@cos/*` 包源码）+ `cordis.yml`
3. **引擎依赖**：在随包 `harness/` 里跑 `pnpm install`（用 lockfile，生成自洽的
   `node_modules`，含 tsx —�?TS loader，运行时必需�?
4. **插件源码**：复�?`cos-plugins/` �?6 �?`@diver/*` 插件�?`plugins/`
5. **插件依赖**：`@cos/*` 链接到引擎源码、`cordis`/`yaml`/`zod`/MCP SDK 真实复制
6. **辅助脚本**：`install-deps.mjs`（一键装插件依赖）、`plugin-doctor.mjs`（诊断）
7. **NSIS 打包**：`pnpm tauri build`

> **Node 不进安装�?*。构建机仍需 Node �?22 �?Vite / pnpm，但产物里没�?`node.exe`�?

## Node 运行时解析（`src-tauri/src/core/node_runtime/`�?

首次启动 sidecar 前按序解析：

1. `DIVER_NODE_BIN` 显式指定
2. 旧版随包 `resources/sidecar/node.exe`（兼容）
3. 应用缓存 `%LOCALAPPDATA%\Diver\runtime\node-v*-*/`
4. PATH / 常见安装目录中的系统 Node（≥ 22�?
5. 下载官方 zip（nodejs.org，镜�?npmmirror）到应用缓存并校�?SHA256

离线环境：手动安�?Node �?22，或把官�?zip 解压到缓存目录，或设�?`DIVER_NODE_BIN`�?

## 安装包内容与运行时布局

```
安装�?%LOCALAPPDATA%\Diver（perUser，无需管理员）
├─ Diver.exe                     # Tauri �?
└─ resources/
   └─ sidecar/                   # sidecar 运行时（本目录即进程 cwd�?
      ├─ harness/                # 引擎源码（@cos/*�? node_modules（含 tsx�?
      ├─ plugins/                # �?开放插件目录（@diver/* TS 源码�?
      ├─ bundles/bundle-companion/  # 插件装配配置（cordis.patch.yml�?
      ├─ cordis.yml / secrets.example.yml
      ├─ install-deps.mjs        # 一键装插件依赖
      └─ plugin-doctor.mjs       # 插件诊断

Node 运行时缓存（按需下载，不在安装目录）�?
%LOCALAPPDATA%\Diver\runtime\node-v22.20.0-*/
```

用户数据（会�?/ 记忆 / 工作�?/ 设置）保存在 **用户数据目录**，与安装目录隔离�?

```
%APPDATA%\com.diver.companion\cos\
├─ sessions/          # 会话 JSONL
├─ workspace/         # 文件工具工作�?
├─ memory/            # 关系层记忆（SQLite�?
├─ diver-settings.json
└─ mcp-servers.json   # MCP 服务配置�?COS_HOME 下，sidecar 插件读取�?
```

**壳层配置**（由 Tauri 壳读写、sidecar 不读，见 `src-tauri/src/config/mod.rs`）位�?
`%APPDATA%\com.diver.companion\`（`app_config_dir`�?*不在安装目录**，升级不覆盖）：
`tts.json`（在�?TTS）、`window-startup.json`、`shortcuts.json`、`pet-window.json`�?

> **MCP 配置位置约定**：`mcp-servers.json` 必须�?`diver-settings.json` 同目�?
> （`$COS_HOME`，即 `<app_data>/cos/`）。Tauri 壳与 sidecar 插件的路径解析完全一致：
> 壳把文件写到 `$COS_HOME/mcp-servers.json`，并�?`DIVER_MCP_CONFIG_FILE` 显式注入
> 插件。早期版本曾误写�?`$COS_HOME` 的父目录（`<app_data>/`），新版本启动时
> 自动把旧文件迁移到正确位置（仅当目标缺失时）�?

升级安装**不会**清掉用户数据，也不会覆盖用户�?`plugins/`/`harness/` 里的修改�?

## 插件开放（核心设计�?

引擎（`harness/packages/`）与插件（`plugins/`�?*全部�?TS 源码**，运行时�?
`companion-bundle.ts` + `companion-boot.ts` 加载�?

- **核心�?*（`@cos/*`）：`pluginPaths` �?`harness/packages/<pkg>/src/index.ts`
- **第三�?内部�?*（`@diver/*`）：`pluginRoot` �?`plugins/<name>`
- **组合�?*：`bundles/bundle-companion/cordis.patch.yml`（mount 真相�?
- **启停**：`$COS_HOME/profiles/companion/cordis.patch.yml`（壳设置页写入）

| 操作 | 做法 | 生效方式 |
|---|---|---|
| **启停** | 设置 �?插件；或�?profile patch | 重启 sidecar |
| **修改** | 编辑 `plugins/<name>/src/*.ts`（或 `harness/packages/*`�?| 重启应用即生�?|
| **删除包体** | �?`plugins/<name>/` + �?bundle/catalog 移除 | 重启应用即生效（P4 前需手动�?|
| **新增** | 目录 + bundle insert + `plugins.json` catalog | 重启应用即生�?|
| **装依�?* | �?sidecar 目录�?`node install-deps.mjs` | 用随�?npm 安装 |
| **诊断** | �?sidecar 目录�?`node plugin-doctor.mjs` | 检查一致�?|

> 完整生命周期契约与深水区分期见仓库内 [docs/plugins.md](plugins.md)�?

### 新增插件约定

1. 目录 `plugins/<name>/`：`package.json`（`main` �?`src/index.ts`，`name` 形如
   `@diver/<name>`�? `src/index.ts`（导�?`name`/`inject`/`apply`�?
2. 相对导入**必须�?`.ts` 扩展�?*（Node ESM + tsx 要求�?
3. 依赖：在 sidecar 目录�?`node install-deps.mjs`；import `@cos/*` 不需要（引擎提供�?
4. 装配：`bundles/bundle-companion/cordis.patch.yml` �?`insert` 加一行；
   同步 `plugins.json` catalog（显示名/描述�?
5. 重启应用生效；设�?�?插件 应出现新�?

## release 启动�?

```
Diver.exe
 └─ resolve Node（本�?/ 缓存 / 下载�?
 └─ spawn: <node> --import file:///.../harness/node_modules/tsx/dist/loader.mjs
            --expose-internals resources/sidecar/harness/packages/sidecar/src/companion-bundle.ts
            --profile companion
            --bundles resources/sidecar/bundles/bundle-companion
            --plugin-root resources/sidecar/plugins
            --harness resources/sidecar/harness
    cwd      = resources/sidecar            （cordis.yml / secrets.yml 从这读）
    COS_HOME = %APPDATA%\com.diver.companion\cos
    DIVER_PORT = 53620
    DIVER_UI_DIST = resources/sidecar/dist
    └─ @cos/boot 组装 �?pluginPaths(@cos/*) + pluginRoot(plugins/) + profile 启停
       �?@diver/backend HTTP/SSE :53620 �?WebView 加载 http://127.0.0.1:53620
```

Rust 侧（`src-tauri/src/core/sidecar/` + `node_runtime.rs`）：
- **debug 构建**：`node --import tsx <repo>/harness/.../companion.ts`（开发）
- **release 构建**：解�?Node（本�?缓存�? `companion-bundle.ts`（打包形态）

## 常见问题

### 为什么随�?tsx 而不�?Node 原生 TS�?

Node 22 的原�?type-strip �?纯剥�?模式�?*不支�?TS 参数属�?*
（`constructor(private x: string)`），�?`@cos/*` 引擎大量使用。tsx �?esbuild
完整编译，支持全�?TS 语法。tsx 已作为运行时依赖装进随包 `harness/node_modules`�?

### 安装包体�?

不随�?Node：引擎源�?+ 插件 + 依赖 tar �?安装�?**15�?5MB**（视 harness.tar
压缩率）。首次启动若本机�?Node �?22，会下载官方 zip（~30MB）到
`%LOCALAPPDATA%\Diver\runtime\`（用户感知是「装完首次启动要联网」，而非安装包变大）�?
**已放�?SEA 烘焙**（体积更小但插件不可启停/不可开放编辑）；开�?`plugins/` 换来可插拔�?

### 用户改了插件但没生效�?

重启 Diver（sidecar 随应用启动）。如果改�?`cordis.patch.yml` 也需要重启�?
�?`node plugin-doctor.mjs` 检查目录与配置是否一致�?

### 插件依赖安装失败�?

确认�?**sidecar 运行时目�?*（`resources/sidecar/`）运�?`node install-deps.mjs`�?
且插�?`package.json` 声明�?`dependencies`。需要联网（随包 npm �?registry 拉包）�?

### SmartScreen / 杀毒误�?

�?postject 注入，`node.exe`/`Diver.exe` 保持原签名。正式分发建议给
`Diver.exe`（Tauri 产物）加 EV 代码签名�?

## 维护

- **改了引擎或插件源�?*：重�?`pnpm bundle:release`
- **只重组装资源**（不�?tauri build）：`pnpm bundle:release --assemble-only`
- **调试 sidecar**�?
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
- **NSIS 安装器细�?*：见 `src-tauri/tauri.conf.json` �?`bundle.windows.nsis`
