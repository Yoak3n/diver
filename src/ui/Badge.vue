<script setup lang="ts">
// 状态标签：用于「已启用 / 缺失 / 实验性」这类短状态。
withDefaults(
  defineProps<{ tone?: "neutral" | "ok" | "warn" | "err" | "accent" }>(),
  { tone: "neutral" },
);
</script>

<template>
  <span class="ui-badge" :class="`ui-badge--${tone}`">
    <slot />
  </span>
</template>

<style scoped>
.ui-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius-pill);
  background: transparent;
  font-size: var(--text-xs);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.ui-badge--neutral {
  color: var(--ink-muted);
}
.ui-badge--ok {
  color: var(--ok);
  border-color: var(--ok);
}
.ui-badge--warn {
  color: var(--warn);
  border-color: var(--warn);
}
.ui-badge--err {
  color: var(--err);
  border-color: var(--err-border);
}
.ui-badge--accent {
  color: var(--accent);
  border-color: var(--accent-border);
}
</style>
