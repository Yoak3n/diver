<script setup lang="ts">
// 设置「插件」页的实例选择器：插件启停/配置按实例隔离，必须先明确作用域。
import type { InstanceMeta } from "../../../tauri";

defineProps<{
  instances: InstanceMeta[];
  selectedId: string;
  runningIds: Set<string>;
}>();

const emit = defineEmits<{
  select: [id: string];
}>();
</script>

<template>
  <div class="instance-picker">
    <button
      v-for="inst in instances"
      :key="inst.id"
      type="button"
      class="instance-chip"
      :class="{ active: inst.id === selectedId }"
      @click="emit('select', inst.id)"
    >
      <span class="chip-name">{{ inst.name || inst.id }}</span>
      <span class="chip-state" :class="{ on: runningIds.has(inst.id) }">
        {{ runningIds.has(inst.id) ? "运行中" : "未运行" }}
      </span>
      <span v-if="!inst.enabled" class="chip-flag">不随应用启动</span>
    </button>
  </div>
</template>

<style scoped>
.instance-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}
.instance-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper-raised);
  color: var(--ink-muted);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color var(--dur-hover) ease,
    background var(--dur-hover) ease,
    color var(--dur-hover) ease;
}
@media (hover: hover) and (pointer: fine) {
  .instance-chip:hover {
    color: var(--ink);
    background: var(--paper-hover);
  }
}
.instance-chip.active {
  color: var(--ink);
  border-color: var(--accent);
  background: var(--paper-active);
}
.chip-name {
  font-weight: 500;
}
.chip-state {
  font-size: 11px;
  color: var(--ink-dim);
}
.chip-state.on {
  color: var(--ok);
}
.chip-flag {
  font-size: 11px;
  color: var(--warn);
}
</style>
