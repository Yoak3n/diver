# 插件体系与生命周期

> 本文是 Diver 插件架构的**权威契约**：运行时如何组合、启停状态落在哪、壳与 cos 如何分工、
> 深水区（类型边界 / 安全档案 / 安装卸载 / native 插件）按什么分期推进。
>
> 相关：[架构](architecture.md) · [Sidecar](sidecar.md) · [开发](development.md) ·
> [分发](distribution.md) · harness 侧 [plugins.md](../harness/docs/plugins.md) ·
> **[对照 deepseek-harness / harness-desktop](plugins-upstream-comparison.md)**
> （含 §12b：native-bridge × dsh-tauri*）·
> **[通信通道收敛](channels.md)**（backend 事件面 vs `/rpc`）

---

## 1. 目标与非目标

### 目标

| 能力 | 含义 |
|---|---|
| **可插拔** | 陪伴场景能力（记忆、工具、MCP、模型适配器、传输层）以插件行挂载，不改 harness 核心源码 |
| **可启停** | 用户/壳可禁用单个插件；禁用 ≠ 卸载，包体保留，启用无需重装 |
| **可装卸（分期）** | 第三方插件经 profile 安装/卸载；内部插件不可卸、仅可禁用 |
| **壳不持有插件知识以外的编译期耦合** | Rust 不 import `@diver/*`；只读清单、写 profile 补丁、重启 sidecar |
| **单一 loader 契约** | dev / release 同一套 `pluginPaths` + `pluginRoot` + `profile` 语义 |

### 非目标（明确不做）

- **SEA / 把插件烘焙进二进制**：与「开放插件目录、可启停、可改源码」冲突；release 已是随包 Node + 磁盘插件。
- **Rust 注册 cordis 服务行**：模型可见能力一律 TS 插件注册；Rust 只提供 RPC/原生服务，经 bridge 插件接入。
- **陪伴场景的 Agent 自助装卸插件**：危险面过大；管理 UI 在壳设置页。
- **热替换 JS 模块（完整 HMR 插件管理器）**：P0–P2 以「写补丁 + 重启 sidecar」为准；HMR 列为远期。

---

## 2. 运行时契约（Loader Composition）

### 2.1 三层组合

```text
base cordis.yml          @cos/* 核心服务行（引擎，不可由用户卸载）
        ↓
bundle-companion         @diver/* insert 行（陪伴组合层，mount 真相）
        ↓
profile patch            $COS_HOME/profiles/companion/cordis.patch.yml
                         壳写入的 disabled 覆盖 / 未来用户层
        ↓
home / extra patch       外层程序最终覆盖（一般保持为空）
```

### 2.2 模块解析（唯一契约）

| 符号 | 解析方式 | 用途 |
|---|---|---|
| `@cos/<pkg>` | `pluginPaths` → `<harness>/packages/<pkg>/src/index.ts` | 引擎核心，随安装包/仓库分发 |
| `@diver/<name>` | `pluginRoot` → `<pluginsRoot>/<name>/package.json` 的 `main` | 开放插件目录 |
| bundle 层 | `--bundles` / `BootOptions.bundles` → 目录（读 `cordis.patch.yml` + `bundle.yml`） | 组合声明 |
| 启停覆盖 | `--profile companion` → `$COS_HOME/profiles/companion/cordis.patch.yml` | 生命周期状态 |

**禁止**再引入第三套解析：例如在 `companion.ts` 里手写 `@diver/*` 路径表。  
共享实现见 `cos-plugins/companion/src/companion-boot.ts`。

### 2.3 启动命令

**dev（debug 构建）** — 由 `src-tauri/src/core/sidecar/` 拉起：

```text
node --import tsx --expose-internals
  <repo>/cos-plugins/companion/src/companion.ts
  --profile companion
  --plugin-root <repo>/cos-plugins
  --bundles   <repo>/cos-plugins/bundle-companion
  --harness   <repo>/harness
cwd     = <repo>/harness
COS_HOME= <repo>/harness/.cos-home
```

