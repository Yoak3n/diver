# 插件 UI 运行时（Vue slot）设计

> 状态：**已实现（阶段 1，2026-10-28）**。
> 实现落点：`src/plugin-ui/`（平台运行时）、`cos-plugins/onebot/ui/`（首个迁移样例）。
> 范围：阶段 1 —— 构建期注册（内置插件随包编译进 dist），为阶段 3 的运行时下发
> （`diver.client` + `/plugins/<id>/ui.js`）预留同形契约。
>
> 相关：[插件体系](plugins.md) · [架构](architecture.md) · [UI 设计系统](ui-design.md) ·
> [DSH 客户端插件机制对照](plugins-upstream-comparison.md)

---

## 1. 目标与非目标

### 目标

| 能力 | 含义 |
|---|---|
| **插件拥有自己的 UI** | 插件目录里写 `.vue`，不再由产品前端手写专属页面 |
| **产品只声明扩展点** | 产品提供 slot（`settings.tab`、`plugin.detail.section`…），插件注册条目 |
| **类型安全** | `SlotMap` 声明合并；注册错 slot、错 props 在 `vue-tsc` 阶段报错 |
| **生命周期托管** | 插件 UI 随插件启用/停用挂载/卸载；组件树随 slot owner 折叠递归清理 |
| **错误隔离** | 单个条目渲染失败只黑一张卡，不影响整个设置页 |
| **为运行时下发留同形契约** | 阶段 1 用 `import.meta.glob` 静态装配；阶段 3 换成远程 bundle，插件 API 不变 |

### 非目标（阶段 1 不做）

- **第三方不可信 UI**：阶段 1 只服务仓内 `cos-plugins/*`，代码随应用编译，完全可信。
  第三方 UI 走 iframe 沙箱（阶段 4），不进主 WebView。
- **运行时 HMR 插件管理**：阶段 1 只跟随 Vite HMR；插件启停仍以重启/重新挂载为准。
- **跨插件值导入**：插件之间只通过 slot 或注入的服务协作，不互相 import 组件。
- **完整 cordis 服务等待**：Diver 前端服务在启动时全部就绪，`inject` 只做声明与校验。

---

## 2. 分层与目录

```
src/plugin-ui/                    # 产品侧运行时（平台）
├── index.ts                      # 稳定公共出口（插件只从这里 import）
├── types.ts                      # SlotMap / 注册项 / props 形状
├── slots/
│   ├── registry.ts               # SlotRegistry（declare/register/inject/resolve）
│   ├── entries.ts                # 排序、cardinality、key 过滤（纯函数）
│   ├── store.ts                  # defineStore（shallowRef + markRaw + commit）
│   └── lifecycle.ts              # DisposableBag / mountPlugins
├── components/
│   ├── SlotOutlet.vue            # 按 slot 名渲染条目
│   ├── SlotBoundary.vue          # props 组装 + 错误边界
│   └── ConfigForm.vue            # configDecl 通用表单（从 settings/children 迁入）
├── services/
│   ├── index.ts                  # createClientContext()
│   ├── api.ts                    # 插件可见的窄 API 面
│   ├── instances.ts              # 实例/归属/运行态
│   └── i18n.ts                   # t()
├── injection.ts                  # provide key + useSlotRegistry/useSlotEntries
└── builtin.ts                    # import.meta.glob('/cos-plugins/*/ui/index.ts')
```

插件侧（每个插件一个 UI 半边）：

```
cos-plugins/<slug>/ui/
├── index.ts                      # ClientPlugin：name / inject / apply
├── <Slug>Panel.vue               # 页面/区块组件
├── use-<slug>-panel.ts           # 状态与 IO（组合式函数）
├── status.ts                     # 纯展示映射（可单测）
└── icon.ts                       # 可选
```

约束（沿用 AGENTS.md）：

- 前端文件软限 300 / 硬限 500；`registry.ts` 拆 `entries.ts`、`lifecycle.ts`。
- 插件 UI 只能 import `@diver/plugin-ui`，不得 import `src/components/**`、`src/api/**`。
- 平台运行时不得 import 任何 `cos-plugins/*` 的具体模块（只经 glob 发现）。
- 组件不接触 `ctx`；需要的数据/回调由注册项的 `provide` 注入。

---

## 3. 类型形状

### 3.1 SlotMap

```ts
// src/plugin-ui/types.ts
import type { Component, VNode } from 'vue'

export type SlotName = keyof SlotMap
export type SlotCardinality = 'single' | 'list' | 'keyed' | 'chain'
export type SlotScope = 'root' | 'session' | 'session-maybe'

/** 一个扩展点的声明：基数、作用域、owner 在渲染点传入的数据。 */
export interface SlotSpec<Owner = Record<string, unknown>> {
  cardinality: SlotCardinality
  scope?: SlotScope
  owner: Owner
}

/** 产品预声明的扩展点；插件可用 declare module 合并自己的。 */
export interface SlotMap {
  /** 设置页一级 tab（内容由 owner 按 active id 渲染）。 */
  'settings.tab': SlotSpec<{}>
  /** 插件详情页头部操作区。 */
  'plugin.detail.actions': SlotSpec<{ pluginId: string }>
  /** 插件详情页正文下方区块。 */
  'plugin.detail.section': SlotSpec<{ pluginId: string }>
  /** 会话头部操作区。 */
  'conversation.header.actions': SlotSpec<{ sessionId: string }>
}

export type OwnerProps<K extends SlotName> =
  SlotMap[K] extends SlotSpec<infer O> ? O : never
```

