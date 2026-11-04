<script setup lang="ts">
// 表单字段：标签 / 控件 / 说明 / 错误四段式。
// horizontal 用于设置页的「标签列 + 控件列」布局。
withDefaults(
  defineProps<{
    label?: string;
    description?: string;
    error?: string;
    htmlFor?: string;
    layout?: "vertical" | "horizontal";
  }>(),
  { layout: "vertical" },
);
</script>

<template>
  <div class="ui-field" :class="`ui-field--${layout}`">
    <label v-if="label" class="ui-field__label" :for="htmlFor">
      {{ label }}
    </label>
    <div class="ui-field__control">
      <slot />
    </div>
    <p v-if="description" class="ui-field__desc">{{ description }}</p>
    <p v-if="error" class="ui-field__error">{{ error }}</p>
  </div>
</template>

<style scoped>
.ui-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.ui-field__label {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--ink-soft);
  line-height: 1.45;
}
.ui-field__control {
  min-width: 0;
}
.ui-field__desc {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--ink-dim);
  line-height: 1.55;
}
.ui-field__error {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--err);
  line-height: 1.55;
}
.ui-field--horizontal {
  display: grid;
  grid-template-columns: 10rem minmax(0, 1fr);
  gap: 6px 12px;
  align-items: center;
}
.ui-field--horizontal .ui-field__desc,
.ui-field--horizontal .ui-field__error {
  grid-column: 2;
}
</style>
