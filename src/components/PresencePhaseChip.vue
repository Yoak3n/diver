<script setup lang="ts">
// 标题栏用的轻量相位徽章：只展示 Presence FSM 叶子中文名。
import { usePresenceStatus } from "../composables/usePresenceStatus";

const props = defineProps<{ active?: boolean }>();
const { phaseLabel } = usePresenceStatus(() => props.active !== false);
</script>

<template>
  <span
    v-if="phaseLabel && phaseLabel !== '—'"
    class="presence-chip"
    title="存在感状态机相位"
  >
    {{ phaseLabel }}
  </span>
</template>

<style scoped>
.presence-chip {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--rule);
  background: var(--paper-sunken);
  color: var(--ink-soft);
  font-size: 11px;
  white-space: nowrap;
}
</style>