插件新增扩展点时用声明合并（必须同时由 owner 在渲染点声明，否则只是类型可见）：

```ts
declare module '@diver/plugin-ui' {
  interface SlotMap {
    'onebot.panel.extra': SlotSpec<{ ownerId: string }>
  }
}
```

插件 `ui/index.ts` 顶部必须有一句 `import type {} from '@diver/plugin-ui'`，
才能把平台的 `SlotMap` 合并拉进当前 program。

`SlotMap` 是唯一的编译期真源。插件要新增扩展点，必须由 owner 包声明（阶段 1 由产品声明），
插件不能单方面注册一个没人渲染的 slot。

### 3.2 注册项

```ts
export interface SlotRegistration<K extends SlotName, I = undefined, H = undefined> {
  name: K
  /** list 必填；single/keyed 忽略。 */
  id?: string
  /** keyed 必填。 */
  key?: string
  /** 升序；同序按注册先后。 */
  order?: number
  /** single/chain 的遮蔽/选举优先级，数值小者优先。 */
  priority?: number
  /** 该条目被授权渲染的子 slot（声明即授权）。 */
  children?: Record<string, SlotSpec>
  /** 共享视图状态；返回 defineStore 的句柄。 */
  store?: () => H
  /** 插件私有数据与回调；在 SlotBoundary 的 setup 中调用一次。 */
  provide?: (owner: OwnerProps<K>) => I
  /** 导航/列表类 slot 的文案与图标。 */
  label?: string | (() => string)
  icon?: Component
}

export type SlotComponent<K extends SlotName, I = undefined, H = undefined> =
  Component<SlotProps<K, I, H>>

export type SlotProps<K extends SlotName, I = undefined, H = undefined> =
  OwnerProps<K> &
  (I extends undefined ? unknown : I) &
  (H extends undefined ? unknown : { store: H }) & {
    /** 渲染已授权的子 slot。 */
    renderSlot: RenderSlot
    /** 插件自己的文案函数。 */
    t: Translate
  }

export type RenderSlot = (name: string, owner?: Record<string, unknown>) => VNode
export type Translate = (key: string, fallback?: string) => string

export interface Disposable {
  dispose(): void
}

/** 注册表解析后的条目（组件已绑定，provide/store 已就绪）。 */
export interface ResolvedEntry<K extends SlotName = SlotName> {
  readonly uid: number
  readonly plugin: string
  readonly name: K
  readonly id?: string
  readonly key?: string
  readonly order: number
  readonly priority: number
  readonly component: SlotComponent<K, any, any>
  readonly children: ReadonlySet<string>
  readonly store?: Store<any, any>
  readonly provide?: (owner: OwnerProps<K>) => unknown
  readonly label?: string | (() => string)
  readonly icon?: Component
}
```

与 DSH 的差异（有意）：

- DSH 的 `inject` 在每次渲染时调用；Diver 的 `provide` 在条目挂载时调用一次，
  owner 变化通过普通 props 传入。理由：Vue 组合式函数在 setup 里创建 refs/定时器，
  每次渲染重建会泄漏；一次性创建更符合 Vue 生命周期。
- DSH 的 props 五份额里 `PropsRenderSlots` 是 React 元素；Diver 用 `renderSlot` 函数
  返回 VNode，模板里也可以直接用 `<SlotOutlet>`（已授权时）。

### 3.3 store

```ts
// src/plugin-ui/slots/store.ts
import { computed, markRaw, shallowRef, triggerRef, type ComputedRef } from 'vue'

export interface Store<State, Actions> {
  readonly state: Readonly<State>
  readonly actions: Actions
  useStore<T>(selector: (state: Readonly<State>) => T): ComputedRef<T>
}

export function defineStore<State extends object, Actions extends object>(
  init: () => State,
  setup: (state: State, commit: () => void) => Actions,
): Store<State, Actions> {
  const inner = shallowRef(markRaw(init()))
  const actions = setup(inner.value, () => triggerRef(inner))
  return {
    state: inner.value,
    actions,
    useStore: (selector) => computed(() => selector(inner.value)),
  }
}
```

- 状态是**浅层**的：业务数据（会话、消息流）不放进 store，仍走对象层/composable。
- store 只承载跨条目共享、跨重挂载存活的**视图状态**（选中项、草稿、面板宽度）。
- `commit()` 是唯一的通知点；没有隐式深度响应。

### 3.4 客户端服务与插件模块

```ts
export interface ClientServices {
  slots: SlotRegistry
  api: PluginApi
  instances: InstanceService
  i18n: I18nService
  log: PluginLogger
}

export interface ClientPlugin {
  name: string
  /** 声明使用哪些服务；mount 时校验存在性。 */
  inject?: ReadonlyArray<keyof ClientServices>
  apply(ctx: ClientServices): void | (() => void)
}
```