**release（随包 Node，非 SEA）**：

```text
resources/sidecar/node.exe --import file:///.../node_modules/tsx/dist/loader.mjs
  --expose-internals resources/sidecar/plugins/companion/src/companion-bundle.ts
  --profile companion
  --plugin-root resources/sidecar/plugins
  --bundles    resources/sidecar/bundles/bundle-companion
  --harness    resources/sidecar/harness
cwd     = resources/sidecar
COS_HOME= %APPDATA%/com.diver.companion/cos
```

布局对照：

| 路径 | dev | release |
|---|---|---|
| harness | `harness/` | `resources/sidecar/harness/` |
| plugins | `cos-plugins/` | `resources/sidecar/plugins/` |
| bundle | `cos-plugins/bundle-companion/` | `resources/sidecar/bundles/bundle-companion/` |
| profile | `$COS_HOME/profiles/companion/` | 同左（COS_HOME 不同） |
| catalog | `cos-plugins/bundle-companion/plugins.json` | 同结构拷贝到 plugins 布局 |

### 2.4 插件契约（与 DSH 同形）

**注册语法已对齐 deepseek-harness（DSH）插件生态**——cos 原生写法就是 DSH 写法：

```ts
import type { Context } from 'cordis'
import type {} from '@cos/plugin-api'
import { defineTool } from '@cos/plugin-api' // 或 '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'my-tool'
export const inject = ['tools', 'systemPrompt']

/** 可选：设置页表单（Desktop model-config 风格） */
export const configDecl = {
  title: '我的工具',
  fields: [
    { key: 'greeting', label: '问候语', type: 'text' as const, default: 'hello' },
    { key: 'verbose', label: '详细日志', type: 'boolean' as const, default: false },
  ],
}

/** 可选：schemastery Config — cordis 在 apply 前校验/填默认值 */
export const Config = z.object({
  greeting: z.string().default('hello'),
  verbose: z.boolean(),
})

export function apply(ctx: Context, config: { greeting: string; verbose: boolean }) {
  ctx.tools.register(defineTool({
    name: 'hello',
    description: 'Say hello',
    parameters: { who: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      return `${config.greeting}, ${(args as { who: string }).who}`
    },
  }))
  ctx.systemPrompt.section({ name: 'my:hello', order: 100, text: '…' })
}
```

- 命名导出 `name` / `inject` / `apply`，无 default export（cordis/DSH 同）。
- **工具注册**：`ctx.tools.register(defineTool({...}))` 为规范形；三参数
  `register(name, executor, options)` 仍可用（旧插件零迁移）。
- **插件配置校验**：可选 `export const Config = z.object({...})`。字段可选为省略 /
  `.default()`，必选用 `.required()`（非 zod 的 `.optional()`）。
- **设置页可编辑配置**：`export const configDecl`（`PluginConfigField`：
  `key/label/type/secret/required/default/description/options`）。设置 → 插件会出现
  表单；保存写入 profile `cordis.patch.yml` 的 `config` 覆盖并 `requestRestart`，
  `apply(ctx, config)` 生效。API：`GET/POST /api/plugins/config`。
  示例：`@diver/basic-tools`。
- 相对导入带 `.ts` 扩展名（Node ESM + tsx）。
- 组合包（bundle）用 `package.json` 的 `dsh.bundle.patch` 或目录式 `cordis.patch.yml` + `bundle.yml`。

**DSH 包名兼容层保留：** `@deepseek-ai/dsh-tools` / `dsh-llm` / `dsh-agent` /
`dsh-session` / `dsh-system-prompt` / `dsh-scope` / `schemastery` 仍可 import（shim 到 `@cos/*`），
社区插件无需改 import。详见 [harness/docs/plugins.md](../harness/docs/plugins.md)。
示例：`examples/dsh-compat-example`。

### 2.5 disable 为何要在 boot 过滤 insert

