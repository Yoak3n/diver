<script setup lang="ts">
// 纸面开关：墨色选中，细轨道；保留原生 checkbox 的键盘语义。
const model = defineModel<boolean>({ default: false });

defineProps<{ id?: string; label?: string; disabled?: boolean }>();
</script>

<template>
  <label class="ui-switch" :class="{ 'ui-switch--disabled': disabled }">
    <input
      :id="id"
      v-model="model"
      type="checkbox"
      role="switch"
      :disabled="disabled"
    />
    <span class="ui-switch__track" aria-hidden="true">
      <span class="ui-switch__thumb" />
    </span>
    <span v-if="label" class="ui-switch__label">{{ label }}</span>
  </label>
</template>

<style scoped>
.ui-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  min-height: var(--control-h-sm);
}
.ui-switch input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.ui-switch__track {
  position: relative;
  flex: none;
  width: 36px;
  height: 20px;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius-pill);
  background: var(--paper-active);
  transition:
    background var(--dur-hover) ease,
    border-color var(--dur-hover) ease,
    box-shadow var(--dur-hover) ease;
}
.ui-switch__thumb {
  position: absolute;
  left: 2px;
  top: 2px;
  width: 14px;
  height: 14px;
  border: 1px solid var(--rule-strong);
  border-radius: 50%;
  background: var(--paper-raised);
  transition:
    transform var(--dur-ui) var(--ease-out),
    background var(--dur-hover) ease,
    border-color var(--dur-hover) ease;
}
.ui-switch input:checked + .ui-switch__track {
  background: var(--ink);
  border-color: var(--ink);
}
.ui-switch input:checked + .ui-switch__track .ui-switch__thumb {
  transform: translateX(16px);
  background: var(--paper);
  border-color: transparent;
}
.ui-switch input:focus-visible + .ui-switch__track {
  border-color: var(--accent-border);
  box-shadow: var(--focus-ring);
}
.ui-switch--disabled {
  opacity: 0.5;
  cursor: default;
}
.ui-switch__label {
  font-size: var(--text-base);
  color: var(--ink);
}
</style>