`PluginApi` 是窄面，不是整个 `src/api`：

```ts
export interface PluginApi {
  listPluginConfigs(instanceId?: string): Promise<{ plugins: PluginConfigView[] }>
  savePluginConfig(
    id: string,
    values: Record<string, string | number | boolean | null>,
    instanceId?: string,
  ): Promise<void>
  onebotStatus(instanceId: string): Promise<OnebotStatus>
}

export interface InstanceService {
  readonly rows: Readonly<Ref<InstanceRow[]>>
  readonly onebotOwner: Readonly<Ref<string | null>>
  readonly runningIds: Readonly<Ref<ReadonlySet<string>>>
  refresh(): Promise<void>
  setOnebotOwner(id: string | null): Promise<void>
}
```

`PluginApi` 的实现在 `src/plugin-ui/services/api.ts`，内部调用 `src/api/*`；
插件永远看不到 `json()`、基址、令牌这些传输细节。

`provide` 的返回值只放三类东西：普通数据、回调、`reactive()` 对象。
**不要返回裸 `ref`**：Vue 不会在 props 里自动解包嵌套 ref，组件拿到的会是 ref 对象本身。

### 3.5 注册表组合式 API

```ts
// src/plugin-ui/index.ts
export function useSlotRegistry(): SlotRegistry
export function useSlotVersion(): Readonly<Ref<number>>
export function useSlotEntries<K extends SlotName>(
  name: K,
  opts?: { only?: string; entryKey?: string },
): ComputedRef<readonly ResolvedEntry<K>[]>
```

- `useSlotVersion()` 订阅注册表变更；`resolve()` 本身不响应式，靠 version 触发重算。
- `useSlotEntries()` = `computed(() => { version.value; return registry.resolve(name, opts) })`。
- 这两个 composable 必须在组件 setup 内调用（依赖 `inject`）。

---

## 4. 注册表语义

### 4.1 declare / register / inject

```ts
export interface SlotRegistry {
  /** owner 声明扩展点；返回撤销声明。 */
  declare<K extends SlotName>(name: K): Disposable
  isDeclared(name: SlotName): boolean

  /** 直接注册（owner 自己的 slot）；未声明时抛错。 */
  register<K extends SlotName, I, H>(
    reg: SlotRegistration<K, I, H>,
    component: SlotComponent<K, I, H>,
  ): Disposable

  /** 向别人的 slot 贡献；未声明时排队，声明后自动运行。 */
  inject<K extends SlotName>(name: K, fn: () => Disposable): Disposable

  /** 读取当前条目（按 cardinality 解析）。 */
  resolve<K extends SlotName>(
    name: K,
    opts?: { only?: string; entryKey?: string },
  ): readonly ResolvedEntry<K>[]

  has(name: SlotName, idOrKey: string): boolean
  subscribe(listener: () => void): () => void
}
```

规则：

1. **插件一律用 `inject`**，不要直接 `register`。插件在应用启动时挂载，此时设置页还没
   声明 slot；`inject` 负责排队。
2. `inject` 的回调在**每次 owner 声明生命周期内运行一次**：
   - owner 声明 → 运行回调，拿到 `Disposable`；
   - owner 折叠 → 调用该 `Disposable`；
   - owner 重新声明 → 再次运行回调；
   - 调用方自己 dispose → 移出队列并调用 `Disposable`。
3. 同一个 slot 只能有一个 owner（`declare` 重入抛错）；注册项可以有多个。
4. `register` 在未声明 slot 上抛错，避免"注册了但永远不显示"的静默失败。

内部状态最小化：

```ts
interface SlotState {
  declared: boolean
  entries: ResolvedEntry[]
  waiters: Set<{ fn: () => Disposable; disposable?: Disposable }>
}
```

- `declare` 只翻转 `declared` 并 flush waiters；重复声明抛错。
- `register` 只在 `declared` 时接受，push 后 bump version。
- `inject` 在未声明时入 waiters；声明时逐个运行并记住返回的 `Disposable`；
  owner 折叠时只 dispose 句柄，**不删除 waiter**（下次声明重跑）。

### 4.2 cardinality 与排序

| 基数 | 语义 | 必填 | 解析结果 |
|---|---|---|---|
| `single` | 单个 cell，priority 最小者胜 | — | 最多 1 条 |
| `list` | 多个条目，按 `order` 升序 | `id` | 全部 |
| `keyed` | 按 `entryKey` 分发 | `key` | 匹配 key 的全部，按 priority |
| `chain` | 依次询问 `select(owner)`，第一个非 null 胜出 | — | 最多 1 条 |

排序是纯函数，单独放 `entries.ts` 以便单测：

```ts
export function sortEntries(entries: readonly ResolvedEntry[]): ResolvedEntry[]
export function pickSingle(entries: readonly ResolvedEntry[]): ResolvedEntry[]
export function filterKeyed(entries: readonly ResolvedEntry[], key: string): ResolvedEntry[]
```

