<script setup lang="ts" generic="K extends SlotName">
// 按 slot 名渲染条目：single/list/keyed 的解析在 registry 内完成。
import { computed } from "vue";
import { useSlotRegistry, useSlotVersion } from "../injection";
import SlotBoundary from "./SlotBoundary.vue";
import type { OwnerProps, SlotName } from "../types";

const props = defineProps<{
  name: K;
  owner: OwnerProps<K>;
  /** list：只渲染指定 id。 */
  only?: string;
  /** keyed：按 key 分发。 */
  entryKey?: string;
}>();

const registry = useSlotRegistry();
const version = useSlotVersion();
const entries = computed(() => {
  void version.value;
  return registry.resolve(props.name, {
    only: props.only,
    entryKey: props.entryKey,
  });
});
const ownerRecord = computed<Record<string, unknown>>(
  () => props.owner as Record<string, unknown>,
);
</script>

<template>
  <SlotBoundary
    v-for="entry in entries"
    :key="entry.uid"
    :entry="entry"
    :owner="ownerRecord"
  />
</template>
