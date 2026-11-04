<script setup lang="ts">
// 方形图标按钮：必须提供 aria-label。
withDefaults(
  defineProps<{ label: string; size?: "sm" | "md"; disabled?: boolean }>(),
  { size: "md", disabled: false },
);
</script>

<template>
  <button
    type="button"
    class="ui-icon-btn"
    :class="`ui-icon-btn--${size}`"
    :aria-label="label"
    :title="label"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.ui-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink-muted);
  cursor: pointer;
  transition:
    background var(--dur-hover) ease,
    color var(--dur-hover) ease,
    transform var(--dur-press) var(--ease-out);
}
.ui-icon-btn--md {
  width: 32px;
  height: 32px;
  font-size: 15px;
}
.ui-icon-btn--sm {
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  font-size: 13px;
}
@media (hover: hover) and (pointer: fine) {
  .ui-icon-btn:hover:not(:disabled) {
    background: var(--paper-hover);
    color: var(--ink);
  }
}
.ui-icon-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.ui-icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