### 4.3 生命周期

- 每个插件一个 Vue `effectScope(true)`；`apply` 返回的清理函数与所有 `inject` 句柄
  进同一个 `DisposableBag`。
- 停用插件 = `scope.stop()` + `bag.dispose()`：watcher/computed 停止，注册项移除，
  store 句柄随条目卸载。
- slot owner 卸载 = 其 `declare` 返回的 dispose 被调用；所有贡献者的条目被移除，
  贡献者的 `inject` 回调保留，owner 重新挂载时重跑。

### 4.4 错误隔离

| 位置 | 失败行为 |
|---|---|
| `apply` 抛错 | 记日志，跳过该插件；应用继续启动 |
| `provide` 抛错 | `SlotBoundary` 显示错误卡，仅该条目 |
| 组件渲染/生命周期抛错 | `onErrorCaptured` 捕获，显示错误卡，`return false` 阻止冒泡 |
| 异步轮询抛错 | 插件自己写 `state.error`；边界不负责异步错误 |

错误卡文案包含插件名与 slot 名，便于定位；不向用户抛堆栈。

### 4.5 为什么不用 Vue 原生 provide/inject

- 原生 provide/inject 没有顺序、基数、key 分发，插件之间无法声明式排序。
- 原生 inject 无法表达"owner 声明后自动重跑"的跨包贡献生命周期。
- `SlotMap` 需要编译期声明合并与逐 slot 的 props 推导；原生 `InjectionKey` 做不到
  "注册错 slot 在 `vue-tsc` 阶段报错"。

注册表只借用 Vue 的 `effectScope` / `shallowRef` / `onErrorCaptured`，不借用它的
provide/inject 作为插件 API。

---

## 5. Renderer

### 5.1 SlotOutlet

```vue
<!-- src/plugin-ui/components/SlotOutlet.vue -->
<script setup lang="ts" generic="K extends SlotName">
import { computed } from 'vue'
import { useSlotRegistry, useSlotVersion } from '../index'
import SlotBoundary from './SlotBoundary.vue'
import type { OwnerProps, SlotName } from '../types'

const props = defineProps<{
  name: K
  owner: OwnerProps<K>
  /** list：只渲染指定 id；keyed：用 entryKey。 */
  only?: string
  entryKey?: string
}>()

const registry = useSlotRegistry()
const version = useSlotVersion()
const entries = computed(() => {
  version.value
  return registry.resolve(props.name, { only: props.only, entryKey: props.entryKey })
})
</script>

<template>
  <SlotBoundary
    v-for="entry in entries"
    :key="entry.uid"
    :entry="entry"
    :owner="owner"
  />
</template>
```

### 5.2 SlotBoundary

```vue
<!-- src/plugin-ui/components/SlotBoundary.vue -->
<script setup lang="ts">
import { computed, h, onErrorCaptured, ref } from 'vue'
import SlotOutlet from './SlotOutlet.vue'
import { useI18n } from '../services/i18n'
import type { ResolvedEntry } from '../slots/registry'

const props = defineProps<{
  entry: ResolvedEntry
  owner: Record<string, unknown>
}>()

const failed = ref<string | null>(null)
const i18n = useI18n()

onErrorCaptured((err) => {
  failed.value = err instanceof Error ? err.message : String(err)
  console.error(`[plugin-ui] ${props.entry.plugin}/${props.entry.name} render failed`, err)
  return false
})

// provide 在条目挂载时调用一次；owner 变化通过普通 props 传入。
// 自身 setup 抛错不会触发 onErrorCaptured，必须就地兜住。
let provided: Record<string, unknown> = {}
try {
  provided = (props.entry.provide?.(props.owner) ?? {}) as Record<string, unknown>
} catch (err) {
  failed.value = err instanceof Error ? err.message : String(err)
  console.error(`[plugin-ui] ${props.entry.plugin}/${props.entry.name} provide failed`, err)
}

const bound = computed(() => ({
  ...props.owner,
  ...provided,
  ...(props.entry.store ? { store: props.entry.store } : {}),
  t: (key: string, fallback?: string) => i18n.t(key, fallback),
  renderSlot: (name: string, owner: Record<string, unknown> = {}) => {
    if (!props.entry.children?.has(name)) {
      throw new Error(`slot ${name} 未在 ${props.entry.name} 的 children 中声明`)
    }
    return h(SlotOutlet, { name, owner })
  },
}))
</script>

<template>
  <div v-if="failed" class="slot-error">
    插件 {{ entry.plugin }} 的界面加载失败：{{ failed }}
  </div>
  <component :is="entry.component" v-else v-bind="bound" />
</template>
```

注意：

- `provide` 必须同步调用（`SlotBoundary` 的 setup 内），这样组合式函数里的
  `onMounted` / `onBeforeUnmount` 才绑到正确实例。
- `renderSlot` 只允许渲染 `entry.children` 声明过的 slot；未授权时抛错（由边界捕获）。
- `SlotBoundary` 内部以未绑定泛型的 `ResolvedEntry` 接收条目，`owner` 是
  `Record<string, unknown>`；实现里允许一次 `as never` 强转。类型安全由注册面的
  `SlotComponent` 保证，强转不得泄漏到插件代码。

