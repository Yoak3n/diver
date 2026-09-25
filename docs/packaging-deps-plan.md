# 依赖打包优化方案：消灭 node_modules 海量小文件（参考 pi）

> 状态：**P0 / P1（V 案）/ P1c（B′ 播种对账）已落地（2026-09-25）**——小文件 2 万 → 数百、
> 首启解压归零、运行时唯一插件区 = 用户工作区；P2（bun compile）仅在 P1 不达标时评估（现达标，不启动）。

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

> **为什么必须如此**：插件层是 agent 的**自修改面**——agent 自己改插件源码、经
> `restart_agent` 工具（写 `$COS_HOME/restart.requested` + 优雅退出，壳 `lifecycle.rs`
> 检测标志自动再拉起）重载生效。由此派生一条运行时保证：**单个插件运行失败不得
> 阻断核心插件未失败时的启动流程**（挂载期 loader 逐行隔离已满足；boot 后运行期
> unhandled 兜底待定，见 §8.6）。

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

**文件管理模型 B′（播种对账，唯一可改处）**（P1c 已实施，2026-09-25）：

```text
安装目录 resources\sidecar\
├── harness\                 ← 引擎源码（@cos/*）
├── plugins\companion\       ← 进程入口（paths.rs RELEASE_ENTRY，不播种）
├── plugins.seed\            ← 出厂插件镜像（明文 TS + seed-manifest.json 逐文件 hash；
│                               只作播种源，运行时不加载——载荷形态选明文镜像而非
│                               plugins.seed.tar.zst：播种=复制零解压、doctor 可直接 diff）
├── node_modules\            ← 构建期 vendor（@cos/@diver 映射 + cordis/yaml/第三方闭包 + tsx/esbuild）
└── （node.exe 不随包，维持现状）

用户区 %APPDATA%\com.diver.companion\cos\
├── node_modules\            ← junction → sidecar\node_modules（解析链基座，seed 建）
└── plugins\                 ← ★ 唯一明文插件区（agent 与用户只面对这里）
    ├── <自带插件>\src\*.ts   播种而来，随便改
    ├── my-plugin\           自写插件，官方永不插手
    ├── node_modules\        用户后装真实包 + @diver\<slug> → ..\<slug>（库导入=用户副本）
    ├── .incoming\<ver>\     升级冲突时的官方新版（提示合并，合并后删除）
    └── .seed-state.json     已应用基线（升级判「是否改过」的依据）
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

### P1 —— 依赖 vendor 化（V 案，已实施 2026-09-25；取代原 P1a/P1b 计划）

> **用户拍板「V：只打第三方」**。原 P1a「cos 核心 bundle」**废弃**：入口
> `companion-bundle.ts` 是插件源码（须保持可写），相对导入
> `harness/packages/boot/src/index.ts`——打包引擎会破坏该相对导入或产生双实例；
> V 案引擎保持源码加载（README 开放承诺不动），单 exe 留 P2。

as-built（`scripts/build-core-bundle.mjs`）：

1. **扫描**随包源码（`harness/packages/*`、`packages/dsh/*`、`plugins/*` 的
   `src/**` 与根 `*.ts`）全部裸导入（含子路径），扫描器沉淀
   `scripts/lib/source-imports.mjs`（闭包自检共用）。
2. **分类**：workspace 源码（`@cos/*` / `@diver/*` / `@deepseek-ai/dsh-*`）→ **映射**；
   其余 npm → **vendor**；tsx/esbuild → **白名单**物理目录。typescript 不随包：
   tsx 运行时唯一依赖是 esbuild，无人 import tsc（省 21MB / 121 文件）。
3. **映射包**：`node_modules/<pkg>` 生成 package.json exports（精确到子路径）+
   `.shim/*.mjs` `export * from '<相对源码路径>'`（default 行按探测面补）——
   引擎/插件仍明文源码可读写，解析经 node_modules 共享根。
4. **vendor 包**：`node --import tsx` 探测 export 面 → 显式命名解构 re-export 包装
   入口（规避 CJS default-only 塌缩；奇名/保留字走别名导出）→ esbuild
   `bundle + format: esm + splitting`（共享 chunk 保单实例）+ `createRequire` banner
   （CJS-in-ESM `require('process')` 问题）。exports 精确寻址（含
   `@modelcontextprotocol/sdk/client/stdio.js` 类子路径）。
5. **白名单**：tsx + esbuild + `@esbuild/*` 平台二进制（从 `.pnpm` store 解引用复制，
   与宿主同版本，防宿主/二进制版本失配）。
6. **三重校验**：① 构建期 export 面 probe-vs-产物 import 实测 ② 构建后
   `check-plugin-closure.mjs` 按 Node 解析逐文件核销全部裸导入 + 打包不变量
   （无 `*.tar*`、无嵌套 node_modules、tsx loader 在位）③ 真实启动冒烟 boot →
   `DIVER_READY`（全部插件就绪、backend 监听）。

启动契约变更：tsx loader `harness/node_modules/tsx/...` → `node_modules/tsx/...`
（共享解析根在 sidecar 根，`command.rs` 同步）。P0 的 Rust 解压链保留但 P1 后
无归档可解（**首启解压归零**）；P1c 播种对账复用该链路。
`install-deps.mjs`：内置 `@cos`/`@diver`/`@deepseek-ai/dsh-*`/`file:` 无需安装，
用户后装落 `plugins/node_modules`（解析优先级：插件本地 → plugins → 内置根）。

### P1c —— 播种对账工作区（B′，取代原「用户插件覆盖层」决策）✅ 已落地（2026-09-25）

> 实施形态两处偏离早先草案，均已在实施中定案：
> 1. **载荷 = `plugins.seed/` 明文镜像 + `seed-manifest.json`**（非 tar.zst）：播种=复制
>    零解压（延续 P1「解压归零」）、doctor 直接 diff 官方原版；代价是安装目录多一份
>    明文镜像（命名即语义：只作播种源）。
> 2. **对账在 boot 前置步骤跑**（`@cos/boot` `seed.ts`，`seedVersion` 相同零开销跳过）；
>    纯逻辑单测 node --test 20 用例；Rust 壳只改 `--plugin-root` 一行（指 `cos_home/plugins`）。

1. 运行时唯一插件目录 = 用户区 `cos/plugins/`；安装目录侧 `plugins.seed/` 只作播种源
   （进程入口 `plugins/companion/` 留安装目录，不播种）。
2. 首启播种；升级对账：未改静默更新、改过的保留 + `.incoming/<ver>/` 并存新版提示、
   自写不动。出厂 manifest 记录各文件内容 hash（规范化换行）判定「是否改过」。
3. `plugin-doctor.mjs` 增补：改动状态报告（对比出厂基线）、`.incoming` 合并提示。
4. **解析链**（实施中发现并修复）：用户工作区脱离安装树后 Node walk-up 不再命中
   sidecar/node_modules —— seed 建两级 junction 补齐：`cos/node_modules → sidecar/node_modules`
   （引擎/vendor 基座）+ `plugins/node_modules/@diver/<slug> → plugins/<slug>`（库导入
   走用户副本，与挂载一致）。闭包自检改为**用户工作区模拟 + 落点 ⊆ sidecar 零容忍**：
   旧检查锚定仓库源码，walk-up 借道开发机根 node_modules 会假绿（真机必断，P1c 冒烟
   暴露于用户区布局）。

实测（组装产物冒烟）：全新工作区首启播种 9 + DIVER_READY 全插件装载（零 import failed）；
二次启动版本标记相同零对账；升级轮 8 静默更新 + 1 改过保留入 `.incoming/<ver>/memory`
（用户版继续装载），doctor 报改动状态与合并提示。

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
- **P1 实测（2026-09-25，V 案）**：随包依赖 **13,173 文件 → 132 文件**（−99%），
  `node_modules/` 14.2MB（vendor 打包 ~0.9MB / 4 个大文件 + tsx 0.5MB +
  `@esbuild/win32-x64` 11.2MB）；sidecar 全树 422 文件 / 36.3MB；**首启解压归零**
  （文件即最终形态，无 tar/归档）。三项 P1 目标全部达标：小文件数下降远超 ≥90%、
  `harness/node_modules` 不随包（核心层 = 0）、extract 归零。140 处裸导入闭包自检
  全绿；冒烟 boot → `DIVER_READY`（memory / web-tools / basic-tools / self-prompt /
  native-bridge 全部就绪，backend 监听）。
- `cargo test --workspace`、`pnpm typecheck`、`cos-plugins/*/scripts/smoke.ts` 全绿；
  `check-plugin-closure.mjs`（Node 解析逐文件核销）通过。
- 兼容性冒烟：改插件源码重启生效；`install-deps.mjs` 能装新依赖；`plugin-doctor.mjs`
  诊断正常；会话/记忆/工作区路径不受影响。
- **开放性硬校验**（§3.1）：用户区 `plugins/<name>/src/*.ts` 为明文 TS（抽样校验
  非打包产物）；`cordis.patch.yml` 插拔、`plugins.json` catalog 与运行时加载一致。
- **唯一可改处 + 对账生效**（§3.2 B′）：agent/用户只面对 `cos/plugins/` 一处；升级后
  未改插件已更新、改过的保留且 `.incoming` 可见官方新版、自写插件不动。

## 8. 待决策

1. ~~harness 引擎是否保持源码运行~~ —— **已改判（2026-09-25，V 案）**：P1 引擎
   **保持源码加载**（原「核心 bundle」方案因入口相对导入约束废弃，见 §5 P1）；
   单 exe 仍留 P2 评估。
2. P0 与 P1 是否分两个 PR —— 建议分（P0 可独立回滚，P1 需要冒烟周期）。
3. ~~是否先在现装包上实测 extract 阶段耗时基线~~ —— 已实测（§1），P0 目标定为 ≤3s。
4. ~~升级保留策略~~ —— **已拍板：B′ 播种对账工作区**（§3.2 / §5 P1c），取代早先
   「用户插件覆盖层」决策（遮蔽语义废弃）；依赖归属同拍板：自带依赖 vendor+垫片、
   用户后装落 `plugins/node_modules`。
5. **pi 对照结论（2026-09-25）**：采纳「host-provided 清单映射」「manifest 纪律
   （peerDep `*` + 禁物理拷贝 + 校验）」两条；「每插件独立 module root」**不采纳**——
   用户后装依赖维持共享 `plugins/node_modules`（保留插件本地 `node_modules` 优先的
   覆盖能力）。
6. ~~boot 后运行期 unhandled 兜底~~ —— **已拍板并落地（2026-09-25）**：分级兜底
   （`harness/packages/boot/src/error-guard.ts`，boot 收尾统一安装）：
   - **非核心插件**（核心清单之外的 @diver/*）：记日志 + 滑窗熔断——60s 内 5 次
     未捕获错误即停用该插件 fiber（重启恢复；持久禁用在 cordis.patch.yml 设
     `disabled: true`），进程存活、不阻断核心；
   - **核心面**（引擎 @cos/*、核心插件、无法归属）：立即 panic（FATAL 日志 +
     退出码 1，fail-loud 交壳侧报障，禁止半残僵尸态）。
   核心插件清单 `DEFAULT_CORE_PLUGINS` = `@diver/backend`（UI 通道）+
   `@diver/native-bridge`（共享 RPC 库），`BootOptions.corePlugins` 可覆盖。
   归属判定（纯函数，含单测）：沿错误栈（含 `cause`，根因优先）取第一个「有主」帧
   ——`plugins/<name>/` 归该插件、`harness/` 归引擎、`node_modules`/`node:` 跳过、
   未知按核心处理。实测（组装产物冒烟）：非核心 7 连拒 → 5 条隔离日志 + 熔断且
   fiber 已停用、后续错误吞掉、进程存活 30s；核心面伪造 harness 栈 → FATAL +
   退出码 1。挂载期隔离（`plugin-loader` 的 `create().catch`）与本守卫互补：
   前者管装载，后者管运行期。
7. **P1 V 案拍板（2026-09-25，用户选定「V：只打第三方」）**：第三方闭包 vendor 化
   （esbuild `splitting` 共享 chunk 保单实例 + exports 精确寻址）；`@cos`/`@diver`/
   `@deepseek-ai/dsh-*` 映射垫片指回源码（可读写承诺不变）。spike 验证过的坑已固化
   进构建器：CJS named-export 塌缩（显式解构导出）、无 default 包的 conditional default、
   CJS-in-ESM `require` banner、每包 `package.json type:module`、`@esbuild/*` 须与
   宿主同版本解引用落位、扫描器须剥注释且 from 从句与左侧长度解耦。
