<script setup lang="ts">
// 添加提供商：下拉选择已注册的适配器，或走「自定义（OpenAI 兼容端点）」。
// 只负责选择与抛出事件，添加后的持久化/切换由 ModelsTab 处理。
import { computed, ref } from "vue";
import type { ProviderConfigDecl } from "../../../types";
import { Button, Field, Select } from "../../../plugin-ui";

/** 下拉里「自定义」的哨兵值（不会与真实 provider id 冲突）。 */
const CUSTOM_VALUE = "__custom__";

const props = defineProps<{
  /** 可添加的适配器（尚未显示、非自定义身份）。 */
  options: ProviderConfigDecl[];
}>();

const emit = defineEmits<{
  add: [provider: string];
  custom: [];
  cancel: [];
}>();

const choice = ref(props.options[0]?.provider ?? CUSTOM_VALUE);
const selectOptions = computed(() => [
  ...props.options.map((decl) => ({ value: decl.provider, label: decl.name })),
  { value: CUSTOM_VALUE, label: "自定义（任意 OpenAI 兼容端点）" },
]);

function confirm() {
  if (choice.value === CUSTOM_VALUE) emit("custom");
  else emit("add", choice.value);
}
</script>

<template>
  <div class="add-panel">
    <Field
      label="选择提供商"
      description="已支持的提供商直接添加；自定义可接任意 OpenAI 兼容端点。"
    >
      <Select v-model="choice" :options="selectOptions" />
    </Field>
    <div class="add-actions">
      <Button variant="primary" size="sm" @click="confirm">添加</Button>
      <Button variant="ghost" size="sm" @click="$emit('cancel')">取消</Button>
    </div>
  </div>
</template>

<style scoped>
.add-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
  padding: 12px 14px;
  border: 1px dashed var(--rule-strong);
  border-radius: var(--radius);
}
.add-actions {
  display: flex;
  gap: 8px;
}
</style>
