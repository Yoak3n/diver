<script setup lang="ts">
import type { PluginConfigView } from "../../../api";

defineProps<{
  pluginId: string;
  config: PluginConfigView;
  draft: Record<string, string | boolean>;
  busy?: boolean;
}>();

const emit = defineEmits<{
  save: [id: string];
}>();
</script>

<template>
  <div class="plugin-config">
    <div class="config-title">{{ config.title || pluginId }} 配置</div>
    <label v-for="f in config.fields" :key="f.key" class="config-field">
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
      <span v-if="f.description" class="config-desc">{{ f.description }}</span>
    </label>
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
