# 对照：Diver × deepseek-harness × deepseek-harness-desktop

> 目的：在深水区实现前，把 Diver 现状与上游两套体系**逐项对齐**，区分
> 「已对齐」「有意差异」「债务/待借」。实现验收以 [plugins.md](plugins.md) 的 DoD
> 为准，本表解释**为什么这样分期**、**该抄什么、不该抄什么**。
>
> 上游：
> - [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（下称 **DSH**）— agent harness 本体，「Everything is a Plugin」
> - [deepseek-harness-desktop](https://github.com/dsh-tauri/deepseek-harness-desktop)（下称 **Desktop**）— Tauri 壳，把 DSH 当核心运行时
>
> 调研基线：DSH `docs/architecture.zh.md`、`packages/boot/plugin-manager/README.zh.md`、
> `packages/boot/app-boot`、Desktop `src-tauri/src/service/{plugin,profile,core}` 与
> `docs/DEVELOPMENT.zh.md` / README「工作原理」。

---

## 1. 产品定位

| | DSH | Desktop | Diver |
|---|---|---|---|
| 形态 | 开源 agent harness（Node） | Tauri 2 桌面壳 + 预打包 DSH | Tauri 2 陪伴 agent + **自研 cos** |
| 与上游关系 | 本体 | 下载/管理 DSH 发行版（`deepseek-harness-pkg`）或本机 CLI `dsh` | **只取框架理念**；`@cos/*` 自研，兼容 `dsh.*` manifest 与 cordis ABI |
| UI | 官方 Web UI（`dsh web`，端口 3080） | 内嵌 DSH Web + 自研侧栏/面板 | **自研 Vue 陪伴 UI**（不用 DSH 交互层） |
| 插件来源 | registry / git / profile 安装；社区 `dsh-plugin` | 预设市场 + 随包 internal 插件 + 用户安装 | 仓库内 `@diver/*`（internal）；第三方安装 **未做（P4）** |
| 核心运行时 | 源码 / npm `@deepseek-ai/dsh` | 随包 Node 22 + 预打包 dsh **或** 本机 CLI | **磁盘 harness 源码**（tsx）+ 首启解析/下载 Node（**不随包**）；**无 SEA** |

```text
DSH:        插件树 = 产品本体
Desktop:    壳 ≠ 大脑；大脑 = 可替换的 dsh 发行版
Diver:      壳 ≠ 大脑；大脑 = monorepo 内自研 cos（理念对齐 DSH，实现不 fork 上游）
```

**结论：** Diver 更接近 Desktop 的「壳 + 常驻 Node 大脑」拓扑，而不是「把 UI 插进 DSH」。
插件生命周期应对齐 **DSH 语义** + **Desktop 壳编排**，不必变成 DSH 的发行版管理器。

---

## 2. 概念映射

| 概念 | DSH | Desktop | Diver（现状） |
|---|---|---|---|
| 数据家园 | `$DSH_HOME`（默认 `~/.dsh`） | 同左；dev 用 `~/.dsh.dev` 隔离 | `$COS_HOME`：dev `harness/.cos-home`；release `%APPDATA%/com.diver.companion/cos` |
| 档案 / profile | `$DSH_HOME/profiles/<id>`；模板 `web/headless/sdk/acp/...` | `active_profile`（默认引导 `tauri`，避开保留名 `desktop`）；`safe` 安全档案 | 固定 `companion`；`safe` **规划中（P3）**；`active_profile` 未持久化 |
| 组合包 bundle | `dsh.bundle.patch` → `cordis.patch.yml`（+ 可选 `bundle.yml` requires） | 同左；桌面端校核核心层必须含 `dsh-base`（+ web 层） | `@diver/bundle-companion`：目录式 `cordis.patch.yml` + `bundle.yml` requires |
| 用户补丁 | profile `cordis.patch.yml` → home patch → `--patch` | 同左；另有壳管理的 `disabled-plugins.json` | profile patch = **壳写启停**；home patch 基本未用 |
| 插件包 | npm 依赖 + 可选 `dsh.bundle` | internal（随包）/ preset / 用户装 | `@diver/*` 目录包；catalog 标 `kind: internal` |
| 引擎核心 | `@deepseek-ai/dsh-*` / `dsh-base` 等 | 预打包 `dependencies/dsh` 或本机 CLI | `@cos/*` 磁盘源码（`pluginPaths`） |
| 禁用 | patch 行 `disabled: true` 或从 `dsh.profile.bundles` 移除 | **双机制**：`disabled-plugins.json` + patch disable | profile patch `disabled: true` + boot 过滤 insert |
| 卸载 | `dsh plugin remove` / plugin-manager | pnpm remove + 校验 + recovery | **未实现（P4）**；internal 设计为不可卸 |
| 配置预览 | `dsh --profile <p> --dump-config` | 未对等暴露 | **无**（可借：boot 前 dump 组合树，P3/P4 排障） |

---

## 3. 进程与运行时拓扑

| | DSH | Desktop | Diver |
|---|---|---|---|
| 进程 | `dsh <profile>` 单进程（Web/Headless/SDK 由 profile 选） | Tauri + `dsh --profile <id> --host --port` + 内嵌 WebView | Tauri + `companion.ts` / `companion-bundle.ts` + Vue |
| Node | 本机 Node | **随包 runtime**（22.22.0）优先对齐核心 ABI；local CLI 可选 | **不随包**：首启解析本机 Node ≥ 22 / 缓存 / 下载（`node_runtime`）+ tsx；dev 用系统 node |
| 就绪信号 | launcher / 端口 | 端口 + 健康检查 | stdout `DIVER_READY` + `/api/health` |
| 退出 | 进程管理 | workflow 服务管理 dsh 生命周期 | shutdown token → kill → Job Object |
| 端口 | `dsh web` 默认 3080 | dev 3081 / prod 3080 | `DIVER_PORT` 默认 53620；Vite 1420 |
| 打包形态 | npm / 源码 | 安装器下载 core（非把一切烘焙进一个 exe） | NSIS + 开放源码 + **不随包 Node**（首启解析/下载）；**明确弃 SEA** |

```text
Desktop:  Tauri ──spawn──► dsh（外部发行版）──HTTP──► 内嵌页面
Diver:    Tauri ──spawn──► cos（仓内 harness）──HTTP/SSE──► 自研 Vue
共同点:   壳只管理生命周期与插件状态文件；大脑可独立重启
```

---

## 4. 组合与 Boot 层序

| 层（先→后） | DSH / cos（文档语义） | Diver 实现注意 |
|---|---|---|
| 1 | base `cordis.yml` / 安装级配置 | `harness/cordis.yml` 或随包 sidecar 目录 `cordis.yml` |
| 2 | overlays（`COS_OVERLAYS` / `--overlays`） | 同左（mock 等） |
| 3 | profile 的 `dsh.profile.bundles`（有序） | companion profile **bundles 默认空**；组合包经 **CLI `--bundles` 显式传入** |
| 4 | CLI `--bundles` | `bundle-companion` 路径 |
| 5 | profile `cordis.patch.yml` | **启停真相**（壳写 disabled） |
| 6 | home patch | `$COS_HOME/cordis.patch.yml`（profile 模式）或 `~/.cos/...` |
| 7 | `--patch` / extraPatches | 备用 |

**与 DSH 的关键差：** DSH 档案通常**自带** bundles 列表；Diver 把 companion 组合包放在 CLI 参数里，
profile 只承担「用户/壳补丁」。这样 dev/release 参数化简单，但 **profile 不是自包含档案**——
复制 profile 目录不能单独启动完整陪伴组合。

| 选项 | 说明 | 建议 |
|---|---|---|
| A. 保持现状 | bundles 走 CLI，profile 只放 disable | P0–P2 可接受 |
| B. 对齐 DSH | `package.json` 的 `dsh.profile.bundles` 写入 companion bundle（路径或包名） | **P4 前建议切到 B**，否则「安装第三方 bundle」与「档案可移植」会分叉 |

**Boot 与 include 的特殊点（Diver 独有修复）：**

DSH 文档称 insert 行会被后续层 patch；Diver 使用的 `@cordisjs/plugin-include` 在**同一批**
patches 里 **entryMap 只含 base**，insert 出来的 id 吃不到 `disabled`。因此 `@cos/boot`
先按 disabled 集合过滤 insert。对齐 Desktop 时不要假设「只改 patch 文件就够」——
必须保留或回归这条 boot 行为（见 plugins.md §2.5）。

---

## 5. 插件生命周期操作对照

| 操作 | DSH plugin-manager | Desktop `service/plugin` | Diver 现状 | 差距 / 深水区 |
|---|---|---|---|---|
| **列表** | Loader 现状 + profile manifest + bundle 插件行 | `dependencies` ∪ `dsh.profile.bundles` + preset/internal 清单 + disabled | bundle insert ∪ plugins 目录 + `plugins.json` + profile disabled | 未区分 profile 安装 vs internal；无「已加载失败」态 |
| **inspect** | `pnpm view` / 读包声明（是否 bundle） | 部分在 install 编排内 | 无 | P4 |
| **安装** | `dsh plugin add` / `installBundle`（pnpm + reconcile bundles） | 编排 `dsh plugin` + 日志流 + 失败回滚 | 无（手工放目录 + 改 bundle/catalog） | P4 |
| **启用** | patch 去 disable **或** 追加 bundles 列表 | `disabled-plugins.json` 移除 + strip patch disable | profile patch 移除 disabled + restart | 语义已对齐；缺 strip 用户手写 patch 的精细合并 |
| **禁用** | patch `disabled`（保留依赖）或从 bundles 移除 | 独立禁用清单 + patch disable（**保留 node_modules**） | profile `disabled: true`（boot 过滤 insert；包体保留） | 已对齐「禁用≠卸载」 |
| **卸载** | bundles 移除 → 运行时贡献卸载 → `pnpm remove`；失败可部分残留 | remove + `is_installed` 核验 + recovery 离线卸 | 无 | P4；internal 拒绝卸载 |
| **升级** | plugin-manager / pnpm update；桌面有 update 服务 | 有 | 无 | P4 低优先级 |
| **取消安装** | `cancelInstall(requestId)` | Windows cancel | 无 | P4 可选 |
| **安全模式** | 无桌面概念 | `safe` profile：只留核心 + 内置；用户插件清除 | 无 | **P3** |
| **补丁隔离** | 失败行为文档化 | `patch_guard` quarantine；`patch_entries` 清理悬空 insert | 无 | **P3** 强烈建议抄 |
| **自愈** | 依赖 pnpm 状态 | internal 插件缺失时强制重装/junction；native ABI 探测 | 无 | P3 preflight；Diver 无 node-gyp，可跳过 ABI |
| **文件监控** | HMR 监听 manifest/patch | `watch` 轮询指纹 + `dsh-plugins-updated` | 无（重启才生效） | 远期 |
| **Agent 工具管理** | `plugin_manager` 工具（需审批） | 注明 Desktop 包管理仍归壳 | **明确不做** | 有意差异 |
| **热重载** | YAML HMR 可配置启用 | 多依赖重启/重载策略 | **重启 sidecar** | 有意差异（陪伴场景可接受） |

---

## 6. 插件分类策略

| 类别 | DSH | Desktop | Diver 目标态 |
|---|---|---|---|
| 引擎核心 | `dsh-base` 等 bundle 行，不作为「用户插件」卸载 | 预打包 core；核心层自愈补 bundles | `@cos/*`：`pluginPaths`，**不可卸、不进用户插件市场** |
| 随包内置 | （由部署方决定） | `resources/internal-plugins.json`；internal 不进引导勾选、强制自愈 | `@diver/*` + `plugins.json` `kind: internal`：可禁、**不可卸** |
| 预设/推荐 | 社区包 + market | `preset-plugins.json` 首次引导勾选 | 暂无市场；P4 后可有「推荐包」清单 |
| 用户安装 | profile `node_modules` | profile 依赖 | P4：profile 安装；与 internal 目录隔离策略需定 |
| 弃用包 | 社区治理 | `deprecated-plugins.json` 启动自动卸载 | P4 可借清单机制 |

**Diver 注意：** Desktop 的 internal 插件在**安装包 resources**，不在用户可写 profile 的
`node_modules` 主路径；Diver dev/release 把 internal 放在**开放** `plugins/` / `cos-plugins/`
——更利于改源码，但用户误删时需要 P3 preflight/catalog `present=false` 可见（已有雏形）。

---

## 7. 类型与包拓扑

| | DSH | Desktop | Diver 现状 → P1 目标 |
|---|---|---|---|
| monorepo | pnpm workspace + tsconfig **project references** + constraints | 应用仓库；插件多为外部包；内置插件可构建 bundle | harness workspace + 根 `file:` 链接 cos-plugins |
| 类型消费 | 包 `dependencies`/`peer` + `main/types` 指向 **lib 产物** | 内置插件构建后进安装包 | 插件 tsconfig **paths/include 穿透 harness 源码** → 改为依赖 `@cos/types`（或等价） |
| cordis ABI | `@deepseek-ai/cordis` alias 同版本 | 随 DSH 发行版 | `cordis@4.0.0-rc.7` + `@deepseek-ai/cordis` alias（已对齐意图） |
| 运行时解析 | Node 从 profile/安装树解析 | 核心安装目录为解析根；内置插件 junction 进核心 `node_modules` | `pluginPaths` 核心 + `pluginRoot` 插件；**类型解析仍第三轨** |
| 包角色命名 | 强约束（Controller/Store/Registry…）+ README 门禁 | 产品向命名 | 未强制；P1 不必抄全套 naming 纪律，但 **types 包边界**建议抄 |

**结论：** Diver 运行时契约已接近 Desktop；**最大缺口在 TypeScript 工程化**，对应 P1。
不必引入 DSH 全套 README/constraints 门禁，但「类型面可依赖、插件不 include 引擎源码」
是深水区硬前提。

---

## 8. 失败恢复与安全

| 能力 | DSH | Desktop | Diver |
|---|---|---|---|
| boot fail-loud | required 服务缺失拆卸退出 | 前端错误页 + 日志 | `boot(required: [...])` 已有 |
| 配置预览 | `--dump-config` | 弱 | 无 → 建议 P3 |
| 坏 patch | 文档化失败行为 | quarantine / strip 悬空 insert | 无 → **P3 抄 Desktop** |
| 坏插件 | 启用失败可保留已装、允许停用 | recovery 一键卸载；safe profile | 仅重启后不加载（若 boot 过滤生效） |
| 安全档案 | 无专用 | `safe`：核心 + 内置，无用户插件 | P3 |
| 首装隔离 | 多 profile | 首装新建引导 profile，防 CLI 旧数据涌入 | COS_HOME 与安装目录已隔离；无「旧 profile 迁移」故事 |
| 原生依赖 | Node 生态问题 | ABI 探测 + 重建（sharp/fs-ext） | **不适用**（无 node-gyp） |

---

## 9. 对齐度总表

图例：✅ 已对齐 · 🟡 部分/简化 · ⬜ 未做 · 🚫 有意不做

| 维度 | vs DSH 语义 | vs Desktop 编排 | 说明 |
|---|---|---|---|
| Cordis 插件模型 name/inject/apply | ✅ | ✅ | 同构 |
| profile 目录 + patch 层 | 🟡 | 🟡 | bundles 不在 profile manifest（CLI 传入） |
| bundle `dsh.bundle` / requires | ✅ | ✅ | companion 有 requires |
| 禁用 ≠ 卸载 | ✅ | ✅ | profile disabled + boot 过滤 |
| 壳端 list/enable/disable | 🟡（有 Web 管理器） | ✅ 最小闭环 | 设置页开关 + restart |
| install/uninstall/inspect | ✅ 上游有 | ✅ 有完整服务 | Diver ⬜ → P4 |
| internal 插件策略 | 🟡 | ✅ 对齐概念 | 无强制自愈/不可卸代码路径 |
| safe profile / 恢复 | 🚫（非桌面） | ✅ | Diver ⬜ → P3 |
| 核心多版本 / 发行版下载 | N/A（本体） | ✅ | Diver **不需要**（core 在 monorepo） |
| 磁盘插件 + 首启解析 Node | N/A | ✅ 同构 | Diver ✅（**不随包** node.exe） |
| SEA 烘焙 | N/A | 不用 SEA 思路 | Diver 🚫 已弃 |
| 类型可独立依赖 | ✅ 上游包工程 | 🟡 | Diver ⬜ → P1 |
| dump-config 预览 | ✅ | 弱 | Diver ⬜ 建议 |
| patch quarantine | 失败可文档化 | ✅ | Diver ⬜ → P3 |
| Agent 管理插件 | ✅ 可选工具 | 壳负责包管理 | Diver 🚫 陪伴场景 |
| HMR 热载配置 | ✅ 可配 | 部分 | Diver 🚫 以重启为准 |
| 模型可见能力全在 TS 插件 | ✅ | UI/壳插件也走 DSH 插件 | Diver ✅；Rust 经 RPC+bridge |

---

## 10. 有意差异（不要「对齐过头」）

| 差异 | 理由 | 保持条件 |
|---|---|---|
| **不用官方 DSH Web UI** | 产品是陪伴单会话，不是通用 Agent IDE | backend 传输仍自研 |
| **cos 自研而非 vendored dsh** | 已投入 harness 工作区与 companion 插件；避免上游破坏性迭代直接打穿产品 | manifest 保持 `dsh`/`cos` 双命名空间兼容 |
| **不做 core 多版本下载** | 栈内引擎与应用同仓发布 | 除非未来 cos 独立发版 |
| **不做 Agent `plugin_manager` 工具** | 工具面可写 profile，陪伴场景风险高 | 设置页即可 |
| **禁用走 profile patch 而非独立 JSON** | 与 DSH/loader 单一真相；boot 可过滤 insert | Desktop 双清单是因为要兼容 CLI 写 patch；Diver 无第二写入方时更简单 |
| **internal 可改源码（开放目录）** | 开发与高级用户定制 | P3 preflight 必须补上，否则开放变成脆弱 |
| **重启生效而非 HMR** | 降低插件管理状态机复杂度 | 远期再评估 |

---

## 11. 债务清单（按 P 期「该抄什么」）

### P1 — 类型与包边界（抄 DSH 工程化，不抄全套门禁）

- [ ] 类型/服务声明包：插件 `dependencies` 可引用（对齐 DSH `main/types` 产物思路，diver 可先 workspace 源码 types）
- [ ] 插件 tsconfig **删除** `include: ../../harness/packages/**`
- [ ] 统一 cordis 依赖声明；清理 `file:..\\` 路径
- [ ] 文档化：运行时 `@cos/*` 解析根 = harness 磁盘（Desktop「核心目录是解析根」的 diver 版）

### P3 — 恢复能力（主要抄 Desktop）

- [ ] `safe` profile：核心 + 最小传输，无用户/易碎插件
- [ ] `active_profile` 壳持久化（对齐 Desktop，不用写死）
- [ ] 启动 preflight：bundle/harness/plugins 入口、catalog present
- [ ] **patch_guard / 悬空 insert 清理**（Desktop `quarantine_*` / `strip_active_unresolved_entries` 的简化版）
- [ ] 可选：`--dump-config` 或 `GET /api/plugins` 反映 loader 真相
- [ ] boot 失败时壳侧错误文案指向 safe 恢复路径

### P4 — 安装卸载（抄 DSH 不变量 + Desktop 壳编排）

- [ ] 状态在磁盘：profile `package.json` dependencies + `dsh.profile.bundles` + patch
- [ ] **建议**：companion bundle 进入 profile bundles（§4 选项 B），与 `dsh plugin` 语义一致
- [ ] install：pnpm 事务 + 失败回滚 manifest/lockfile（DSH plugin-manager）
- [ ] disable ≠ uninstall；internal 卸载 API 直接拒绝
- [ ] 卸载后 `is_installed` 核验 + 降级 recovery（Desktop）
- [ ] profile `.npmrc` 等 pnpm 无 TTY 问题（Desktop `confirmModulesPurge=false`）——**仅在真正调 pnpm 后需要**
- [ ] 日志：子进程逐行进壳（Desktop `process.rs`）
- [ ] 弃用包清单可选（Desktop `deprecated-plugins.json`）

### P5 — native / 能力位

- [ ] 不抄 DSH 把一切做成可卸市场插件；native 走 **internal bridge**
- [ ] 对齐 Desktop「internal 与壳通信插件」角色（`dsh-tauri` 系列 = Diver `native-bridge`）

### 明确不抄

- Electron Desktop Host、签名公证流水线细节（除发布需要）
- DSH 全套 package README Model Experience 门禁
- core 版本槽 `dependencies/dsh-<tag>` 互换
- Web 插件市场完整实现（P4 后若有社区需求再评估）

---

## 12. 一页对照图

```text
                    ┌─────────────────────────────────────┐
                    │  语义层（抄 DSH）                     │
                    │  profile · bundle · cordis patch     │
                    │  name/inject/apply · disable 行      │
                    │  dsh.profile / dsh.bundle 声明       │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │  壳编排层（抄 Desktop）                │
                    │  list / toggle / (P4 install)        │
                    │  safe profile · preflight · recovery │
                    │  首启解析 Node · 开放插件目录 · 日志流  │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │  Diver 产品层（不抄交互）              │
                    │  Vue 陪伴 UI · Live2D · 单会话        │
                    │  @cos 自研引擎 · Rust RPC 记忆/grep   │
                    │  无 Agent 插件管理 · 重启生效          │
                    └─────────────────────────────────────┘
```

---

## 12b. `@diver/native-bridge` × Desktop `dsh-tauri*` 插件族

> Desktop 的「壳桥」不是单个插件，而是一族 **internal 插件**（`packages/dsh-tauri*`），
> 其中 `dsh-tauri` 是基础设施包，`dsh-tauri-connection` 负责沙箱 WebView 到回环宿主的鉴权通道；
> 其余（model-config / panel-* / pet / session / worktree / ui…）是产品能力插件。
> Diver 的 `@diver/native-bridge` 只对标其中「壳 ↔ 大脑」的**原生能力通道**这一层。

### 12b.1 角色定位

| | Desktop `dsh-tauri*` | Diver `@diver/native-bridge` |
|---|---|---|
| 形态 | **插件族 / 平台套件**（host + client + 十余个产品插件） | **单个 internal 插件** + 领域插件复用其客户端 |
| 在产品中的位置 | 官方 DSH Web UI 跑在 Desktop 壳里，插件扩展「桌面宿主能力」 | 自研 Vue UI 不经 dsh Web；bridge 服务 **agent 工具面** |
| 主数据方向 | **WebView UI ↔ dsh host**（h3 routes / host service）↔ 必要时 Tauri | **Rust `/rpc` ← TS 插件**（模型可见工具） |
| 是否进模型工具面 | 多数能力是 UI/会话/面板/桌宠，**不是** agent 工具 | `native_status` 等 **就是** `ctx.tools` |
| 发布形态 | 独立 npm 包 + `dsh.bundle` + 构建产物 `dist/` | 仓内 `cos-plugins/` 源码 + pluginRoot 直载 |

```text
Desktop:
  DSH Web UI (内嵌) ──invoke/HTTP──► dsh-tauri host (h3 routes + defineService)
       │                                    │
       └── dsh-tauri-connection ────────────┤ 鉴权 / 回环
                                            ▼
                                      Rust Tauri commands

Diver:
  Vue UI ──HTTP/SSE──► @diver/backend ──► cos agent
  Vue UI ──invoke──► Rust (TTS/窗口/插件管理)     ← 不经 native-bridge
  Agent 工具 ──nativeRpc──► Rust /rpc            ← native-bridge 收口
```

### 12b.2 能力面拆解

| Desktop 插件 | 职责摘要 | Diver 对应物 |
|---|---|---|
| **dsh-tauri** | 宿主桥基建：`defineService`、h3 **routes**、storage、`getCurrentHostInstance` 隔离、host/client 双端导出 | **无对等平台包**；壳能力分散在 Tauri `invoke` + `/rpc` |
| **dsh-tauri-connection** | 注入 `connection` 服务：跨源/沙箱 WebView 访问回环宿主的两道鉴权闸门 | 无；UI 与 sidecar 同机 loopback + shutdown token（进程级，非每请求） |
| **dsh-tauri-model-config** | 接管模型设置页（上下文/输出上限等） | 自研设置页 + `@diver/backend` provider 声明 |
| **dsh-tauri-panel-\*** | 侧栏面板：MCP/Skills 市场、定时任务等 | 设置页「MCP 服务」「插件」；无 dsh 侧栏 |
| **dsh-tauri-pet / session / worktree / ui / …** | 桌宠、归档会话、Git worktree、自定义设置栏 | Live2D 桌宠（自研 Vue）；无 worktree 产品化 |
| **（agent 原生能力）** | Desktop 不把「记忆/搜索」做成 dsh-tauri 工具包，而在 dsh 生态/其它插件 | `native-bridge` + `@diver/memory` / `basic-tools` **专为 agent 工具面** |

### 12b.3 协议与工程约束

| 维度 | Desktop `dsh-tauri` host service 协议 | Diver `native-bridge` |
|---|---|---|
| 服务声明 | 强制 `defineService({ … })`，一文件一导出，导出名 = 文件名驼峰 | 无服务宏；`export function nativeRpc` + 常量目录 `NATIVE_RPC_METHODS` |
| 方法命名 | **动词白名单**（持久化 load/save…；长任务 start/lookup…；编排领域动词；推演 resolve/peek） | 自由命名 RPC `method` 字符串（`stats` / `grep::search`） |
| 宿主隔离 | 只有 `service/` 可 `getCurrentHostInstance()`；routes/tools 间接调用 | 无 host 实例概念；直接 `fetch` 壳 `/rpc` |
| 线协议 | 插件内 h3 路由 + 桌面 invoke；connection 鉴权 | 统一 `{ method, params }` → `{ ok, data \| error }` |
| 状态 | 允许模块级状态（长任务 Map）；服务对象本身必须全是函数 | 客户端无状态；状态在 Rust SQLite / 壳配置 |
| 鉴权 | connection 专门做 WebView 回环鉴权 | 仅 `127.0.0.1` + 进程 shutdown token；**RPC 无每方法鉴权**（可接受：本机 agent） |
| 扩展成本 | 新能力 = 新 dsh-tauri-* 包 + bundle + 宿主 service/routes 纪律 | 新能力 = Rust `/rpc` 方法 +（可选）工具 + `NATIVE_RPC_METHODS` 登记 |

### 12b.4 为什么 Diver 不做成 `dsh-tauri` 式平台包

| Desktop 需求 | Diver 现状 |
|---|---|
| 在 **DSH 官方 Web UI** 里长出桌面能力 | **不用** DSH Web UI；Vue 自研，UI 能力直接 `invoke` Rust |
| 多插件共享一套 host routes / storage / 面板协议 | 消费者少：当前主要是 memory/grep 的 RPC + 一个 status 工具 |
| 沙箱/跨源 WebView 访问宿主 | 主 UI 与 shell 同源/本机，无跨源 iframe 场景 |
| 产品插件市场向（pet/worktree/IM…） | 陪伴场景能力收敛在 companion bundle，不做通用桌面 IDE |

**结论：** `dsh-tauri*` 解决的是「**通用 DSH 桌面产品**如何安全、规范地长出宿主能力与 UI 扩展」；
`native-bridge` 解决的是「**陪伴 agent** 如何用统一通道调用壳内原生服务并暴露给模型」。
两者都在「壳桥」语义下，但**抽象层级与消费方不同**，不宜把 dsh-tauri 整包搬进 diver。

### 12b.5 值得借的点（按需，非现在必做）

| 借鉴 | 适用时机 | 落地建议 |
|---|---|---|
| **方法目录即协议** | RPC 方法 > ~10 个 | 保持/扩展 `NATIVE_RPC_METHODS`；status/UI 只读目录渲染 |
| **服务层纪律**（单一导出、动词一致、禁止 manager/helper） | `native-bridge` 内服务/工具膨胀 | 若拆 `service/`，采用 Desktop 式「领域名词 + 白名单动词」，不要 `xxxManager` |
| **host 实例隔离** | 多插件抢 ctx/宿主 | Diver 用 cordis `inject` 即可；无需 getCurrentHostInstance |
| **connection 级鉴权** | RPC 离开 loopback 或多用户 | 现阶段不必；若远程/多会话再加 token per method |
| **host + client 双端包** | 需在 WebView 内嵌 cos 页面并复用桥类型 | 保持 UI 直连 Tauri/backend；仅在真嵌 dsh-like 面板时再评估 |
| **产品插件族拆分** | pet/MCP/日程等都要「桌面宿主能力」 | UI 能力继续 Tauri command；**不要**为了对齐 Desktop 把它们塞进 native-bridge |

### 12b.6 演进红线

1. **native-bridge 不做 UI 桥** — 桌宠/窗口/TTS/插件管理保持 Tauri `invoke`。
2. **领域插件不重新长出第二套 RPC 客户端** — 一律 `nativeRpc`。
3. **不把 Desktop 的 dist/构建链（tsdown bundle）搬进 cos-plugins** — diver 保持 tsx 源码直载（internal）。
4. **safe 模式**：`native-bridge` 为 internal，可 disable；禁用只影响 `native_status` 与未来 bridge 工具，memory/grep 因直接依赖其 **rpc 模块**，禁用插件行不会卸掉文件，但若未来把工具全部迁入 bridge 再 disable，需在 catalog advisory 标明。

---

## 12c. Desktop「全局事件 / 壳 ↔ dsh 核心事件桥」是什么

> 调研基线：`packages/dsh-tauri/src/client/{types/bridge.ts,service/listen.ts}`、
> `src/hooks/use-{iframe-message,invoke-iframe,listen-iframe}.ts`、
> `packages/dsh-tauri-pet/src/host/{routes/session/stream/get.ts,service/session-stream.ts}`、
> `src-tauri/src/bridge/pet.rs`、`docs/specs/plugin.host.md`。

### 12c.1 三层通道（作者口语里的「事件桥」）

```text
┌─ ① dsh 核心 → 插件（进程内 cordis） ─────────────────────────┐
│  ctx.on('session/event' | 'agent/status' |                    │
│         'agent/assistant-stream' | …)                         │
│  dsh-tauri-pet/session-stream：有 SSE 消费者才挂载，投影成帧   │
└──────────────────────────┬────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────────┐
          ▼                                    ▼
┌─ ② 壳 UI ↔ iframe 内 dsh ──────┐  ┌─ ③ dsh host → Rust → 桌宠窗 ─┐
│ iframe 无 __TAURI_INTERNALS__   │  │ HTTP SSE                      │
│ invoke 桥：                      │  │ /api/desktop/dsh-tauri-pet/   │
│  dsh://tauri:invoke (白名单)     │  │   session-stream              │
│  → 宿主 invoke → reply           │  │ Rust consume → emit           │
│ 事件桥：                         │  │   pet://status / session:*    │
│  Tauri event → postMessage       │  │ → pet WebView                 │
│  client listen('dsh://tauri:event')│ └───────────────────────────────┘
└──────────────────────────────────┘
```

| 层 | 载体 | 解决什么 |
|---|---|---|
| ① 核心事件 | cordis `ctx.on` | 插件在 **agent 大脑进程内**订阅会话/流式/状态 |
| ② 壳 UI 桥 | iframe `postMessage` + **invoke 命令白名单** + origin 校验 | dsh GUI 跑在 **iframe** 里，不能直接 Tauri；壳把事件/命令「借」进去 |
| ③ 外置窗口桥 | host 插件 **HTTP SSE** → Rust → Tauri event | 桌宠是**另一个 WebView**，消费 dsh 会话投影 |

关键点：

1. **「全局」≠ 一条跨进程 event bus**，而是 **cordis 事件面 + 安全面 iframe 协议 + SSE 投影**。
2. ② 的存在前提是 **官方 DSH Web UI 嵌在 Desktop iframe 里**（跨源/沙箱）。
3. ③ 与 ① 的坑：核心 0.1.6 后 **活体流式不在 `session/event` 的 `assistant/chunk`**，而在
   `agent/assistant-stream`；session-stream 必须同时订这两条，否则桌宠气泡只剩兜底文案。
4. 消费模型：**没有消费者就不订核心事件**（最后一个 SSE 断开即 closeSessionBus）。

### 12c.2 Diver 现状对照

| Desktop 通道 | Diver 对应 | 差距 |
|---|---|---|
| ① `ctx.on(session/event, agent/*)` | **已有**：`@diver/backend` 监听并 SSE 给 Vue；memory 监听 turn/compaction | 同构；需注意 cos 流式事件是否与 DSH 0.1.6 同形（diver 自研 loop，事件面在 `@cos/types`） |
| ② iframe invoke/事件桥 | **不需要**：Vue 不是 dsh iframe；Tauri `invoke` 在顶层 WebView 直接可用 | 若未来嵌入不可信面板再引入 + 白名单 |
| ③ 外置桌宠消费会话 | Live2D 桌宠经 **同一 backend SSE**（`usePetChat`），与主窗口共会话 | 无独立 SSE 服务；**尚未**做「桌宠专用投影帧」（Desktop pet 有 reducer/气泡状态机） |
| 壳侧 Tauri 事件 | `sidecar://status`、`backend://ready`、`device-mouse-move` | 有事件，**无**「dsh 事件 → 壳事件」的通用转发器 |

```text
Diver 数据流（已有）:
  cos agent ──session/event + agent/*──► @diver/backend ──SSE──► Vue / 桌宠
  Rust 壳  ──Tauri event──► Vue（sidecar 状态、鼠标流）
  无 iframe 桥；无「壳事件 → dsh 核心」反向全局总线
```

### 12c.3 结论

- 作者说的「打通壳和 dsh 核心」在 Desktop 上成立，但拆开是：**① 进程内 cordis 事件**
  \+ **② 为 iframe 准备的 Tauri 借道协议** \+ **③ 会话事件的 SSE 投影到 Rust/外置窗**。
- Diver **已经具备 ① 与大部分 ③**（backend SSE；桌宠共用），**不需要 ②**。
- 若产品要做「桌宠气泡/状态更贴近 Desktop」，该抄的是 **③ 的投影层**
  （`session-stream` reducer、按消费者惰性订阅、`agent/assistant-stream` 活体帧），
  而不是整套 iframe 事件桥。
- 若要「壳与 agent 统一事件目录」，可维护 **事件清单文档**（名称、方向、载荷），
  把现有 `sidecar://status` / SSE 帧类型与未来 `pet://*` 登记在同一张表——对齐 Desktop
  的可发现性，而不引入 postMessage 协议。

### 12c.4 若借鉴 ③：最小设计（未实施）

| 步骤 | 内容 |
|---|---|
| 1 | 在 `@diver/backend`（或独立 `@diver/pet-projection`）订阅 `session/event` + 活体流事件 |
| 2 | reducer → 紧凑帧 `{ action, payload }`（create/update/remove 或 liveActivity） |
| 3 | 桌宠侧只消费投影帧；主聊天仍走完整 SSE |
| 4 | 无桌宠消费者时可不跑投影（对齐「无消费者无监听」） |

---

## 13. 与 plugins.md 的关系

| 文档 | 角色 |
|---|---|
| [plugins.md](plugins.md) | **实现契约与 DoD**（改代码看这份） |
| 本文 | **上游对照与取舍依据**（定方案、写 RFC、评审时看这份） |

分期仍以 plugins.md §5 为准；本文 §11 是各期「借鉴 checklist」。
若上游行为与本文描述冲突，以当时上游文档/源码为准，并回写本表。

---

## 14. 变更记录

| 日期 | 内容 |
|---|---|
| （初稿） | 基于 DSH architecture / plugin-manager / app-boot 与 Desktop service/plugin·profile·core 及 README 工作原理完成三方对照 |
| （续） | §12b：`@diver/native-bridge` 与 Desktop `dsh-tauri*` 插件族对照（角色/协议/取舍/演进红线） |
| （续） | §12c：Desktop「全局事件桥」三层拆解（cordis / iframe postMessage / SSE→Rust）与 Diver 对照 |
