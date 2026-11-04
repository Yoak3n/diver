// 插件 UI 的类型契约。SlotMap 是唯一的编译期真源：产品与插件都通过
// `declare module '@diver/plugin-ui'` 合并扩展点，注册错 slot / 错 props 在
// vue-tsc 阶段报错。

import type { Component, ComputedRef, Ref, VNode } from "vue";
import type { OnebotStatus, PluginConfigView } from "../api";

export type SlotName = keyof SlotMap;
export type SlotCardinality = "single" | "list" | "keyed" | "chain";
export type SlotScope = "root" | "session" | "session-maybe";

/** 一个扩展点的声明：基数、作用域、owner 在渲染点传入的数据。 */
export interface SlotSpec<Owner = Record<string, unknown>> {
  cardinality: SlotCardinality;
  scope?: SlotScope;
  owner: Owner;
}

/** 产品预声明的扩展点；插件可用 declare module 合并自己的。 */
export interface SlotMap {
  /** 设置页一级 tab（内容由 owner 按 active id 渲染）。 */
  "settings.tab": SlotSpec<Record<string, never>>;
  /** 插件详情页头部操作区。 */
  "plugin.detail.actions": SlotSpec<{ pluginId: string }>;
  /** 插件详情页正文下方区块。 */
  "plugin.detail.section": SlotSpec<{ pluginId: string }>;
  /** 会话头部操作区。 */
  "conversation.header.actions": SlotSpec<{ sessionId: string }>;
}

export type OwnerProps<K extends SlotName> =
  SlotMap[K] extends SlotSpec<infer O> ? O : never;

export type RenderSlot = (name: string, owner?: Record<string, unknown>) => VNode;
export type Translate = (key: string, fallback?: string) => string;

export interface Disposable {
  dispose(): void;
}

export interface Store<State, Actions> {
  readonly state: Readonly<State>;
  readonly actions: Actions;
  useStore<T>(selector: (state: Readonly<State>) => T): ComputedRef<T>;
}

export interface ResolveOptions {
  /** list：只取指定 id。 */
  only?: string;
  /** keyed：按 key 分发。 */
  entryKey?: string;
}

export interface SlotRegistration<K extends SlotName, I = undefined, H = undefined> {
  name: K;
  /** list 必填；single/keyed 忽略。 */
  id?: string;
  /** keyed 必填。 */
  key?: string;
  /** 升序；同序按注册先后。 */
  order?: number;
  /** single/chain 的遮蔽/选举优先级，数值小者优先。 */
  priority?: number;
  /** 该条目被授权渲染的子 slot（声明即授权）。 */
  children?: Record<string, SlotSpec>;
  /** 共享视图状态；返回 defineStore 的句柄。 */
  store?: () => H;
  /** 插件私有数据与回调；在 SlotBoundary 的 setup 中调用一次。 */
  provide?: (owner: OwnerProps<K>) => I;
  /** 导航/列表类 slot 的文案与图标。 */
  label?: string | (() => string);
  icon?: Component;
}

export type SlotProps<K extends SlotName, I = undefined, H = undefined> =
  OwnerProps<K> &
  (I extends undefined ? {} : I) &
  (H extends undefined ? {} : { store: H }) & {
    /** 渲染已授权的子 slot。 */
    renderSlot: RenderSlot;
    /** 插件自己的文案函数。 */
    t: Translate;
  };

export type SlotComponent<K extends SlotName, I = undefined, H = undefined> =
  | Component<SlotProps<K, I, H>>
  | Component;

/** 注册表解析后的条目（组件已绑定，provide/store 已就绪）。 */
export interface ResolvedEntry<K extends SlotName = SlotName> {
  readonly uid: number;
  readonly plugin: string;
  readonly name: K;
  readonly id?: string;
  readonly key?: string;
  readonly order: number;
  readonly priority: number;
  readonly component: Component;
  readonly children: ReadonlySet<string>;
  readonly store?: Store<any, any>;
  readonly provide?: (owner: OwnerProps<K>) => unknown;
  readonly label?: string | (() => string);
  readonly icon?: Component;
}

export interface SlotRegistryApi {
  declare<K extends SlotName>(name: K): Disposable;
  isDeclared(name: SlotName): boolean;
  register<K extends SlotName, I = undefined, H = undefined>(
    registration: SlotRegistration<K, I, H>,
    component: SlotComponent<K, I, H>,
  ): Disposable;
  inject<K extends SlotName>(name: K, fn: () => Disposable): Disposable;
  resolve<K extends SlotName>(
    name: K,
    opts?: ResolveOptions,
  ): readonly ResolvedEntry<K>[];
  has(name: SlotName, idOrKey: string): boolean;
  subscribe(listener: () => void): () => void;
}

// ---------- 插件可见的服务面 ----------

export interface InstanceRow {
  id: string;
  name: string | null;
  enabled: boolean;
}

export interface InstanceService {
  readonly rows: Readonly<Ref<readonly InstanceRow[]>>;
  readonly onebotOwner: Readonly<Ref<string | null>>;
  readonly runningIds: Readonly<Ref<ReadonlySet<string>>>;
  readonly notice: Readonly<Ref<string>>;
  readonly error: Readonly<Ref<string>>;
  refresh(): Promise<void>;
  setOnebotOwner(id: string | null): Promise<void>;
}

export interface PluginApi {
  listPluginConfigs(instanceId?: string): Promise<{ plugins: PluginConfigView[] }>;
  savePluginConfig(
    id: string,
    values: Record<string, string | number | boolean | null>,
    instanceId?: string,
  ): Promise<void>;
  onebotStatus(instanceId: string): Promise<OnebotStatus>;
}

export interface I18nService {
  t(key: string, fallback?: string): string;
}

export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ClientServices {
  slots: SlotRegistryApi;
  api: PluginApi;
  instances: InstanceService;
  i18n: I18nService;
  log: PluginLogger;
}

export interface ClientPlugin {
  name: string;
  /** 声明使用哪些服务；mount 时校验存在性。 */
  inject?: ReadonlyArray<keyof ClientServices>;
  apply(ctx: ClientServices): void | (() => void);
}
