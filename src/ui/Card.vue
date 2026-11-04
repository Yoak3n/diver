<script setup lang="ts">
// 基础卡片：纸面抬升层，可选标题与描述。
withDefaults(
  defineProps<{ title?: string; description?: string; padded?: boolean }>(),
  { padded: true },
);
</script>

<template>
  <section class="ui-card" :class="{ 'ui-card--flush': !padded }">
    <header v-if="title || description" class="ui-card__head">
      <h3 v-if="title" class="ui-card__title">{{ title }}</h3>
      <p v-if="description" class="ui-card__desc">{{ description }}</p>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.ui-card {
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper-raised);
  padding: var(--space-4);
}
.ui-card--flush {
  padding: 0;
}
.ui-card__head {
  margin-bottom: var(--space-3);
}
.ui-card__title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--ink);
  letter-spacing: -0.01em;
}
.ui-card__desc {
  margin: 4px 0 0;
  font-size: var(--text-sm);
  color: var(--ink-muted);
  line-height: 1.6;
}
</style>
