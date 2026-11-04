<script setup lang="ts">
// 区块标题：设置页内的一级分组（比 PageHeader 低一层，比 group-title 高一层）。
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="ui-section-head">
    <h2 class="ui-section-title">{{ title }}</h2>
    <p v-if="description" class="ui-section-desc">{{ description }}</p>
  </div>
</template>

<style scoped>
.ui-section-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: var(--space-4) 0 var(--space-2);
}
.ui-section-head:first-child {
  margin-top: 0;
}
.ui-section-title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--ink);
  letter-spacing: -0.01em;
}
.ui-section-desc {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--ink-muted);
  line-height: 1.6;
}
</style>