### 5.3 与现有页面的集成

**SettingsView**：

```vue
<script setup lang="ts">
const registry = useSlotRegistry()
const pluginTabs = useSlotEntries('settings.tab')
const tabs = computed(() => [
  ...SETTINGS_TABS,
  ...pluginTabs.value.map((e) => ({
    id: e.id!,
    label: typeof e.label === 'function' ? e.label() : (e.label ?? e.id!),
  })),
])
const isBase = computed(() => isBaseSettingsTab(state.activeTab))
const isKnown = computed(() => tabs.value.some((t) => t.id === state.activeTab))
</script>

<template>
  <nav class="side-nav">
    <button v-for="t in tabs" :key="t.id" ...>{{ t.label }}</button>
  </nav>
  <main class="content">
    <!-- 基础 tab 保持原 v-if 链 -->
    <SlotOutlet
      v-if="!isBase && isKnown"
      name="settings.tab"
      :owner="{}"
      :only="state.activeTab"
    />
    <p v-else-if="!isKnown" class="hint">该设置页由插件提供，但插件当前未启用。</p>
  </main>
</template>
```

`activeTab` 的类型要放宽：

```ts
// src/composables/settings-state.ts
export interface SettingsState {
  activeTab: string          // 原 SettingsTab
  // ...
}
```

`SettingsView` 的 `tabFromRoute` 校验从 `isSettingsTab(id)` 改为
`isBaseSettingsTab(id) || registry.has('settings.tab', id)`；`selectTab` 参数改为 `string`。
未知 id 回退 `"models"`。

`settings-tabs.ts` 改名职责：

```ts
export type BaseSettingsTab = 'instances' | 'models' | 'voice' | 'mcp' | 'plugins'
  | 'shortcuts' | 'schedule' | 'presence' | 'system'

export const SETTINGS_TABS: Array<{ id: BaseSettingsTab; label: string }> = [...]
export function isBaseSettingsTab(v: string): v is BaseSettingsTab { ... }
```

`onebot` 从基础 tab 移除，改由插件注册。`PluginsTab` 的 `selectedConfigTab` 校验改为：

```ts
const known = isBaseSettingsTab(page.tab) || registry.has('settings.tab', page.tab)
```

**PluginsTab**：在 `PluginDetail.vue` 里加两个 outlet：

```vue
<SlotOutlet name="plugin.detail.actions" :owner="{ pluginId: selectedPluginId }" />
<SlotOutlet name="plugin.detail.section" :owner="{ pluginId: selectedPluginId }" />
```

### 5.4 ConfigForm

`src/plugin-ui/components/ConfigForm.vue` 是 `configDecl` 的唯一通用渲染器，从现有
`settings/children/PluginConfigForm.vue` 迁入，行为不变：

```ts
defineProps<{
  config: PluginConfigView
  draft: Record<string, string | boolean | null>
  busy?: boolean
}>()

defineEmits<{ save: [] }>()
```

- 不再需要 `pluginId` prop：保存动作由插件自己发起。
- 字段分组、secret 语义、select/boolean/number 渲染保持现状。
- `PluginsTab` 与 onebot 面板共用这一个组件，避免两份表单漂移。

---

## 6. 装配与加载

### 6.1 启动

```ts
// src/main.ts
import { SLOT_REGISTRY_KEY, SlotRegistry, createClientContext, mountPlugins } from "./plugin-ui"
import { builtinPlugins } from "./plugin-ui/builtin"

const registry = new SlotRegistry()
const services = createClientContext(registry)
mountPlugins(builtinPlugins, services, registry)
app.provide(SLOT_REGISTRY_KEY, registry)
app.mount('#app')
```

`builtinPlugins` **不在** `index.ts` 出口里：`index` 是插件的公共 API 面，loader 由产品
单独 import，避免 `index → builtin → 插件 → index` 的循环依赖。

插件先于应用挂载，`inject` 排队；设置页挂载时声明 slot，贡献立即生效。

### 6.2 内置插件发现

```ts
// src/plugin-ui/builtin.ts
const modules = import.meta.glob('/cos-plugins/*/ui/index.ts', { eager: true }) as Record<
  string,
  { default?: ClientPlugin } & Partial<ClientPlugin>
>

export const builtinPlugins: ClientPlugin[] = Object.entries(modules).flatMap(([path, mod]) => {
  const plugin = (mod.default ?? mod) as ClientPlugin
  if (typeof plugin.name !== 'string' || typeof plugin.apply !== 'function') return []
  return [plugin]
})
```

阶段 3 把这里换成 `defineAsyncComponent(() => import(remoteUrl))` 或自定义模块表；
`ClientPlugin` 契约不变。

### 6.3 构建与类型检查

