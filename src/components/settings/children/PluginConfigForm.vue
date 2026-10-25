<script setup lang="ts">
// 通用插件配置表单：字段与分组全部来自插件自己的 configDecl，本组件不认任何插件 id。
import { computed } from "vue";
import type { PluginConfigFieldView, PluginConfigView } from "../../../api";
import type { PluginConfigDraft } from "./pluginConfigValues";

const props = defineProps<{
  pluginId: string;
  config: PluginConfigView;
  draft: PluginConfigDraft;
  busy?: boolean;
}>();

const emit = defineEmits<{
  save: [id: string];
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
</script>

<template>
  <div class="plugin-config">
    <div class="config-title">{{ config.title || pluginId }} 配置</div>
    <template v-for="g in groups" :key="g.title">
      <div v-if="g.title" class="config-section">{{ g.title }}</div>
      <label v-for="f in g.fields" :key="f.key" class="config-field">
        <span class="config-label">{{ f.label }}</span>
        <input
          v-if="f.type === 'boolean'"
          type="checkbox"
          :checked="draft[f.key] === true || draft[f.key] === 'true'"
          @change="draft[f.key] = ($event.target as HTMLInputElement).checked"
        />
        <select
          v-else-if="f.type === 'select'"
          :value="draft[f.key]"
          @change="draft[f.key] = ($event.target as HTMLSelectElement).value"
        >
          <option v-for="opt in f.options || []" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <input
          v-else
          :type="f.type === 'password' || f.secret ? 'password' : f.type === 'number' ? 'number' : 'text'"
          :value="draft[f.key]"
          :placeholder="f.default != null ? String(f.default) : ''"
          @input="draft[f.key] = ($event.target as HTMLInputElement).value"
        />
        <span v-if="f.secret && f.configured" class="config-secret">
          <span v-if="draft[f.key] === null">保存后清除已存值</span>
          <span v-else-if="draft[f.key] === ''">已保存，留空保持不变</span>
          <span v-else>保存后替换</span>
          <button
            v-if="draft[f.key] !== null"
            type="button"
            class="config-clear"
            @click="draft[f.key] = null"
          >
            清除
          </button>
          <button v-else type="button" class="config-clear" @click="draft[f.key] = ''">
            取消清除
          </button>
        </span>
        <span v-if="f.description" class="config-desc">{{ f.description }}</span>
      </label>
    </template>
    <button class="btn" :disabled="busy" @click="emit('save', pluginId)">保存配置</button>
  </div>
</template>

<style scoped>
.plugin-config {
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper-raised);
}
.config-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--ink);
  margin-bottom: 0.5rem;
}
.config-section {
  margin: 14px 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
}
.config-section:first-of-type {
  margin-top: 8px;
}
.config-field {
  display: grid;
  grid-template-columns: 10rem 1fr;
  gap: 0.35rem 0.5rem;
  align-items: center;
  margin-bottom: 0.35rem;
  font-size: 0.9rem;
}
.config-label {
  color: var(--ink-soft);
  font-size: 12px;
}
.config-desc {
  grid-column: 2;
  font-size: 0.8rem;
  color: var(--ink-muted);
}
.config-secret {
  grid-column: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
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
.btn {
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  color: var(--ink);
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