`@cordisjs/plugin-include` 的 `applyPatches` 在**同一批** patch 里：

1. 用 **base 树** 建立 `entryMap`；
2. bundle 的 `insert` 行 `data.push(...)`，**不会**写入 `entryMap`；
3. 后续 `{ id, disabled: true }` 对 insert 出来的 id 查不到 → **禁用静默失效**。

因此 `@cos/boot` 在把 patches 交给 include 之前：

- 从 profile/user/home/extra/overlay 收集 `disabled: true` 的 id 集合；
- 从 bundle/overlay 的 `insert` 数组中**剔除**这些 id；
- 保留 override 层本身（对 base 行的 config 覆盖仍有效）。

修改 boot 时必须保持该语义，并补冒烟（禁用 → 无插件日志；启用 → 日志恢复）。

---

## 3. Profile 与启停语义

### 3.1 术语对齐 DSH / harness-desktop

| 概念 | Diver 落点 | 对齐 |
|---|---|---|
| cos home | `COS_HOME`（dev: `harness/.cos-home`；release: app data `cos/`） | `$DSH_HOME` |
| profile | `$COS_HOME/profiles/companion/` | `$DSH_HOME/profiles/<id>` |
| 用户补丁层 | `profiles/companion/cordis.patch.yml` | profile `cordis.patch.yml` |
| 内部插件 | `cos-plugins/*` / 安装包 `plugins/*`，catalog 标 `kind: internal` | Desktop internal plugins |
| 禁用 | profile patch 中 `{ id, name, disabled: true }` | DSH plugin-manager disable |
| 卸载（分期） | 移出 bundle/依赖 + 删除包目录；internal **不可卸** | `dsh plugin remove` / Desktop uninstall |

### 3.2 启停数据格式

壳写入 / 读取的 profile 补丁（shell-managed，**不要手改后指望与壳 UI 长期共存**）：

```yaml
# Diver shell-managed profile patch (enable/disable plugin rows).
- id: self-prompt
  name: '@diver/self-prompt'
  disabled: true
- id: memory
  name: '@diver/memory'
  disabled: true
```

全部启用时：

```yaml
# Diver shell-managed profile patch (enable/disable plugin rows).
[]
```

规则：

- **禁用**：为该 id 追加/保留 `disabled: true` 覆盖。
- **启用**：从 shell 管理集合中移除该 id；无其他覆盖时写回 `[]`。
- **匹配键**：cordis 行 `id`（与 bundle insert 的 `id` 一致），可选附带 `name` 做一致性校验。
- **生效**：写盘后由壳 `restart_sidecar`；不依赖 HMR。
- **文件编码**：UTF-8 **无 BOM**（PowerShell `Set-Content -Encoding utf8` 可能带 BOM，优先用 Node/编辑器写入）。

### 3.3 展示元数据 `plugins.json`

路径：`cos-plugins/bundle-companion/plugins.json`（随 bundle 分发）。

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "id": "memory",
      "packageName": "@diver/memory",
      "displayName": "关系层记忆",
      "description": "…",
      "toggleable": true,
      "defaultEnabled": true,
      "advisory": "可选警告文案"
    }
  ]
}
```

- **mount 真相**仍是 bundle `cordis.patch.yml` 的 insert 行。
- catalog 只服务壳 UI（显示名、描述、是否可关、advisory）。
- 新增内部插件时：**两处都要改**（bundle insert + catalog）。后续可由 `GET /api/plugins` 用 loader 现状消歧，P2 允许双清单。

### 3.4 状态机（壳视角）

```text
                    list_plugins
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   present=false    enabled=true    enabled=false
   （包体缺失）      （已挂载）       （profile 禁用）
         │               │               │
         │          toggle off       toggle on
         │               │               │
         │               ▼               ▼
         │        写 disabled:true   移出 disabled
         │               │               │
         └───────────────┴───────┬───────┘
                                 ▼
                          restart_sidecar
                                 ▼
                          再次 list 确认
