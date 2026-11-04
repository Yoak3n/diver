// 注册表注入与响应式读取。
// SlotRegistry 由 main.ts 在应用挂载前 provide；组件通过 useSlotRegistry 取用。

import {
  computed,
  inject,
  onScopeDispose,
  ref,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from "vue";
import type { ResolvedEntry, ResolveOptions, SlotName } from "./types";
import type { SlotRegistry } from "./slots/registry";

export const SLOT_REGISTRY_KEY: InjectionKey<SlotRegistry> = Symbol(
  "diver.slot-registry",
);

export function useSlotRegistry(): SlotRegistry {
  const registry = inject(SLOT_REGISTRY_KEY);
  if (registry === undefined) {
    throw new Error(
      "SlotRegistry 未提供：请在 main.ts 中 app.provide(SLOT_REGISTRY_KEY, registry)",
    );
  }
  return registry;
}

/** 订阅注册表变更；在组件 scope 销毁时自动退订。 */
export function useSlotVersion(): Readonly<Ref<number>> {
  const registry = useSlotRegistry();
  const version = ref(0);
  const stop = registry.subscribe(() => {
    version.value += 1;
  });
  onScopeDispose(stop);
  return version;
}

export function useSlotEntries<K extends SlotName>(
  name: K,
  opts?: ResolveOptions,
): ComputedRef<readonly ResolvedEntry<K>[]> {
  const registry = useSlotRegistry();
  const version = useSlotVersion();
  return computed(() => {
    void version.value;
    return registry.resolve(name, opts);
  });
}