| 项 | 改动 |
|---|---|
| `tsconfig.json` | `include` 增加 `"cos-plugins/*/ui/**/*.ts"`、`"cos-plugins/*/ui/**/*.vue"`；`paths` 增加 `"@diver/plugin-ui": ["./src/plugin-ui/index.ts"]`、`"@diver/plugin-ui/*": ["./src/plugin-ui/*"]` |
| `vite.config.ts` | `resolve.alias` 同上；`server.watch.ignored` 从 `"**/cos-plugins/**"` 改为 `"**/cos-plugins/*/src/**"`，让 `ui/` 参与 HMR |
| `pnpm typecheck:plugins` | 不变（插件 `tsconfig` 只 include `src/**/*.ts`；UI 由根 `vue-tsc` 覆盖） |
| `pnpm build` | `vue-tsc --noEmit` 已覆盖插件 UI |

---

## 7. onebot 迁移样例

### 7.1 现状

`src/components/settings/OnebotTab.vue`（367 行）承担四件事：

1. 归属实例单选（`useInstances` + `instances.json` IPC）；
2. 运行中实例集（`refreshInstanceRuntimes`）；
3. 归属实例的 `configDecl` 表单（`getPluginConfigsApi` / `savePluginConfigApi`）；
4. 3 秒轮询 `getOnebotStatusApi` 的状态灯。

这些能力全部属于 onebot 插件，却住在产品前端；迁移目标是把 1–4 搬进
`cos-plugins/onebot/ui/`，产品只保留 `settings.tab` 扩展点和通用 `ConfigForm`。

### 7.2 目标结构

```
cos-plugins/onebot/ui/
├── index.ts                 # 注册 settings.tab
├── OnebotPanel.vue          # 页面（归属 + 状态灯 + 配置表单）
├── use-onebot-panel.ts      # 状态与 IO（组合式函数）
├── status.ts                # OnebotStatus → tone/title/detail（纯函数，可单测）
└── icon.ts                  # tab 图标
```

### 7.3 代码骨架

```ts
// cos-plugins/onebot/ui/index.ts
import type { ClientPlugin, ClientServices } from '@diver/plugin-ui'
import OnebotPanel from './OnebotPanel.vue'
import { OnebotIcon } from './icon'
import { createOnebotPanel } from './use-onebot-panel'

export const name = 'onebot-ui'

export const inject = ['slots', 'api', 'instances', 'i18n'] as const

export function apply(ctx: ClientServices): void {
  ctx.slots.inject('settings.tab', () =>
    ctx.slots.register(
      {
        name: 'settings.tab',
        id: 'onebot',
        order: 20,
        label: () => ctx.i18n.t('onebot.tab', 'QQ 接入'),
        icon: OnebotIcon,
        provide: () => ({ panel: createOnebotPanel(ctx) }),
      },
      OnebotPanel,
    ),
  )
}
```

```ts
// cos-plugins/onebot/ui/use-onebot-panel.ts
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import type { ClientServices, OnebotStatus, PluginConfigView } from '@diver/plugin-ui'
import { describeStatus } from './status'

export interface OnebotPanelState {
  instances: ReadonlyArray<{ id: string; name: string }>
  owner: string | null
  runningIds: ReadonlySet<string>
  status: ReturnType<typeof describeStatus>
  config: PluginConfigView | null
  draft: Record<string, string | boolean | null>
  busy: boolean
  notice: string
  error: string
  setOwner(id: string): void
  reload(): Promise<void>
  save(): Promise<void>
}

export function createOnebotPanel(ctx: ClientServices): OnebotPanelState {
  const state = reactive<OnebotPanelState>({
    instances: [],
    owner: ctx.instances.onebotOwner.value,
    runningIds: new Set(),
    status: describeStatus({ owner: null, ownerRunning: false, status: null, error: '' }),
    config: null,
    draft: {},
    busy: false,
    notice: '',
    error: '',
    setOwner,
    reload,
    save,
  })

  let timer: number | undefined

  function startPoll(): void {
    stopPoll()
    if (state.owner === null || !state.runningIds.has(state.owner)) return
    void loadStatus()
    timer = window.setInterval(() => void loadStatus(), 3000)
  }

  function stopPoll(): void {
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined
  }

  async function loadStatus(): Promise<void> {
    if (state.owner === null) return
    try {
      const s: OnebotStatus = await ctx.api.onebotStatus(state.owner)
      state.status = describeStatus({
        owner: state.owner,
        ownerRunning: state.runningIds.has(state.owner),
        status: s,
        error: '',
      })
    } catch (err) {
      state.status = describeStatus({
        owner: state.owner,
        ownerRunning: true,
        status: null,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function setOwner(id: string): Promise<void> {
    state.owner = id
    await ctx.instances.setOnebotOwner(id)
    await reload()
  }

  async function reload(): Promise<void> {
    await ctx.instances.refresh()
    state.instances = ctx.instances.rows.value.map((r) => ({ id: r.id, name: r.name }))
    state.runningIds = ctx.instances.runningIds.value
    await loadConfig()
    startPoll()
  }

  async function loadConfig(): Promise<void> {
    state.config = null
    state.draft = {}
    state.error = ''
    state.notice = ''
    if (state.owner === null || !state.runningIds.has(state.owner)) return
    state.busy = true
    try {
      const res = await ctx.api.listPluginConfigs(state.owner)
      const view = res.plugins.find((p) => p.id === 'onebot') ?? null
      if (view === null || view.fields.length === 0) {
        state.error = '该实例未暴露 OneBot 配置（插件可能已停用）'
        return
      }
      state.config = view
      state.draft = draftFromView(view)
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
    } finally {
      state.busy = false
    }
  }

  async function save(): Promise<void> {
    if (state.owner === null || state.config === null) return
    state.busy = true
    state.notice = ''
    state.error = ''
    try {
      await ctx.api.savePluginConfig('onebot', state.draft, state.owner)
      state.notice = '已保存，重启归属实例后生效'
      await loadConfig()
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
    } finally {
      state.busy = false
    }
  }

  watch(() => state.owner, startPoll)
  watch(() => state.runningIds, startPoll)
  watch(
    () => ctx.instances.rows.value,
    (rows) => { state.instances = rows.map((r) => ({ id: r.id, name: r.name })) },
  )
  onBeforeUnmount(stopPoll)

  void reload()
  return state
}

function draftFromView(view: PluginConfigView): Record<string, string | boolean | null> {
  const out: Record<string, string | boolean | null> = {}
  for (const f of view.fields) {
    out[f.key] = f.type === 'boolean'
      ? f.value === 'true' || f.default === true
      : (f.value ?? (f.default != null ? String(f.default) : ''))
  }
  return out
}
```

