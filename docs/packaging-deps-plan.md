# 依赖打包优化方案：消灭 node_modules 海量小文件（参考 pi）

> 状态：方案稿，待确认后实施。目标：消除首启动时解压上万个小文件导致的长时间等待。

## 1. 背景与量化证据

安装包体积不是问题，**文件数量**才是：首启要把依赖闭包还原成上万个小文件，NTFS 每个文件都要
create + write + close，单线程 tar 解压耗时以十秒计。

当前数据（`target/release/resources/sidecar/` 实测）：

| 归档 | 体积 | 条目数（=解压时创建的文件/目录） |
|------|------|------|
| `harness/node_modules.tar` | 100.5 MB | 15,050 |
| `plugins/node_modules.tar` | 23.3 MB | 5,231 |

- 首启一次性创建约 **2 万个文件**；解压由 `core/setup_progress.rs::extract_tar`（Rust `tar`
  crate，单线程 unpack）或随包 `scripts/extract-deps.mjs`（调 `tar.exe`）完成，见
  [architecture.md](architecture.md) 的首启准备链路。
- 归档为**未压缩 tar**（`bundle-release.mjs` 2.8b：`tar -cf`），下载/安装体积无收益。
- **结构性浪费**：pnpm 布局下 `.pnpm` store 与提升到顶层的真实副本近乎把闭包存两遍
  （15,050 条目里大半是 `.pnpm/`）。`bundle-release.mjs` 2.4b/2.4c（179–282 行）的
  `derefNodeModules` + `promotePkg` + 一串兜底拷贝（schemastery/cosmokit/cordis/yaml/zod）
  都是在补偿「pnpm 链接布局 × NSIS 不跟随链接」的矛盾 —— 维护债本身也是信号。

### 基线实测（2026-09-25，开发机 NVMe、热缓存，`tar.exe` 解压到临时目录）

| 归档 | 文件数 | 目录数 | <4KB | <64KB | 小文件体积 | 大文件体积 | 解压耗时 |
|------|-------|-------|------|-------|-----------|-----------|---------|
| harness | 12,064 | 2,986 | 10,138 (84%) | 12,028 | 41.1 MB | 49.0 MB | **6.5s** |
| plugins | 4,493 | 738 | 3,372 (75%) | 4,464 | 15.9 MB | 3.6 MB | **2.0s** |

- 两轮计时一致（6.5/2.0s），合计 **≈8.5s** —— 这是热缓存 NVMe 的**下限**；用户机器
  （机械盘 / 冷缓存 / Defender 实时扫描逐文件检测）预计数倍于此，与「解压时间过长」的
  现场反馈吻合。
- **85% 的文件小于 64KB、只占约一半体积**（约 36 个大文件装着 49MB，多为 esbuild/TS
  工具链二进制）—— 典型的「文件数量问题」而非体积问题，逐文件 create/write/close 的
  元数据开销是瓶颈。

## 2. pi 的打包方式（参考对象：E:\GitVault\pi）

pi（`@earendil-works/pi-coding-agent`）的发行物**几乎不含 node_modules**，问题被结构性消灭
而不是优化解压：

1. **esbuild 全量 bundle**（`scripts/build-coding-agent-bundle.mjs`）：
   - `bundle: true`，整个依赖图打成少数 ESM 文件（`dist/bundle/cli.js` 等）；
   - `format: esm`、`target: node22.19`、`minifySyntax + minifyWhitespace`；
   - banner 注入 `createRequire` shim 兼容 CJS 依赖；惰性 jiti 插件延迟加载重依赖。
2. **external 严格白名单**：仅 `@earendil-works/chord`、wasm 包、`jiti`、可选原生加速器
   （bufferutil / utf-8-validate / kerberos / supports-color）等；`validateExternalImports`
   在构建期校验，白名单外的 external 直接构建失败 —— 保证 bundle 自洽。
3. **发布校验**（`scripts/check-runtime-deps.mjs`）：产物里非 builtin 的 import 必须在
   `dependencies` 显式声明；`npm-shrinkwrap.json` 锁定剩余少量依赖。
4. **可选单文件二进制**（`build:binary`）：`bun build --compile` 把引擎 + 依赖编译成一个
   可执行文件，连 Node 运行时都不用带。
5. npm 包 `files` 只含 `dist`：安装时 npm 装的只是白名单里那几个包，小文件个位数。