```

`enabled = present && !disabled_ids.contains(id)`  
（bundle 仍 insert 但 profile 禁用 → UI 显示关；boot 过滤后进程内确实不加载。）

---

## 4. 壳端插件管理

### 4.1 模块

`src-tauri/src/plugins/mod.rs`

| API | 说明 |
|---|---|
| `plugin_paths(app)` | 解析 bundle / pluginsRoot / profileDir（dev/release 分支） |
| `ensure_profile(app)` | 创建 profile 目录 + 空 patch + 可选 `package.json` |
| `list_plugins(app)` | 扫描 bundle insert ∪ plugins 目录，合并 catalog 与 disabled |
| `set_plugin_enabled` | 只写 profile 补丁 |
| `toggle_plugin` | 写补丁 + `SidecarManager::restart` |
| `plugin_paths_json` | 诊断路径 |

Tauri command（`commands/` 注册）：

| invoke | 参数 | 返回 |
|---|---|---|
| `list_plugins` | — | `PluginInfo[]` |
| `set_plugin_enabled` | `id`, `enabled` | `PluginInfo[]` |
| `toggle_plugin` | `id`, `enabled` | `PluginInfo[]` |
| `get_plugin_paths` | — | 布局 JSON |

前端封装：`src/tauri.ts`；UI：设置 → **插件**（`src/components/settings/PluginsTab.vue`）。

### 4.2 职责切分

```text
Vue 设置页
   │ invoke
   ▼
