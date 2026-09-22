<script setup lang="ts">
// 桌宠形象模型选择器（设置页 / 桌宠面板共用）
import type { PetModelProfile } from "../pet/models";

const props = withDefaults(
  defineProps<{
    models: PetModelProfile[];
    activeId: string;
    switching?: boolean;
    compact?: boolean;
  }>(),
  { switching: false, compact: false },
);

const emit = defineEmits<{ select: [id: string] }>();

function onPick(id: string) {
  if (props.switching || id === props.activeId) return;
  emit("select", id);
}
</script>

<template>
  <div class="pet-model-picker" :class="{ compact }">
    <button
      v-for="m in models"
      :key="m.id"
      type="button"
      class="model-card"
      :class="{ active: m.id === activeId, busy: switching }"
      :disabled="switching"
      :title="m.note || m.installHint || m.label"
      @click="onPick(m.id)"
    >
      <div class="model-card-top">
        <span class="model-name">{{ m.label }}</span>
        <span v-if="m.id === activeId" class="model-badge">使用中</span>
        <span v-else-if="switching" class="model-badge dim">…</span>
      </div>
      <p v-if="m.note" class="model-note">{{ m.note }}</p>
      <p v-else-if="m.installHint" class="model-note dim">{{ m.installHint }}</p>
    </button>
  </div>
</template>

<style scoped>
.pet-model-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.model-card {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  padding: 12px 14px;
  cursor: pointer;
  font-family: inherit;
  color: var(--ink);
  transition: background var(--dur-hover) ease, border-color var(--dur-hover) ease;
}
@media (hover: hover) and (pointer: fine) {
  .model-card:hover:not(:disabled) {
    background: var(--paper-hover);
  }
}
.model-card.active {
  border-color: var(--ink);
  background: var(--paper-active);
}
.model-card:disabled {
  cursor: wait;
  opacity: 0.7;
}
.model-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.model-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
}
.model-badge {
  font-size: 11px;
  color: var(--ink);
  background: var(--paper-active);
  border: 1px solid var(--rule);
  border-radius: var(--radius-pill);
  padding: 2px 8px;
  flex-shrink: 0;
}
.model-badge.dim {
  color: var(--ink-dim);
  background: transparent;
}
.model-note {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--ink-muted);
}
.model-note.dim {
  color: var(--ink-dim);
}
.compact .model-card {
  padding: 10px 12px;
}
.compact .model-name {
  font-size: 12px;
}
.compact .model-note {
  font-size: 10px;
}
</style>
