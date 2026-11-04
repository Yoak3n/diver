<script setup lang="ts">
// 空状态：无数据 / 未启用时的占位，可放一个操作按钮。
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="ui-empty">
    <div class="ui-empty__title">{{ title }}</div>
    <p v-if="description" class="ui-empty__desc">{{ description }}</p>
    <div v-if="$slots.default" class="ui-empty__action">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ui-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: var(--space-6) var(--space-4);
  border: 1px dashed var(--rule-strong);
  border-radius: var(--radius);
  text-align: center;
}
.ui-empty__title {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--ink-soft);
}
.ui-empty__desc {
  margin: 0;
  max-width: 42ch;
  font-size: var(--text-sm);
  color: var(--ink-dim);
  line-height: 1.6;
}
.ui-empty__action {
  margin-top: var(--space-2);
}
</style>
