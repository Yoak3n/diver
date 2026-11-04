<script setup lang="ts">
// 页面标题：设置页 / 插件页的顶部信息区。
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <header class="ui-page-head">
    <h1 class="ui-page-title">{{ title }}</h1>
    <p v-if="description" class="ui-page-desc">{{ description }}</p>
    <div v-if="$slots.default" class="ui-page-extra">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.ui-page-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: var(--space-2);
}
.ui-page-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.ui-page-desc {
  margin: 0;
  max-width: 68ch;
  font-size: var(--text-sm);
  line-height: 1.7;
  color: var(--ink-muted);
}
.ui-page-extra {
  margin-top: var(--space-2);
}
</style>
