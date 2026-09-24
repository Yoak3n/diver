# 依赖打包优化方案：消灭 node_modules 海量小文件（参考 pi）

> 状态：**架构已拍板（2026-09-25）**——B′ 播种对账工作区 + cos 核心 P1 bundle +
> 依赖三层归属；待实施（P0 → P1a → P1b → P1c）。

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
| 插件开放 | `plugins/@diver/*` 以 **TS 源码**随包，README.txt 承诺可改/删/增 | 插件本体不能 bundle 死（硬约束 §3.1） |
| 核心打包 | `@cos/*` 引擎**已拍板 P1 bundle**（运行时不再源码加载） | 核心零 node_modules；`@cos/plugin-api` 需对外垫片 |
| TS 运行时 | tsx 只负责加载**插件** TS 源码 | tsx/esbuild 二进制作白名单组件，不进 bundle |
| 用户可装依赖 | `install-deps.mjs` 为插件追加真实依赖 | 插件层 node_modules 语义必须保留 |

结论（2026-09-25 拍板）：**打包对象 = cos 核心本体 + 全部第三方依赖闭包；插件源码永远
不进 bundle**。cos 核心像 pi 一样打进少数大文件（P2 可单 exe），核心零 node_modules；
插件层保持明文 TS，自带插件的第三方依赖 vendor 化成「大文件 + 解析垫片」，用户后装依赖
走标准 node_modules（完整分层见 §3.2）。

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

| 阶段 | 对插件源码（明文 TS）的影响 | 对插件依赖的影响 |
|------|------------------------------|-------------------------------|
| P0 | **零影响**（源码不进归档） | 剪 `.pnpm` / zstd，布局语义不变 |
| P1 | **零影响**（`@diver/*` 不进核心 bundle / vendor） | 自带依赖变 vendor+垫片；用户后装真实包优先于垫片 |
| P2 | **插件源码仍外置加载**（核心单 exe 也不含插件） | 同 P1 |

任何实施若触碰第 1–4 条，视为方案失败，回退该步。

### 3.2 产物分层与文件管理模型（2026-09-25 拍板）

**依赖三层归属**（回答「cos 自身还有 node_modules 吗」——没有）：

| 层 | 产物形态 | node_modules |
|---|---|---|
| cos 核心（`@cos/*` + 全部第三方依赖） | esbuild bundle 少数大文件（P2 可单 exe） | **零**；白名单仅 tsx loader + esbuild 二进制 |
| 自带插件的依赖 | host-provided 共享库 → 加载器映射进核心 bundle（不落盘）；核心未提供的私有依赖 → `plugins/vendor/*.mjs` + 解析垫片 | vendor+垫片数百文件，随 seed 播种 |
| 用户后装依赖（`install-deps`） | 真实 npm 包 | 共享 `plugins/node_modules`（插件本地 `node_modules` 优先；独立 module root 经评估不采纳） |

**接口不变量（对照 pi 修订）**：插件源码 `import ... from '@cos/plugin-api'` 语义不变 ——
像 pi 的 jiti alias / `VIRTUAL_MODULES` 一样，**host-provided 清单**（`@cos/plugin-api` +
yaml/zod/cosmokit 等核心已有实例的共享库）由加载器**映射进核心 bundle 内部副本**，
保证单实例；host 包禁止物理安装（`peerDependencies: "*"` 纪律 + 校验，见 §5 P1b）。

**文件管理模型 B′（播种对账，唯一可改处）**：

```text
安装目录 resources\sidecar\
├── core\                    ← cos 核心 bundle + loader 白名单（无 node_modules）
├── plugins.seed.tar.zst     ← 自带插件源码 + vendor + 垫片（更新载荷，非明文目录）
└── （node.exe 不随包，维持现状）

用户区 %APPDATA%\com.diver.companion\cos\
└── plugins\                 ← ★ 唯一明文插件区（agent 与用户只面对这里）
    ├── <自带插件>\src\*.ts   播种而来，随便改
    ├── my-plugin\           自写插件，官方永不插手
    ├── vendor\              自带依赖 bundle（seed 解出）
    └── node_modules\        垫片 + 用户后装真实包
```

