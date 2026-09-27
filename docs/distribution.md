# Windows 分发（打包安装包）

Diver 用 **NSIS 安装包**（`.exe`）分发（排除 MSI 格式）。应用本体是 Tauri 2
壳，agent 大脑是一个 **Node sidecar**（自研 cos harness）。

**不随包 node.exe**（体积从 ~82MB 降到安装包 ~40–50MB）：引擎（`@cos/*`）与
插件（`@diver/*`）全是磁盘源码随包——完全开放、可改/删/加；第三方依赖闭包
vendor 化进 `sidecar/node_modules`（少数大文件）；Node 运行时由壳在**首次启动
时解析**（本机 Node ≥ 22 直接用，否则下载官方 zip 到应用缓存——见
[首启引导](first-run-setup.md)）。

## 快速开始

```sh
pnpm install          # 首次
pnpm bundle:release   # 一键产出 NSIS 安装包
```

产物：

```
target/release/bundle/nsis/Diver_0.1.0_x64-setup.exe   # NSIS 安装器（Cargo workspace 在仓库根）
src-tauri/resources/sidecar/                                      # 打进安装包的 sidecar 运行时
```

## 构建流程（bundle:release 做了什么）

`scripts/bundle-release.mjs` 编排（`--assemble-only` 只组装资源；被 tauri
`beforeBuildCommand` 引用时自动带 `--assemble-only --skip-frontend`）：

1. **前端构建**：`pnpm build`（Vite → `dist/`）
2. **组装 sidecar 运行时目录**：清空重建 `src-tauri/resources/sidecar/`
3. **桌宠模型外置**：Live2D 模型放 `resources/pet/models/` 明文（不进
   diver.exe 资产），出厂强制拉齐（`pet-models.mjs`，装不齐不出厂）
4. **引擎源码**：复制 `harness/packages/`（全部 `@cos/*` 包源码）
5. **依赖 vendor 化**：第三方依赖闭包 esbuild 打成少数大文件进
   `sidecar/node_modules`（`build-core-bundle.mjs`；tsx/esbuild 白名单在位）
6. **插件源码**：`cos-plugins/` 的 11 个 `@diver/*` 插件 → `plugins/`（entry
   插件 companion 留安装目录，其余作出厂种子）
7. **NSIS 打包**：`pnpm tauri build`

构建机 Node（`DIVER_NODE_BIN` 或 nvm/PATH 探测）**只用于构建，不随包**。

## 安装包内容与运行时布局

```
安装到 %LOCALAPPDATA%\Diver（perUser，无需管理员）
├─ Diver.exe                     # Tauri 壳
└─ resources/
   ├─ pet/models/                # Live2D 模型（明文，用户可自行增删换）
   └─ sidecar/                   # sidecar 运行时（本目录即进程 cwd）
      ├─ node_modules/           # vendor 化依赖闭包（tsx/esbuild 白名单在位）
      ├─ harness/                # 引擎源码（@cos/*）
      ├─ plugins/                # ★ 开放插件目录（@diver/* TS 源码）
      ├─ bundles/bundle-companion/  # 插件装配配置（cordis.patch.yml）
      └─ dist/                   # 前端 UI（backend 静态托管）
```

> Node 运行时**不在安装目录**：首启解析本机/缓存/下载（缓存位置
> `%LOCALAPPDATA%/Diver/runtime/`，见 [首启引导](first-run-setup.md)）。
> **TTS 配置也不随包**：运行时写在 `%APPDATA%\com.diver.companion\tts.json`
> （app_config_dir，见 [TTS](tts.md)）。

用户数据（会话 / 记忆 / 工作区 / 设置）保存在 **用户数据目录**，与安装目录隔离：

```
%APPDATA%\com.diver.companion\cos-<实例id>\   # per 实例 COS_HOME（0.2.0 起分叉）
├─ sessions/          # 会话 JSONL
├─ workspace/         # 文件工具工作区
├─ memory/            # 记忆（diver-memory-<id>.sqlite3 + shared 双库）
├─ diver-settings.json
└─ mcp-servers.json   # MCP 服务配置（$COS_HOME 下，sidecar 插件读取）
```

> 实例清单（壳层元配置）在 `app_config_dir/instances.json`；多实例布局见
> [handoff-0.2.0.md](handoff-0.2.0.md) 与 daily 计划文档。

