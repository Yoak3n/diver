<script setup lang="ts">
// 基础按钮：variant × size，统一高度、焦点态与按压反馈。
withDefaults(
  defineProps<{
    variant?: "default" | "primary" | "ghost" | "danger";
    size?: "sm" | "md";
    type?: "button" | "submit";
    disabled?: boolean;
  }>(),
  { variant: "default", size: "md", type: "button", disabled: false },
);
</script>

<template>
  <button
    :type="type"
    class="ui-btn"
    :class="[`ui-btn--${variant}`, `ui-btn--${size}`]"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  background: var(--paper-raised);
  color: var(--ink);
  font-family: inherit;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--dur-hover) ease,
    border-color var(--dur-hover) ease,
    color var(--dur-hover) ease,
    transform var(--dur-press) var(--ease-out),
    opacity var(--dur-hover) ease;
}
.ui-btn--sm {
  height: var(--control-h-sm);
  padding: 0 10px;
  font-size: var(--text-sm);
  border-radius: var(--radius-sm);
}
.ui-btn--md {
  height: var(--control-h);
  padding: 0 14px;
  font-size: var(--text-base);
}
.ui-btn--primary {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--paper);
}
.ui-btn--ghost {
  background: transparent;
  border-color: var(--rule);
  color: var(--ink-soft);
}
.ui-btn--danger {
  background: transparent;
  border-color: var(--err-border);
  color: var(--err);
}
@media (hover: hover) and (pointer: fine) {
  .ui-btn--default:hover:not(:disabled),
  .ui-btn--ghost:hover:not(:disabled) {
    background: var(--paper-hover);
  }
  .ui-btn--primary:hover:not(:disabled) {
    opacity: 0.88;
  }
  .ui-btn--danger:hover:not(:disabled) {
    background: var(--err-soft);
  }
}
.ui-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.ui-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
