<script setup lang="ts">
import type { ChatMessage } from "../types";

const props = defineProps<{
  msg: ChatMessage;
  expanded: boolean;
}>();

defineEmits<{ toggle: [] }>();

const label = `${props.msg.toolCount ?? 0} 次工具调用 · ${props.msg.messageCount ?? 0} 条消息`;
</script>

<template>
  <button class="activity-summary" type="button" @click="$emit('toggle')">
    <span class="chevron" :class="{ open: expanded }">›</span>
    <span class="label">{{ label }}</span>
    <span class="hint">{{ expanded ? "收起" : "展开" }}</span>
  </button>
</template>

<style scoped>
.activity-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 2px 0;
  padding: 8px 4px;
  background: transparent;
  border: none;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  border-radius: 0;
  color: var(--ink-muted);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition:
    color var(--dur-hover) ease,
    background var(--dur-hover) ease,
    transform var(--dur-press) var(--ease-out);
}
@media (hover: hover) and (pointer: fine) {
  .activity-summary:hover {
    color: var(--ink);
    background: var(--paper-hover);
  }
}
.activity-summary:active {
  transform: scale(0.99);
}
.label {
  flex: 1;
}
.hint {
  color: var(--ink-dim);
  font-size: 11px;
}
.chevron {
  font-size: 14px;
  color: var(--ink-dim);
  transition: transform var(--dur-ui) var(--ease-out);
}
.chevron.open {
  transform: rotate(90deg);
}
</style>