```vue
<!-- cos-plugins/onebot/ui/OnebotPanel.vue -->
<script setup lang="ts">
import { ConfigForm } from '@diver/plugin-ui'
import type { OnebotPanelState } from './use-onebot-panel'

const props = defineProps<{
  panel: OnebotPanelState
  t: (key: string, fallback?: string) => string
}>()
</script>

<template>
  <label class="group-title">{{ props.t('onebot.owner', '归属实例') }}</label>
  <div class="owner-picker">
    <label v-for="row in props.panel.instances" :key="row.id" class="owner-option">
      <input
        type="radio"
        :checked="props.panel.owner === row.id"
        @change="props.panel.setOwner(row.id)"
      />
      {{ row.name }}
      <span v-if="props.panel.runningIds.has(row.id)" class="state-note run">运行中</span>
    </label>
  </div>

  <div class="link-card" :class="`tone-${props.panel.status.tone}`">
    <span class="link-dot" />
    <div class="link-copy">
      <div class="link-title">{{ props.panel.status.title }}</div>
      <div class="link-detail">{{ props.panel.status.detail }}</div>
    </div>
    <button class="btn small link-refresh" @click="props.panel.reload()">刷新</button>
  </div>

  <div v-if="props.panel.notice" class="ok-msg">{{ props.panel.notice }}</div>
  <div v-if="props.panel.error" class="error-msg">{{ props.panel.error }}</div>

  <ConfigForm
    v-if="props.panel.config"
    :config="props.panel.config"
    :draft="props.panel.draft"
    :busy="props.panel.busy"
    @save="props.panel.save()"
  />
  <p v-else-if="props.panel.error === ''" class="hint">正在读取配置…</p>
</template>
```

```ts
// cos-plugins/onebot/ui/status.ts（从 OnebotTab 的 computed 原样抽出）
export type StatusTone = 'ok' | 'warn' | 'bad' | 'idle'

export interface StatusInput {
  owner: string | null
  ownerRunning: boolean
  status: OnebotStatus | null
  error: string
}

export interface StatusView {
  tone: StatusTone
  title: string
  detail: string
}

export function describeStatus(input: StatusInput): StatusView {
  // 现有 statusTone / statusTitle / statusDetail 的三段逻辑合并到这里
}
```

### 7.4 产品侧改动

| 文件 | 改动 |
|---|---|
| `src/components/settings/OnebotTab.vue` | **删除** |
| `src/components/settings/children/PluginConfigForm.vue` | 迁到 `src/plugin-ui/components/ConfigForm.vue`；emit 改为无参 `save`（插件自己知道 id） |
| `src/components/settings/children/pluginConfigValues.ts` | 迁到 `src/plugin-ui/components/config-values.ts` |
| `src/composables/settings-tabs.ts` | 移除 `onebot`，导出 `isBaseSettingsTab` |
| `src/composables/settings-state.ts` | `activeTab: SettingsTab` → `activeTab: string` |
| `src/views/SettingsView.vue` | 移除 `OnebotTab` 分支；nav 追加 slot 条目；内容区渲染 `SlotOutlet`；路由校验改为 base + slot |
| `src/components/settings/PluginsTab.vue` | `selectedConfigTab` 校验改为 `isBaseSettingsTab \|\| registry.has(...)`；`openTab` 参数类型改为 `string` |
| `src/plugin-ui/services/api.ts` | 包装 `getPluginConfigsApi` / `savePluginConfigApi` / `getOnebotStatusApi` |
| `src/plugin-ui/services/instances.ts` | 包装 `useInstances` / `refreshInstanceRuntimes` |
| `src/main.ts` | 创建 registry、mount 插件、`provide` |
| `vite.config.ts` / `tsconfig.json` | alias + include + watch 调整 |