Rust plugins 模块 ──读──► plugins.json / bundle cordis.patch.yml / plugins/*/package.json
   │写
   ▼
$COS_HOME/profiles/companion/cordis.patch.yml
   │
   ▼ restart_sidecar
Node companion.ts / companion-bundle.ts
   │ @cos/boot 过滤 insert + 应用 patch
   ▼
cordis loader 只挂载 enabled 插件
```

| 问题 | 归属 |
|---|---|
| 某插件源码怎么写 | `cos-plugins/<name>/` |
| 某插件是否 mount | bundle `cordis.patch.yml` |
| 某插件是否启用 | profile `cordis.patch.yml`（壳管理） |
| 某插件显示名 | `plugins.json` |
| 进程是否加载成功 | sidecar 日志 / 未来 `/api/plugins` |
| 核心服务是否在场 | boot `required: [...]` fail-loud |

### 4.3 与 Rust 原生能力（点 5）

| 层 | 内容 |
|---|---|
| Rust | `services/` HTTP RPC：memory SQLite、grep（`diver-search`）… |
| TS bridge | 现为分散在 `@diver/memory` / `@diver/basic-tools`；**P5 收敛**为 `@diver/native-bridge`（internal） |
| 约定 | 新增原生能力：先 RPC，再 bridge 工具/服务注册，catalog `defaultEnabled: true`，**不**在 Rust 里挂 cordis 行 |

---

## 5. 深水区分期

依赖顺序：**运行时收敛 → 类型边界 → 启停产品化 → 恢复能力 → 安装卸载 → native 收口**。

> 各期**该抄 DSH 还是 Desktop、哪些明确不抄**，见
> [plugins-upstream-comparison.md](plugins-upstream-comparison.md) §11。

| 期 | 主题 | 交付物 | 验收（DoD） |
|---|---|---|---|
| **P0** ✅ | 运行时收敛 | `companion-boot.ts`；dev/release 同契约；废 SEA 叙事；boot disable 过滤 | 禁用 self-prompt 后 boot 无 `[self-prompt]`；启用后恢复；cargo/tsc 通过 |
| **P2** ✅ | 壳端启停 | `plugins/mod.rs` + commands + PluginsTab + catalog | `toggle_plugin` 写 profile 并重启；设置页可列出 internal 插件 |
| **P1** ✅ | 类型边界 | `@cos/plugin-api` 聚合类型 + cordis Context；插件 tsconfig **只 include src**（无 harness 全量）；`pnpm typecheck` 分层 | `cd cos-plugins/memory && tsc --noEmit` 通过；`pnpm typecheck`（harness+plugins）通过；boot 仍正常 |
| **P3** ✅ | Profile 自愈 + safe | `active_profile` 壳持久化；`safe` 档案（核心+backend）；preflight；坏补丁 quarantine；失败自动降级 safe | `--profile safe` boot 仅 backend + DIVER_READY；companion 回归正常；设置页可切换档案 |
| **P4** ✅ | 安装 / 卸载 | profile `pnpm add/remove`；`diver-plugins.json` 登记；bundle 走 `dsh.profile.bundles`；plain 走 boot insert；internal 拒绝卸载；失败回滚 manifest/lock | `file:examples/hello-tool` 安装后 boot 出现 `[hello-tool]`；卸载后消失；cargo/tsc 通过 |
| **P5** ✅ | native-bridge | `@diver/native-bridge`：共享 `/rpc` 客户端 + `native_status`；memory/grep 改经 bridge；bundle/catalog 挂载 | boot 出现 `[native-bridge] ready`；`pnpm typecheck` 通过 |

### P1 详细：类型 / 解析三轨的收敛

**已落地（P1 ✅）：**

| 项 | 实现 |
|---|---|
| 类型面 | `harness/packages/plugin-api`（`@cos/plugin-api`）：re-export `@cos/types` / `@cos/llm` / `@cos/tools`，并加载核心服务包以合并 cordis `Context` 的 `ctx.*` 键 |
| 插件 tsconfig | `cos-plugins/tsconfig.base.json` + 各包 `extends`；**`include` 仅 `src/**/*.ts`** |
| 路径 | `paths` 将 `@cos/plugin-api` / `cordis` 钉到 harness 源码与同一份 cordis |
| 源码 import | 插件统一 `from '@cos/plugin-api'` |
| typecheck | 根 `pnpm typecheck` = harness + plugins；单插件 `npx tsc --noEmit` |
| 其它债 | `@diver/mcp` 的 `file:` 路径已正斜杠化；workspace 补齐 mcp / llm-commandcode |

运行时：`@cos/*` 仍由 loader `pluginPaths` 挂载；插件 import `@cos/plugin-api` 经 workspace/`file:` 链接解析到 harness 源码。

**约束：** 新增框架类型时只改 `@cos/plugin-api` 的 re-export，插件 import 面保持稳定。

历史「类型三轨」中：插件 include harness 全量、harness 根 include cos-plugins —— 两项均已拆除。

### P3 详细：safe profile（已落地 ✅）

| 项 | 实现 |
|---|---|
| 档案名 | `safe`（对齐 harness-desktop，避开上游保留名） |
| 组合 | `@cos/*` 核心 + **仅** `@diver/backend`（`companion-boot.ts` `SAFE_INSERTS`；不挂 companion bundle） |
| 激活档案 | 壳 store `diver-profile.json`（`config/profile.rs`）；sidecar `--profile` 跟随 `active_profile` |
| preflight | `plugins::preflight`：harness 入口、backend 包体、bundle 补丁、catalog 缺失项 |
| 补丁隔离 | profile `cordis.patch.yml` 非法 → `cordis.patch.yml.bak-<ms>` + 重置 `[]` |
| 自动降级 | `SidecarManager::start`：companion preflight 硬失败 → 写 `safe` → 再检 → 启动 |
| UI | 设置 → 插件：显示当前档案、「进入安全模式 / 回到 companion」、preflight 问题列表 |

**恢复路径：** 安全模式下 UI 仍可连 sidecar → 插件页禁用问题行或修复目录 → 回到 companion → 重启。

**限制：** safe 下不加载 memory/mcp/self-prompt/basic-tools/commandcode（会话/记忆数据仍在磁盘）。

### P4 详细：安装事务（已落地 ✅）

| 项 | 实现 |
|---|---|
| 登记文件 | `$COS_HOME/profiles/<p>/diver-plugins.json`（id / packageName / spec / bundle） |
| 安装 | 壳 `install_profile_plugin`：`pnpm add <spec>` + 读包 `dsh.bundle`；失败回滚 `package.json`/`pnpm-lock.yaml` |
| bundle 插件 | 写入 profile `dsh.profile.bundles`，随 boot profile 层挂载 |
| plain 插件 | boot 从 `diver-plugins.json` 生成 `extraPatches.insert`（`companion-boot.ts`） |
| 卸载 | `uninstall_profile_plugin`：registry 移除 + bundles 移除 + `pnpm remove`；**internal 直接拒绝** |
| 禁用 | 仍走 profile `cordis.patch.yml` disabled（写入时**保留 insert 块**） |
| 示例 | `examples/hello-tool`（`diver-example-hello`），不在 companion bundle 内 |
| UI | 设置 → 插件：安装输入框 + profile 行「卸载」按钮 |
| pnpm | `DIVER_PNPM` 可覆盖可执行文件；CI=1 避免 TTY 确认 |

**安装路径示例：** `file:../../../../examples/hello-tool`（相对 profile 目录）或绝对 `file:E:/.../hello-tool`。

### P5 详细：native 插件位（已落地 ✅）

```text
Rust crates / services ──POST /rpc──► @diver/native-bridge（internal）
                    nativeRpc()           │ ctx.tools.native_status
                                          │ memory / grep 等领域插件复用同一客户端
                                          ▼
                                     模型可见能力
```

| 项 | 实现 |
|---|---|
| 包 | `cos-plugins/native-bridge`（`@diver/native-bridge`），internal，可禁用 |
| 客户端 | `src/rpc.ts`：`nativeRpc` / `nativeRpcUrl` / `NATIVE_RPC_METHODS` / `probeNativeRpc` |
| 工具 | `native_status`：探测 memory `stats`/`snapshot` 与 `grep::search` |
| 复用 | `@diver/memory` store-rpc、`@diver/basic-tools` grep 均 `import { nativeRpc } from '@diver/native-bridge/rpc'` |
| 挂载 | `bundle-companion` insert + `plugins.json` catalog |

**新增原生能力 checklist：**

1. Rust：`src-tauri/src/services/` 增加 `/rpc` method（稳定错误 code）
2. 在 `NATIVE_RPC_METHODS` 登记 method/service/描述
3. 工具/服务用 `nativeRpc` 注册（优先放 bridge，或独立 `@diver/native-<name>` internal）
4. bundle insert + `plugins.json`
5. `scripts/` 增加冒烟；文档补 RPC 说明（如 memory.md）

**边界：** 窗口/TTS/单实例等仍属壳 UI 能力，不进模型工具面；插件不直接持有 SQLite。

---

## 6. 已知陷阱（实现时必读）

| # | 陷阱 | 处理 |
|---|---|---|
| 1 | include 同批 insert 无法被 `disabled` 命中 | boot 过滤 insert（见 §2.5）；改 patch 引擎时回归冒烟 |
| 2 | profile patch BOM 导致 YAML 行为异常 | 统一 UTF-8 无 BOM 写入 |
| 3 | 壳 UI 与 bundle/catalog 漂移 | 新增插件 PR 检查清单：bundle insert + plugins.json +（可选）文档 |
| 4 | 双入口语义分叉 | 只改 `companion-boot.ts`；禁止在 companion.ts / companion-bundle.ts 各写一套默认值 |
| 5 | SEA 残留代码/注释 | 视为历史旁路；release 文档与 reclaim 匹配串以 `companion.ts` / `companion-bundle.ts` 为准 |
| 6 | 禁用 `backend` | UI 必须提示：界面将无法连接 agent（catalog `advisory`） |
| 7 | 会话/记忆数据 | 与插件启停无关，仍在 `$COS_HOME`；禁用记忆插件不删 SQLite |
| 8 | dev COS_HOME | 与 release 隔离（`harness/.cos-home` vs app data）；测启停时别看错目录 |

---

## 7. 扩展操作手册（摘要）

### 新增内部插件（仓库内）

1. `cos-plugins/<name>/`：`package.json`（`name: @diver/<name>`，`main: src/index.ts`）+ `src/index.ts`（`name`/`inject`/`apply`）。
2. `bundle-companion/cordis.patch.yml`：`insert` 增加 `{ id, name: '@diver/<name>' }`。
3. `bundle-companion/plugins.json`：增加 catalog 行。
4. 若有第三方依赖：随包布局跑 `install-deps.mjs`；dev 依赖 workspace/`file:` 链接策略见 development。
5. 重启 sidecar；设置 → 插件 应出现新行。

### 禁用 / 启用（用户）

设置 → 插件 → 开关；或手动编辑 profile patch 后重启 sidecar。

### 独立调试 boot

见 [development.md](development.md)；命令必须带 `--profile companion` 与 `--plugin-root` / `--bundles`，与壳一致。

---

## 8. 文件索引

| 路径 | 角色 |
|---|---|
| `cos-plugins/companion/src/companion-boot.ts` | 统一 boot 契约 |
| `cos-plugins/companion/src/companion.ts` | dev 入口 |
| `cos-plugins/companion/src/companion-bundle.ts` | release 入口（随包 Node） |
| `harness/packages/boot/src/index.ts` | 组合、disable insert 过滤、profile 层 |
| `harness/packages/plugin-api/src/index.ts` | 第三方插件类型面（P1） |
| `harness/packages/profile/src/*` | profile 目录/manifest/初始化 |
| `cos-plugins/tsconfig.base.json` | 插件共享 tsconfig（P1） |
| `cos-plugins/bundle-companion/cordis.patch.yml` | mount 真相 |
| `cos-plugins/bundle-companion/plugins.json` | UI catalog |
| `cos-plugins/bundle-companion/bundle.yml` | `requires` 校验 |
| `cos-plugins/native-bridge/src/rpc.ts` | 原生 `/rpc` 共享客户端（P5） |
| `cos-plugins/self-prompt/` | 自改提示词入口（prompts/*.md 热加载 + revise-prompt skill + 可选 restart_agent） |
| `harness/packages/skills/` | `@cos/skills`：skill 目录 + `load_skill` |
| `src-tauri/src/plugins/mod.rs` | 壳端启停 + preflight + safe 切换 |
| `src-tauri/src/config/profile.rs` | active_profile 持久化 |
| `src-tauri/src/core/sidecar/` | 进程生命周期、`--profile`、preflight 自动降级 |
| `src/components/settings/PluginsTab.vue` | 设置页插件 Tab |
| `$COS_HOME/profiles/companion/cordis.patch.yml` | 启停状态（运行时） |

---

## 9. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-… | P0/P2 落地：统一 loader 契约、profile 启停、壳端 list/toggle、boot disable 过滤；SEA 正式退出 release 叙事 |
| （续） | 本文档建立；P1–P5 分期与验收写入，作为深水区实施依据 |
| （续） | 增加上游对照链接：[plugins-upstream-comparison.md](plugins-upstream-comparison.md) |
| （续） | **P1 完成**：`@cos/plugin-api` + 插件独立 typecheck + workspace 对齐 |
| （续） | **P3 完成**：safe profile、active_profile、preflight、补丁 quarantine、自动降级 |
| （续） | **P4 完成**：profile pnpm 安装/卸载、diver-plugins.json、internal 拒卸、hello-tool 冒烟 |
| （续） | **P5 完成**：`@diver/native-bridge` 共享 RPC 客户端 + native_status；memory/grep 收口 |
| （续） | **self-prompt**：`voice` 更名；prompts/*.md **assemble 热加载**（改正文不必重启）+ `@cos/skills`（revise-prompt）+ 保留 `restart_agent` 重启回路 |