## 3. diver 与 pi 的差异（不能照抄全量 bundle 的原因）

| 约束 | diver 现状 | 影响 |
|------|-----------|------|
| 插件开放 | `plugins/@diver/*` 以 **TS 源码**随包，README.txt 承诺可改/删/增 | 插件本体不能 bundle 死 |
| 引擎开放 | `harness/packages/@cos/*` 源码随包，tsx 运行时加载 | 同上（约束弱于插件） |
| TS 运行时 | tsx 加载 TS 源码 | esbuild 原生二进制等必须是真实文件 |
| 用户可装依赖 | `install-deps.mjs` 为插件追加真实依赖 | node_modules 语义必须保留 |

结论：**bundle 的对象是「第三方依赖闭包」，不是插件/引擎源码**。源码照旧开放可改，
依赖从「上万小文件」变成「几百个大 vendor 文件 + 解析垫片」。

### 3.1 硬性约束：cos-plugins 插件层源码可读写（不可被打包破坏）

`cos-plugins/` 下的 diver 层插件（`@diver/*`，安装后位于 `resources/sidecar/plugins/`）
是产品的开放面，**「源码可读写」是需求，不是现状描述**。完整语义：

1. **明文 TS**：`plugins/<name>/src/*.ts` 以可读源码落盘 —— 不编译、不打包、不压缩、
   不加密；用户（和 agent 自己）可以直接阅读和编辑。
2. **改动生效**：改 `src/*.ts` 后重启应用即生效（cordis + tsx 运行时加载源码）。
3. **可增可删**：新增 = 目录 + `cordis.patch.yml` 一行；删除 = 目录 + patch 行，
   与 [plugins.md](plugins.md) / README.txt 一致。
4. **依赖可装**：`install-deps.mjs` 为插件追加真实依赖，`plugin-doctor.mjs` 可诊断。
5. **升级保留**：应用升级后用户对插件源码的修改不应被静默覆盖（策略见 §8.4）。

对各阶段的保证：

| 阶段 | 对 `plugins/<name>/src` 的影响 | 对 `plugins/node_modules` 的影响 |
|------|------------------------------|-------------------------------|
| P0 | **零影响**（源码不进归档） | 剪 `.pnpm` / zstd，布局语义不变 |
| P1 | **零影响**（`@diver/*` 不进 vendor） | npm 包变垫片 + vendor；用户装的真实包优先于垫片 |
| P2 | 引擎可闭源，**插件源码仍外置加载** | 同 P1 |

任何实施若触碰第 1–4 条，视为方案失败，回退该步。

## 4. 方案对比

| 方案 | 小文件数 | 首启解压 | 开放性 | 风险 |
|------|---------|---------|--------|------|
| A. 现状（pnpm + deref + 未压缩 tar） | ~20,000 | 数十秒 | 完整 | — |
| B. 仅剪 `.pnpm` + zstd + 并行解压 | ~10,000 | 数秒 | 完整 | 低 |
| C. **vendor bundle + 垫片（推荐）** | 数百 | **趋近于零** | 完整 | 中 |
| D. bun compile 单 exe（pi build:binary） | ~0 | 无 | 引擎闭源化 | 高 |

方案 C 的关键是：**Node 的解析语义不变**（裸 import 仍按 `node_modules/<pkg>` 找），
只是每个包的实现被换成一个大文件的 re-export 垫片 —— 不需要改 tsx/cordis 加载链路。

## 5. 推荐实施：分阶段

### P0 —— 打包布局修正（低风险，先行止血）

1. **剪掉 `.pnpm` store**：闭包已提升到顶层（2.4c 的 BFS），归档前删除 `node_modules/.pnpm`。
   预期条目 20k → ~10k。
2. **归档改 zstd**：`tar -I zstd -cf`（Windows 自带 tar 不支持则构建期附 zstd，或 Rust
   `zstd` + `tar` 写档）；解压侧 Rust 并行 unpack（rayon 预建目录树 + 并行写文件）。
3. 顺手删掉 `extract-deps.mjs` 与 Rust 解压的双轨之一，保留 Rust `setup_progress` 单链路。

预期收益：解压时间降一个数量级；改动集中在 `bundle-release.mjs` 与 `setup_progress.rs`。

### P1 —— 依赖 vendor 化（pi 式核心，目标形态）

