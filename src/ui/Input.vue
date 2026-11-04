<script setup lang="ts">
// 基础输入框：统一高度、边框、焦点环。
const model = defineModel<string | number>({ default: "" });

withDefaults(
  defineProps<{
    id?: string;
    type?: string;
    placeholder?: string;
    disabled?: boolean;
    autocomplete?: string;
    size?: "sm" | "md";
  }>(),
  { type: "text", disabled: false, size: "md" },
);
</script>

<template>
  <input
    :id="id"
    v-model="model"
    class="ui-input"
    :class="`ui-input--${size}`"
    :type="type"
    :placeholder="placeholder"
    :disabled="disabled"
    :autocomplete="autocomplete"
  />
</template>

<style scoped>
.ui-input {
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
  transition:
    border-color var(--dur-hover) ease,
    box-shadow var(--dur-hover) ease,
    opacity var(--dur-hover) ease;
}
.ui-input--sm {
  height: var(--control-h-sm);
  padding: 0 8px;
  font-size: var(--text-sm);
  border-radius: var(--radius-sm);
}
.ui-input::placeholder {
  color: var(--ink-faint);
}
.ui-input:focus {
  border-color: var(--accent-border);
  box-shadow: var(--focus-ring);
}
.ui-input:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
