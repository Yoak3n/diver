<script setup lang="ts">
// 通用插件配置表单：字段与分组全部来自插件自己的 configDecl，本组件不认任何插件 id。
// 渲染层使用基础组件（Field / Input / Select / Checkbox / Button），与产品设置页同一套视觉。
import { computed } from "vue";
import type { PluginConfigFieldView, PluginConfigView } from "../../api";
import { Button, Card, Checkbox, Field, Input, Select } from "../../ui";
import type { PluginConfigDraft } from "./config-values";

const props = defineProps<{
  config: PluginConfigView;
  draft: PluginConfigDraft;
  busy?: boolean;
}>();

const emit = defineEmits<{
  save: [];
}>();

interface FieldGroup {
  title: string;
  fields: PluginConfigFieldView[];
}

/** 同 section 合并成一组；组顺序按首次出现，组内保持声明顺序。 */
const groups = computed<FieldGroup[]>(() => {
  const out: FieldGroup[] = [];
  for (const field of props.config.fields) {
    const title = field.section?.trim() ?? "";
    let group = out.find((g) => g.title === title);
    if (!group) {
      group = { title, fields: [] };
      out.push(group);
    }
    group.fields.push(field);
  }
  return out;
});

function boolValue(key: string): boolean {
  return props.draft[key] === true || props.draft[key] === "true";
}

function textValue(key: string): string {
  const value = props.draft[key];
  return value === null || value === undefined ? "" : String(value);
}

function setValue(key: string, value: string | number | boolean | null): void {
  props.draft[key] = typeof value === "number" ? String(value) : value;
}

/**
 * 字段控件插槽的 setter：`#field-<key>` 自定义控件通过它写回草稿。
 * 只在插件声明了对应插槽时生效，通用表单本身不认任何插件 id。
 */
function fieldSetter(
  key: string,
): (value: string | number | boolean | null) => void {
  return (value) => setValue(key, value);
}
</script>

<template>
  <Card :title="`${config.title || '插件'} 配置`">
    <div class="config-groups">
      <template v-for="group in groups" :key="group.title">
        <div v-if="group.title" class="config-section">{{ group.title }}</div>
        <Field
          v-for="field in group.fields"
          :key="field.key"
          :label="field.label"
          :description="field.description"
          layout="horizontal"
        >
          <slot
            :name="`field-${field.key}`"
            :field="field"
            :value="textValue(field.key)"
            :set-value="fieldSetter(field.key)"
          >
            <Checkbox
              v-if="field.type === 'boolean'"
              :model-value="boolValue(field.key)"
              @update:model-value="setValue(field.key, $event)"
            />
            <Select
              v-else-if="field.type === 'select'"
              :model-value="textValue(field.key)"
              :options="field.options || []"
              @update:model-value="setValue(field.key, $event)"
            />
            <Input
              v-else
              :model-value="textValue(field.key)"
              :type="
                field.type === 'password' || field.secret
                  ? 'password'
                  : field.type === 'number'
                    ? 'number'
                    : 'text'
              "
              :placeholder="field.default != null ? String(field.default) : ''"
              @update:model-value="setValue(field.key, $event)"
            />
          </slot>
          <div v-if="field.secret && field.configured" class="config-secret">
            <span v-if="draft[field.key] === null">保存后清除已存值</span>
            <span v-else-if="draft[field.key] === ''">已保存，留空保持不变</span>
            <span v-else>保存后替换</span>
            <button
              v-if="draft[field.key] !== null"
              type="button"
              class="config-clear"
              @click="setValue(field.key, null)"
            >
              清除
            </button>
            <button
              v-else
              type="button"
              class="config-clear"
              @click="setValue(field.key, '')"
            >
              取消清除
            </button>
          </div>
        </Field>
      </template>
    </div>
    <div class="config-actions">
      <Button variant="primary" size="sm" :disabled="busy" @click="emit('save')">
        保存配置
      </Button>
    </div>
  </Card>
</template>

<style scoped>
.config-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.config-section {
  margin: 6px 0 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--ink);
}
.config-section:first-child {
  margin-top: 0;
}
.config-secret {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: var(--text-xs);
  color: var(--ink-dim);
}
.config-clear {
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}
.config-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-4);
}
</style>