1. **构建期 esbuild 打 vendor**：以依赖闭包每个包的公开入口为 entry（含 exports 子路径），
   产出 `vendor/<pkg>.mjs`（`format: cjs`，兼容 require 与 tsx）。
2. **生成解析垫片**：`node_modules/<pkg>/package.json`（指向 vendor）+ `index.js`
   re-export；exports 子路径逐入口生成对应垫片文件。
3. **白名单 external**：esbuild 二进制、wasm、`.node` 原生模块等不可 bundle 的保持真实目录；
   对齐 pi 的 `validateExternalImports`，新增 `scripts/check-vendor-closure.mjs`：
   扫描 harness/@cos + plugins/@diver 源码全部裸 import，逐一确认能解析到垫片或白名单，
   构建失败兜底（吸收现有 `sourceImportNames` 扫描逻辑）。
4. **归档范围收窄**：垫片 + vendor 是构建产物（只读），可直接随包（NSIS 复制几百个大文件
   很快）或进一个 zstd 小档；`archives()` 里的解压步骤趋近消失，`.deps-extracted` marker
   改为内容 hash（升级安装时精准失效）。
5. **`install-deps.mjs` 语义不变**：用户装的真实包落同级 `node_modules`，真实目录优先于
   垫片，与垫片共存。

预期收益：随包小文件 2 万 → 数百（下降 ~99%）；首启 extract 阶段从数十秒 → <1s 或归零。

### P2 —— 可选终极（仅在 P1 不达标时评估）

- 对齐 pi `build:binary`：`bun build --compile` 把引擎 + vendor 编译成单可执行文件，
  插件源码仍外置加载。影响面大（启动链路重写、tsx 替换），单独立项。

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| CJS/ESM interop（双包危害、`require` 混用） | 垫片统一 `format: cjs`；每包固定单一入口格式 |
| exports 子路径漏垫片（如 `yaml/browser`） | `check-vendor-closure.mjs` 构建期逐一校验 |
| 动态 require / 运行时拼接路径 | vendor 打包时保留 `createRequire` shim（对齐 pi banner）；冒烟覆盖 |
| 原生/wasm 模块 | 白名单真实目录，不进 vendor |
| 用户手改插件后 import 新依赖 | 文档写明「真实包优先于垫片」；install-deps 兜底 |
| 升级安装残留旧 vendor | marker 改内容 hash，tar/vendor 比 hash 新则重建 |

## 7. 验收标准

- 基线锚点：当前 extract 阶段 ≈8.5s（热缓存 NVMe 下限，见 §1）。
- P0 目标：解压耗时 ≤3s（同机同口径）；随包条目数减半（剪 `.pnpm`）。
- P1 目标：安装包 sidecar 内 <64KB 的文件数下降 ≥90%；首启 extract 阶段 <1s 或归零。
- `cargo test --workspace`、`pnpm typecheck`、`cos-plugins/*/scripts/smoke.ts` 全绿；
  `check-vendor-closure.mjs` 通过。
- 兼容性冒烟：改插件源码重启生效；`install-deps.mjs` 能装新依赖；`plugin-doctor.mjs`
  诊断正常；会话/记忆/工作区路径不受影响。
- **开放性硬校验**（§3.1）：安装目录 `plugins/<name>/src/*.ts` 为明文 TS（抽样校验
  非打包产物）；`cordis.patch.yml` 插拔、`plugins.json` catalog 与运行时加载一致。

## 8. 待决策

1. harness 引擎（@cos/*）是否保持源码运行 —— 本方案默认**保持**（与插件一致的开放性）；
   若可放弃，则 P1 可更激进（引擎也进 vendor）。
2. P0 与 P1 是否分两个 PR —— 建议分（P0 可独立回滚，P1 需要冒烟周期）。
3. ~~是否先在现装包上实测 extract 阶段耗时基线~~ —— 已实测（§1），P0 目标定为 ≤3s。
4. **升级保留策略**（§3.1 第 5 条）：Tauri NSIS 升级默认覆盖安装目录，用户改过的
   `plugins/` 源码会被覆盖。可选：(a) 升级时对比备份用户修改并提示；(b) 用户插件
   覆盖层（`%APPDATA%\com.diver.companion\cos\plugins` 优先于安装目录加载）；
   (c) 安装器保留 `plugins/` 不覆盖。需选定后纳入实施。
