<script setup lang="ts">
import type { ChatMessage } from "../types";

const props = defineProps<{
  msg: ChatMessage;
  /** 该组是否展开（由父层持有，便于成员消息联动显示）。 */
  expanded: boolean;
}>();

defineEmits<{ toggle: [] }>();

const label = `${props.msg.toolCount ?? 0} 次工具调用 · ${props.msg.messageCount ?? 0} 条消息`;
</script>

<template>
  <button class="activity-summary" type="button" @click="$emit('toggle')">
    <span class="label">{{ label }}</span>
    <span class="chevron" :class="{ open: expanded }">›</span>
  </button>
</template>

<style scoped>
.activity-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 4px 0;
  padding: 6px 2px;
  background: none;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  color: #8d89a1;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.activity-summary:hover {
  color: #b0acc2;
}
.label {
  flex: 1;
}
.chevron {
  font-size: 14px;
  color: #6f6b85;
  transition: transform 0.15s ease;
}
.chevron.open {
  transform: rotate(90deg);
}
</style>
