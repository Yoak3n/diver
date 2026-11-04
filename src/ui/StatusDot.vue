<script setup lang="ts">
// 状态点：列表行 / 连接状态前的极简指示。
withDefaults(
  defineProps<{ tone?: "idle" | "ok" | "warn" | "err"; pulse?: boolean }>(),
  { tone: "idle", pulse: false },
);
</script>

<template>
  <span
    class="ui-dot"
    :class="[`ui-dot--${tone}`, { 'ui-dot--pulse': pulse }]"
    aria-hidden="true"
  />
</template>

<style scoped>
.ui-dot {
  display: inline-block;
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-dim);
}
.ui-dot--ok {
  background: var(--ok);
}
.ui-dot--warn {
  background: var(--warn);
}
.ui-dot--err {
  background: var(--err);
}
.ui-dot--pulse {
  animation: ui-dot-pulse 1.2s ease infinite;
}
@keyframes ui-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