- **首启**：seed 解开播种到用户区；**升级**：新 seed 对账 —— 未改的插件静默更新，
  改过的保留用户版 + 官方新版落 `<name>\.incoming\<ver>\` 提示差异，自写插件不动
  （dpkg conffiles 语义）。
- **agent 只面对用户区一处**：工具文档 / systemPrompt 只写 `cos/plugins/` 这一路径，
  `install-deps.mjs` / `plugin-doctor.mjs` 同样只认这一处 —— 从设计上消掉「改错目录」。

## 4. 方案对比

| 方案 | 小文件数 | 首启解压 | 插件可读写 | 风险 |
|------|---------|---------|--------|------|
| A. 现状（pnpm + deref + 未压缩 tar） | ~20,000 | 数十秒 | ✓ | — |
| B. 仅剪 `.pnpm` + zstd + 并行解压（P0 过渡） | ~10,000 | 数秒 | ✓ | 低 |
| C. **核心 bundle + 插件 vendor 垫片 + 播种对账（B′，推荐）** | 数百 | **趋近于零** | ✓ | 中 |
| D. 再进一步 bun compile 单 exe（P2 可选） | ~0 | 无 | ✓（插件仍外置） | 高 |

方案 C 的关键是：**Node 的解析语义不变**（裸 import 仍按 `node_modules/<pkg>` 找），
只是每个包的实现被换成大文件 re-export 垫片；核心 bundle 对插件暴露 `@cos/plugin-api`
入口 —— tsx/cordis 插件加载链路不动。

## 5. 推荐实施：分阶段

### P0 —— 打包布局修正（低风险，**过渡期止血**：P1a 落地后 harness 侧自动失效）✅ 已落地 `f62621d`

1. **剪掉 `.pnpm` store**：闭包已提升到顶层（2.4c 的 BFS），归档前删除 `node_modules/.pnpm`。
   预期条目 20k → ~10k。
2. **归档改 zstd**：`tar -I zstd -cf`（Windows 自带 tar 不支持则构建期附 zstd，或 Rust
   `zstd` + `tar` 写档）；解压侧 Rust 并行 unpack（rayon 预建目录树 + 并行写文件）。
3. 顺手删掉 `extract-deps.mjs` 与 Rust 解压的双轨之一，保留 Rust `setup_progress` 单链路。

预期收益：解压时间降一个数量级；改动集中在 `bundle-release.mjs` 与 `setup_progress.rs`。

### P1a —— cos 核心 bundle（大头收益：harness/node_modules 整体消失）

1. esbuild 把 `@cos/*` 引擎 + 全部第三方依赖打成 `core/` 少数大文件（对齐 pi
   `build-coding-agent-bundle.mjs`：`bundle: true`、minify、banner `createRequire` shim）。
2. **零 node_modules**：白名单仅 tsx loader + esbuild 二进制（等价 pi 外挂的 jiti）。
3. 对外暴露 `@cos/plugin-api` 入口 + seed 内垫片，插件 import 语义不变。
4. `harness/node_modules.tar`（15,050 条目 / 100MB）从安装包中消失；启动链路从
   「tsx 跑 harness 源码」改为「加载 core bundle」，tsx 只用于插件 TS 源码。

### P1b —— 插件依赖分桶：host-provided 映射 + 私有依赖 vendor 化（对照 pi 修订）

1. **host-provided 清单**（对齐 pi 的 jiti alias / `VIRTUAL_MODULES` 模式）：核心 bundle
   已有实例的共享库（`@cos/plugin-api` 及 yaml/zod/cosmokit 等，清单化）由加载器
   **映射进核心 bundle 内部副本**，插件 import 语义不变且单实例 —— 禁止垫片物理拷贝
   这些包（pi 明确教训：物理拷贝绕过映射 → duplicate classes/registries）。
2. **私有依赖 vendor 化**：仅对核心未提供的依赖，构建期以每包公开入口为 entry（含
   exports 子路径）产出 `plugins/vendor/<pkg>.mjs`（`format: cjs`，兼容 require 与 tsx）
   + `node_modules/<pkg>/` 解析垫片（package.json + index.js re-export）。
3. **manifest 纪律**（对齐 pi packages.md）：host-provided 包只准进
   `peerDependencies: "*"`，禁进 `dependencies`；`scripts/check-vendor-closure.mjs`
   校验全部裸 import 可解析，并检出 host 包物理拷贝即报错（吸收现有 `sourceImportNames`
   扫描逻辑）。
4. 白名单 external（esbuild 二进制、wasm、`.node`）保持真实文件。
5. `install-deps.mjs` 语义不变：用户后装真实包落共享 `plugins/node_modules`，真实目录
   优先于垫片。

### P1c —— 播种对账工作区（B′，取代原「用户插件覆盖层」决策）

1. 运行时唯一插件目录 = 用户区 `cos/plugins/`；安装目录侧只保留 `plugins.seed.tar.zst`
   更新载荷（不再展开明文目录，消除「两份明文」困惑）。
2. 首启播种；升级对账：未改静默更新、改过的保留 + `.incoming/<ver>/` 并存新版提示、
   自写不动。出厂 manifest 记录各文件内容 hash（规范化换行）判定「是否改过」。
3. `plugin-doctor.mjs` 增补：导出官方原版做 diff、提示 `.incoming` 可合并。

预期收益：随包小文件 2 万 → 数百（下降 ~99%）；harness/node_modules 整体消失；
首启 extract 阶段从数十秒 → <1s 或归零。

### P2 —— 可选终极（P1 达标后单独立项）

- 对齐 pi `build:binary`：`bun build --compile` 把**核心 bundle**编译成单可执行文件，
  插件源码仍外置加载、seed 播种不变。影响面大（Node 解析、tsx 替换），仅在 P1 不达标时评估。

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| CJS/ESM interop（双包危害、`require` 混用） | 垫片统一 `format: cjs`；每包固定单一入口格式 |
| exports 子路径漏垫片（如 `yaml/browser`） | `check-vendor-closure.mjs` 构建期逐一校验 |
| 动态 require / 运行时拼接路径 | vendor 打包时保留 `createRequire` shim（对齐 pi banner）；冒烟覆盖 |
| 原生/wasm 模块 | 白名单真实目录，不进 vendor |
| 用户手改插件后 import 新依赖 | 文档写明「真实包优先于垫片」；install-deps 兜底 |
| 升级安装残留旧 vendor | marker 改内容 hash，tar/vendor 比 hash 新则重建 |
| 核心 bundle 破坏 cordis 动态加载 / 插件发现 | bundle 显式保留 cordis 插件 API 面；启动冒烟覆盖插件装载 |
| host 包被物理拷贝 → 双实例 / 重复注册（pi 明确教训） | host-provided 清单加载器映射 + manifest 纪律 + `check-vendor-closure.mjs` 报错 |
| host-provided 映射与核心版本漂移 | 清单由核心构建同源生成；校验脚本核对映射目标存在且同源 |
| 对账误判「已修改」（换行 / 编码差异） | manifest 用规范化内容 hash；doctor 可重置基线 |

## 7. 验收标准

- 基线锚点：当前 extract 阶段 ≈8.5s（热缓存 NVMe 下限，见 §1）。
- **P0 实测（2026-09-25，`f62621d`，同机 release 口径）**：归档 123.8MB → 9.7MB（−92%）；
  条目 20,281 → 13,173（harness 15,050 → 7,968；plugins 侧不变，待 P1b）；解压 8.5s →
  串行 4.0s / 首启并发路径 **3.6s**（−58%）。≤3s 未达：瓶颈已到 Windows 小文件创建
  饱和（~3.5k 文件/秒，加线程无收益），归零手段在 P1（文件数 13k → 数百）。
- P1 目标：安装包 sidecar 内 <64KB 的文件数下降 ≥90%；**核心层 node_modules = 0**；
  首启 extract 阶段 <1s 或归零。
- `cargo test --workspace`、`pnpm typecheck`、`cos-plugins/*/scripts/smoke.ts` 全绿；
  `check-vendor-closure.mjs` 通过。
- 兼容性冒烟：改插件源码重启生效；`install-deps.mjs` 能装新依赖；`plugin-doctor.mjs`
  诊断正常；会话/记忆/工作区路径不受影响。
- **开放性硬校验**（§3.1）：用户区 `plugins/<name>/src/*.ts` 为明文 TS（抽样校验
  非打包产物）；`cordis.patch.yml` 插拔、`plugins.json` catalog 与运行时加载一致。
- **唯一可改处 + 对账生效**（§3.2 B′）：agent/用户只面对 `cos/plugins/` 一处；升级后
  未改插件已更新、改过的保留且 `.incoming` 可见官方新版、自写插件不动。

## 8. 待决策

1. ~~harness 引擎是否保持源码运行~~ —— **已拍板：P1 核心 bundle**（运行时不再源码加载，
   仓库源码照旧可读；单 exe 留 P2 评估）。
2. P0 与 P1 是否分两个 PR —— 建议分（P0 可独立回滚，P1 需要冒烟周期）。
3. ~~是否先在现装包上实测 extract 阶段耗时基线~~ —— 已实测（§1），P0 目标定为 ≤3s。
4. ~~升级保留策略~~ —— **已拍板：B′ 播种对账工作区**（§3.2 / §5 P1c），取代早先
   「用户插件覆盖层」决策（遮蔽语义废弃）；依赖归属同拍板：自带依赖 vendor+垫片、
   用户后装落 `plugins/node_modules`。
5. **pi 对照结论（2026-09-25）**：采纳「host-provided 清单映射」「manifest 纪律
   （peerDep `*` + 禁物理拷贝 + 校验）」两条；「每插件独立 module root」**不采纳**——
   用户后装依赖维持共享 `plugins/node_modules`（保留插件本地 `node_modules` 优先的
   覆盖能力）。
