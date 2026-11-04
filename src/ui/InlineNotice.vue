<script setup lang="ts">
// 行内提示：成功 / 失败 / 说明三种语气，替代散落的 .ok-msg / .error-msg。
withDefaults(defineProps<{ tone?: "ok" | "err" | "hint" }>(), {
  tone: "hint",
});
</script>

<template>
  <div
    class="ui-notice"
    :class="`ui-notice--${tone}`"
    :role="tone === 'err' ? 'alert' : 'status'"
  >
    <slot />
  </div>
</template>

<style scoped>
.ui-notice {
  padding: 8px 10px;
  border: 1px solid var(--rule);
  border-radius: var(--radius-sm);
  background: var(--paper-sunken);
  font-size: var(--text-sm);
  line-height: 1.55;
}
.ui-notice--ok {
  color: var(--ok);
  border-color: var(--ok);
  background: transparent;
}
.ui-notice--err {
  color: var(--err);
  border-color: var(--err-border);
  background: var(--err-soft);
}
.ui-notice--hint {
  color: var(--ink-muted);
}
</style>
