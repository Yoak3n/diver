<script setup lang="ts">
// 基础下拉框：选项由调用方给出，保持与 Input 同高。
const model = defineModel<string>({ default: "" });

defineProps<{
  id?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  size?: "sm" | "md";
}>();
</script>

<template>
  <select
    :id="id"
    v-model="model"
    class="ui-select"
    :class="`ui-select--${size ?? 'md'}`"
    :disabled="disabled"
  >
    <option
      v-for="option in options"
      :key="option.value"
      :value="option.value"
    >
      {{ option.label }}
    </option>
  </select>
</template>

<style scoped>
.ui-select {
  width: 100%;
  height: var(--control-h);
  padding: 0 var(--control-px);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  background: var(--paper-raised);
  color: var(--ink);
  font-family: inherit;
  font-size: var(--text-base);
  outline: none;
  cursor: pointer;
  transition:
    border-color var(--dur-hover) ease,
    box-shadow var(--dur-hover) ease,
    opacity var(--dur-hover) ease;
}
.ui-select--sm {
  height: var(--control-h-sm);
  padding: 0 8px;
  font-size: var(--text-sm);
  border-radius: var(--radius-sm);
}
.ui-select:focus {
  border-color: var(--accent-border);
  box-shadow: var(--focus-ring);
}
.ui-select:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
