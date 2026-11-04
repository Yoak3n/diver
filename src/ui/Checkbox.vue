<script setup lang="ts">
// 基础复选框：自绘方框，保留原生 input 的键盘与表单语义。
const model = defineModel<boolean>({ default: false });

defineProps<{ id?: string; label?: string; disabled?: boolean }>();
</script>

<template>
  <label class="ui-checkbox" :class="{ 'ui-checkbox--disabled': disabled }">
    <input
      :id="id"
      v-model="model"
      type="checkbox"
      :disabled="disabled"
    />
    <span class="ui-checkbox__box" aria-hidden="true"></span>
    <span v-if="label || $slots.default" class="ui-checkbox__label">
      <slot>{{ label }}</slot>
    </span>
  </label>
</template>

<style scoped>
.ui-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-base);
  color: var(--ink);
  cursor: pointer;
  min-height: var(--control-h-sm);
}
.ui-checkbox input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.ui-checkbox__box {
  position: relative;
  flex: none;
  width: 16px;
  height: 16px;
  border: 1px solid var(--rule-strong);
  border-radius: 4px;
  background: var(--paper-raised);
  transition:
    background var(--dur-hover) ease,
    border-color var(--dur-hover) ease,
    box-shadow var(--dur-hover) ease;
}
.ui-checkbox input:checked + .ui-checkbox__box {
  background: var(--ink);
  border-color: var(--ink);
}
.ui-checkbox input:checked + .ui-checkbox__box::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid var(--paper);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
.ui-checkbox input:focus-visible + .ui-checkbox__box {
  border-color: var(--accent-border);
  box-shadow: var(--focus-ring);
}
.ui-checkbox--disabled {
  opacity: 0.5;
  cursor: default;
}
.ui-checkbox__label {
  min-width: 0;
  line-height: 1.45;
}
</style>