后端 `@diver/backend` 的 `SETTINGS_PAGES`（`onebot → tab onebot`）**不需要改**：
tab id 仍然是 `onebot`，只是渲染来源从产品组件变成插件条目。阶段 2 可以把这份映射
彻底移除，改由插件 UI 注册时声明页面。

### 7.5 验收

- `pnpm build`（含 `vue-tsc --noEmit`）通过。
- 设置页出现「QQ 接入」，内容由 `cos-plugins/onebot/ui/` 渲染。
- 归属单选、运行中标记、状态灯 3 秒轮询、配置读取/保存行为与迁移前一致。
- 删除 `cos-plugins/onebot/ui/index.ts` 的注册后，tab 消失，应用其余部分正常。
- `rg "OnebotTab" src` 无命中。
- 插件 UI 不出现 `from "../../src/` 或 `from "src/` 的导入。

---

## 8. 测试

已落地：`vitest` + `@vue/test-utils` + `jsdom`，脚本 `pnpm test:ui`（当前 27 个用例全绿）。

| 测试文件 | 覆盖 |
|---|---|
| `src/plugin-ui/slots/entries.test.ts` | 排序、single 选择、keyed 过滤、chain 选举 |
| `src/plugin-ui/slots/registry.test.ts` | declare 重入、register 未声明抛错、inject 排队/重跑/撤销、插件名、subscribe |
| `src/plugin-ui/slots/store.test.ts` | commit 触发 selector、无 commit 不触发 |
| `src/plugin-ui/slots/lifecycle.test.ts` | DisposableBag 幂等、异常不阻断、插件卸载清理 |
| `src/plugin-ui/components/SlotOutlet.test.ts` | list 渲染与 `only` 过滤（jsdom） |
| `cos-plugins/onebot/ui/status.test.ts` | 五种连接状态的 tone/title/detail |

---

## 9. 实施记录

| 步 | 内容 | 状态 |
|---|---|---|
| 1a | `types.ts` + `entries.ts` + `registry.ts` + `lifecycle.ts` + 单测 | ✅ |
| 1b | `store.ts` + `SlotOutlet` / `SlotBoundary` + 单测 | ✅ |
| 1c | `services/` + `injection.ts` + `builtin.ts` + `main.ts` 接入 | ✅ |
| 1d | `SettingsView` / `settings-tabs` / `PluginsTab` 接入 slot | ✅ |
| 1e | onebot UI 迁移 + 删除 `OnebotTab.vue` | ✅ |
| 1f | `pnpm test:ui` / `vue-tsc` / `pnpm build` 全绿 | ✅ |

实现偏差（相对设计稿）：

- `context.ts` 拆成 `injection.ts`（provide key + composables）与 `services/index.ts`
  （`createClientContext`），避免组件模块把 API 传输层一起拉进来。
- `SlotComponent` 接受 `Component<SlotProps<…>> | Component`：SFC 不必为了满足类型
  声明未使用的 `renderSlot` prop；slot 名与 `provide` 返回值的类型仍受检查。
- 注册表增加 `disposePlugin(name)`：`mountPlugins` 卸载时同时清掉该插件的 waiter
  与已注册条目，避免只停 `effectScope` 而残留 UI。
- `settings.tab` 由 `SettingsView` 在 setup 中 `declare`，插件在启动时 `inject` 排队；
  路由校验依赖 `pluginTabs`，插件 tab 晚注册时也能重新解析。
- 插件 UI 目前用 `import.meta.glob(..., { eager: true })` 打进主包；阶段 2 再改懒加载。

---

## 10. 风险与后续

| 风险 | 处理 |
|---|---|
| `inject` 重跑导致状态泄漏 | 回调必须返回幂等 `Disposable`；store 在 `provide` 中创建，随条目卸载 |
| 插件 UI 误 import 产品内部 | 只暴露 `@diver/plugin-ui` 出口；review + 后续 ESLint `no-restricted-imports` |
| 全量 eager glob 增大首屏 | 阶段 1 只迁移 onebot；阶段 2 改 `import.meta.glob` 懒加载 + `defineAsyncComponent` |
| HMR 不生效 | `vite.config.ts` 的 `watch.ignored` 收窄到 `cos-plugins/*/src/**` |
| 类型合并不可见 | 插件 `ui/index.ts` 顶部 `import type {} from '@diver/plugin-ui'`；文档注明 |
| 异步错误绕过边界 | 组合式函数自己写 `error` 状态；边界只兜渲染/生命周期错误 |

后续阶段：

- **阶段 2**：`PluginsTab` 详情页接 `plugin.detail.actions/section`；更多内置插件迁入
  （web-tools、memory 的配置面）；`SETTINGS_PAGES` 退役。
- **阶段 3**：`diver.client` 声明 + backend `/plugins/<id>/ui.js` + boot 图 +
  客户端模块表；`ClientPlugin` 契约不变，`builtin.ts` 换成远程加载。
- **阶段 4**：第三方不可信 UI 走 iframe + postMessage SDK，不进主 WebView。
