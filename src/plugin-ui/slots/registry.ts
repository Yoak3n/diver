// slot 注册表：声明、注册、跨包注入与解析。
//
// 关键语义：
// - owner 用 declare() 声明扩展点；重复声明抛错。
// - 插件用 inject() 向别人的 slot 贡献；未声明时排队，owner 声明后自动运行。
// - owner 折叠时只 dispose 贡献句柄、保留 waiter，重新声明会重跑。
// - 插件一律用 inject；直接 register 只允许 owner 自己。

import type { Component } from "vue";
import type {
  Disposable,
  OwnerProps,
  ResolvedEntry,
  ResolveOptions,
  SlotComponent,
  SlotName,
  SlotRegistration,
  SlotRegistryApi,
  SlotSpec,
  Store,
} from "../types";
import { resolveEntries } from "./entries";

interface Waiter {
  readonly plugin: string;
  readonly fn: () => Disposable;
  disposable?: Disposable;
}

interface SlotState {
  readonly name: SlotName;
  readonly spec: SlotSpec;
  declared: boolean;
  entries: ResolvedEntry[];
  readonly waiters: Set<Waiter>;
}

export class SlotRegistry implements SlotRegistryApi {
  private readonly slots = new Map<SlotName, SlotState>();
  private readonly listeners = new Set<() => void>();
  private uid = 0;

  /** 插件作用域的注册表门面：把 plugin 名写进条目，插件代码无感。 */
  forPlugin(plugin: string): SlotRegistryApi {
    return {
      declare: <K extends SlotName>(name: K) => this.declare(name),
      isDeclared: (name) => this.isDeclared(name),
      register: <K extends SlotName, I = undefined, H = undefined>(
        registration: SlotRegistration<K, I, H>,
        component: SlotComponent<K, I, H>,
      ) => this.registerFor(plugin, registration, component),
      inject: <K extends SlotName>(name: K, fn: () => Disposable) =>
        this.injectFor(plugin, name, fn),
      resolve: <K extends SlotName>(name: K, opts?: ResolveOptions) =>
        this.resolve(name, opts),
      has: (name, idOrKey) => this.has(name, idOrKey),
      subscribe: (listener) => this.subscribe(listener),
    };
  }

  declare<K extends SlotName>(name: K, spec?: Partial<SlotSpec>): Disposable {
    const state = this.ensure(name, spec);
    if (state.declared) {
      throw new Error(`slot ${String(name)} 已有 owner，不能重复声明`);
    }
    state.declared = true;
    for (const waiter of state.waiters) this.runWaiter(state, waiter);
    this.bump();
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.undeclare(name);
      },
    };
  }

  isDeclared(name: SlotName): boolean {
    return this.slots.get(name)?.declared === true;
  }

  register<K extends SlotName, I = undefined, H = undefined>(
    registration: SlotRegistration<K, I, H>,
    component: SlotComponent<K, I, H>,
  ): Disposable {
    return this.registerFor("product", registration, component);
  }

  inject<K extends SlotName>(name: K, fn: () => Disposable): Disposable {
    return this.injectFor("product", name, fn);
  }

  resolve<K extends SlotName>(
    name: K,
    opts?: ResolveOptions,
  ): readonly ResolvedEntry<K>[] {
    const state = this.slots.get(name);
    if (state === undefined) return [];
    return resolveEntries(
      state.entries,
      state.spec.cardinality,
      opts,
    ) as unknown as ResolvedEntry<K>[];
  }

  has(name: SlotName, idOrKey: string): boolean {
    const state = this.slots.get(name);
    if (state === undefined) return false;
    return state.entries.some(
      (entry) => entry.id === idOrKey || entry.key === idOrKey,
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 插件卸载：移除它注入的 waiter 与已注册条目（幂等）。 */
  disposePlugin(plugin: string): void {
    for (const state of this.slots.values()) {
      for (const waiter of [...state.waiters]) {
        if (waiter.plugin !== plugin) continue;
        state.waiters.delete(waiter);
        waiter.disposable?.dispose();
        waiter.disposable = undefined;
      }
      const kept = state.entries.filter((entry) => entry.plugin !== plugin);
      if (kept.length !== state.entries.length) state.entries = kept;
    }
    this.bump();
  }

  private registerFor<K extends SlotName, I, H>(
    plugin: string,
    registration: SlotRegistration<K, I, H>,
    component: SlotComponent<K, I, H>,
  ): Disposable {
    const state = this.slots.get(registration.name);
    if (state === undefined || !state.declared) {
      throw new Error(
        `slot ${String(registration.name)} 未声明；插件请使用 slots.inject`,
      );
    }
    const entry = this.createEntry(plugin, registration, component);
    state.entries.push(entry as ResolvedEntry);
    this.bump();
    return { dispose: () => this.remove(entry as ResolvedEntry) };
  }

  private injectFor<K extends SlotName>(
    plugin: string,
    name: K,
    fn: () => Disposable,
  ): Disposable {
    const state = this.ensure(name);
    const waiter: Waiter = { plugin, fn };
    state.waiters.add(waiter);
    if (state.declared) this.runWaiter(state, waiter);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        state.waiters.delete(waiter);
        waiter.disposable?.dispose();
        waiter.disposable = undefined;
        this.bump();
      },
    };
  }

  private runWaiter(state: SlotState, waiter: Waiter): void {
    if (waiter.disposable !== undefined) return;
    try {
      waiter.disposable = waiter.fn();
    } catch (err) {
      console.error(
        `[plugin-ui] ${waiter.plugin} 注入 ${String(state.name)} 失败`,
        err,
      );
    }
  }

  private undeclare(name: SlotName): void {
    const state = this.slots.get(name);
    if (state === undefined) return;
    state.declared = false;
    state.entries = [];
    for (const waiter of state.waiters) {
      waiter.disposable?.dispose();
      waiter.disposable = undefined;
    }
    this.bump();
  }

  private remove(entry: ResolvedEntry): void {
    for (const state of this.slots.values()) {
      const index = state.entries.indexOf(entry);
      if (index < 0) continue;
      state.entries.splice(index, 1);
      this.bump();
      return;
    }
  }

  private createEntry<K extends SlotName, I, H>(
    plugin: string,
    registration: SlotRegistration<K, I, H>,
    component: SlotComponent<K, I, H>,
  ): ResolvedEntry<K> {
    return {
      uid: ++this.uid,
      plugin,
      name: registration.name,
      id: registration.id,
      key: registration.key,
      order: registration.order ?? 0,
      priority: registration.priority ?? 0,
      component: component as unknown as Component,
      children: new Set(Object.keys(registration.children ?? {})),
      store: registration.store?.() as Store<any, any> | undefined,
      provide: registration.provide as
        | ((owner: OwnerProps<K>) => unknown)
        | undefined,
      label: registration.label,
      icon: registration.icon,
    };
  }

  private ensure(name: SlotName, spec?: Partial<SlotSpec>): SlotState {
    const existing = this.slots.get(name);
    if (existing !== undefined) return existing;
    const state: SlotState = {
      name,
      spec: {
        cardinality: spec?.cardinality ?? "list",
        scope: spec?.scope,
        owner: spec?.owner ?? {},
      },
      declared: false,
      entries: [],
      waiters: new Set(),
    };
    this.slots.set(name, state);
    return state;
  }

  private bump(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[plugin-ui] slot 监听器执行失败", err);
      }
    }
  }
}
