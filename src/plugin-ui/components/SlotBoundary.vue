<script setup lang="ts">
// 单个 slot 条目的边界：组装 props、调用 provide、隔离渲染错误。
import { computed, h, onErrorCaptured, ref, type Component } from "vue";
import SlotOutlet from "./SlotOutlet.vue";
import { i18n } from "../services/i18n";
import type { ResolvedEntry } from "../types";

const props = defineProps<{
  entry: ResolvedEntry;
  owner: Record<string, unknown>;
}>();

const failed = ref<string | null>(null);

onErrorCaptured((err) => {
  failed.value = err instanceof Error ? err.message : String(err);
  console.error(
    `[plugin-ui] ${props.entry.plugin}/${String(props.entry.name)} render 失败`,
    err,
  );
  return false;
});

// provide 在条目挂载时调用一次；owner 变化通过普通 props 传入。
// 自身 setup 抛错不会触发 onErrorCaptured，必须就地兜住。
let provided: Record<string, unknown> = {};
const provide = props.entry.provide as
  | ((owner: Record<string, unknown>) => unknown)
  | undefined;
try {
  const value = provide?.(props.owner);
  if (value !== null && typeof value === "object") {
    provided = value as Record<string, unknown>;
  }
} catch (err) {
  failed.value = err instanceof Error ? err.message : String(err);
  console.error(
    `[plugin-ui] ${props.entry.plugin}/${String(props.entry.name)} provide 失败`,
    err,
  );
}

const bound = computed(() => ({
  ...props.owner,
  ...provided,
  ...(props.entry.store === undefined ? {} : { store: props.entry.store }),
  t: (key: string, fallback?: string) => i18n.t(key, fallback),
  renderSlot: (name: string, slotOwner: Record<string, unknown> = {}) => {
    if (!props.entry.children.has(name)) {
      throw new Error(
        `slot ${name} 未在 ${String(props.entry.name)} 的 children 中声明`,
      );
    }
    return h(SlotOutlet as unknown as Component, { name, owner: slotOwner });
  },
}));
</script>

<template>
  <div v-if="failed" class="slot-error">
    插件 {{ entry.plugin }} 的界面加载失败：{{ failed }}
  </div>
  <component :is="entry.component" v-else v-bind="bound" />
</template>

<style scoped>
.slot-error {
  padding: 10px 12px;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  background: var(--paper-raised);
  color: var(--ink-dim);
  font-size: 12px;
  line-height: 1.7;
}
</style>