升级安装**不会**清掉用户数据。

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
| **新增** | 目录 + bundle insert + `plugins.json` catalog | 重启应用即生效 |
| **装依赖** | 在 sidecar 目录跑 `node install-deps.mjs` | 用本机/缓存 Node 的 npm |
| **诊断** | 在 sidecar 目录跑 `node plugin-doctor.mjs` | 检查一致性 |

> 完整生命周期契约与深水区分期见仓库内 [docs/plugins.md](plugins.md)。

## release 启动链

```
Diver.exe
 └─ 解析 Node（首启引导）：DIVER_NODE_BIN → 缓存 → 系统 PATH ≥ 22 → 下载
 └─ spawn: <node> --import file:///.../node_modules/tsx/dist/loader.mjs
            --expose-internals resources/sidecar/plugins/companion/src/companion-bundle.ts
            --profile companion
            --bundles resources/sidecar/bundles/bundle-companion
            --plugin-root resources/sidecar/plugins
            --harness resources/sidecar/harness
    cwd      = resources/sidecar            （cordis.yml / secrets.yml 从这读）
    COS_HOME = %APPDATA%\com.diver.companion\cos-<实例id>
    DIVER_PORT = 随机（DIVER_READY 就绪行回报）
    DIVER_UI_DIST = resources/sidecar/dist
    └─ @cos/boot 组装 → pluginPaths(@cos/*) + pluginRoot(plugins/) + profile 启停
       → @diver/backend HTTP/SSE → WebView 加载 http://127.0.0.1:<port>
```

Rust 侧（`src-tauri/src/core/sidecar/`）：
- **debug 构建**：`node --import tsx <repo>/harness/.../companion.ts`（开发）
- **release 构建**：解析出的 Node + `companion-bundle.ts`（打包形态）

## 代码签名与自动更新（roadmap）

当前安装包与 `Diver.exe` **未签名**——Windows SmartScreen 首次运行会提示
（「仍要运行」可过）；无 postject 注入，node/Diver.exe 本体不受影响。

- **代码签名**：需要一张代码签名证书（EV 证书 SmartScreen 信誉建立最快，个人
  开发者可选 OV/IndivIDUAL，按年订阅）。拿到证书后接线点：
  1. `tauri.conf.json > bundle > windows > certificateThumbprint`（Windows 证书
     库中的指纹）或 CI 里用签名工具对产物后处理；
  2. NSIS 安装包与 `Diver.exe` 都签；时间戳服务器必配（长期有效性）。
- **自动更新**：tauri-plugin-updater 要求**更新包必须先签名**（Tauri updater
  自身的 minisign 密钥对，`pnpm tauri signer generate` 生成；私钥离线保管，
  公钥写进 `tauri.conf.json > bundle > createUpdaterArtifacts` 配套字段），
  以及一个可访问的更新清单 endpoint（静态文件/GitHub Releases 均可）。
  即：**签名是自动更新的前置**。两步都就绪后，更新流程为：启动/手动检查 →
  拉清单比对版本 → 下载签名包 → 验签 → 重启安装。

## 常见问题

### 为什么随包 tsx 而不是 Node 原生 TS？

Node 22 的原生 type-strip 是"纯剥离"模式，**不支持 TS 参数属性**
（`constructor(private x: string)`），而 `@cos/*` 引擎大量使用。tsx 用 esbuild
完整编译，支持全部 TS 语法（已 vendor 进 `sidecar/node_modules` 白名单）。

### 安装包体积

引擎 + 插件源码 + vendor 依赖 + Live2D 模型 ≈ NSIS 压缩后 ~40–50MB（不随包
node.exe/npm 后显著缩小）。**已放弃 SEA 烘焙**（体积更小但插件不可启停/不可
开放编辑）；源码随包换来了可插拔与无 postject 签名问题。

### 用户改了插件但没生效？

重启 Diver（sidecar 随应用启动）。如果改了 `cordis.patch.yml` 也需要重启。
用 `node plugin-doctor.mjs` 检查目录与配置是否一致。

### 插件依赖安装失败？

确认在 **sidecar 运行时目录**（`resources/sidecar/`）运行 `node install-deps.mjs`，
且插件 `package.json` 声明了 `dependencies`。需要联网（本机/缓存 Node 的 npm
从 registry 拉包）。

## 维护

- **改了引擎或插件源码**：重新 `pnpm bundle:release`
- **只重组装资源**（不跑 tauri build）：`pnpm bundle:release --assemble-only`
- **NSIS 安装器细节**：见 `src-tauri/tauri.conf.json` 的 `bundle.windows.nsis`
