<script setup lang="ts">
import type { ProviderConfigDecl } from "../../types";
import type { SettingsState } from "../../composables/useSettings";

defineProps<{
  state: SettingsState;
  providerDecls: ProviderConfigDecl[];
  currentProviderDecl: ProviderConfigDecl | undefined;
  currentProviderModels: { provider: string; id: string }[];
}>();
</script>

<template>
  <label class="group-title">提供商</label>
  <div class="provider-grid">
    <button
      v-for="p in providerDecls"
      :key="p.provider"
      class="provider-card"
      :class="{ active: state.provider === p.provider }"
      @click="state.provider = p.provider"
    >
      <div class="provider-card-head">
        <span class="provider-name">{{ p.name }}</span>
        <span
          class="provider-dot"
          :class="
            p.fields.some((f) => f.secret && f.required)
              ? p.fields.some((f) => f.secret && f.required && f.configured)
                ? 'on'
                : 'off'
              : 'on'
          "
        ></span>
      </div>
      <p class="provider-desc">{{ p.description }}</p>
    </button>
  </div>

  <label class="group-title">模型</label>
  <select v-model="state.model" class="model-select">
    <option v-for="m in currentProviderModels" :key="m.id" :value="m.id">{{ m.id }}</option>
  </select>

  <template v-if="currentProviderDecl">
    <label class="group-title">{{ currentProviderDecl.name }} 配置</label>
    <div class="config-card">
      <template v-for="f in currentProviderDecl.fields" :key="f.key">
        <label class="field-label">{{ f.label }}</label>
        <input
          v-if="f.type === 'password'"
          v-model="state.configInputs[currentProviderDecl.provider][f.key]"
          type="password"
          :placeholder="f.configured ? '已配置，留空不修改' : (f.placeholder ?? '')"
          autocomplete="off"
        />
        <input
          v-else
          v-model="state.configInputs[currentProviderDecl.provider][f.key]"
          type="text"
          :placeholder="f.placeholder ?? ''"
        />
        <p class="hint">
          {{ f.hint ?? "" }}
          <template v-if="f.secret">
            · {{ f.configured ? "已配置 ✓" : "未配置" }}
          </template>
          <template v-else-if="f.store === 'settings'">
            · 当前：{{
              (state.configInputs[currentProviderDecl.provider][f.key] ?? f.value ?? "") || "默认"
            }}
          </template>
        </p>
      </template>
    </div>
  </template>
</template>

<style scoped>
.provider-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.provider-card {
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  padding: 12px 14px;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  color: var(--ink);
  transition:
    transform var(--dur-press) var(--ease-out),
    border-color var(--dur-hover) ease,
    background var(--dur-hover) ease;
}
@media (hover: hover) and (pointer: fine) {
  .provider-card:hover {
    background: var(--paper-hover);
  }
}
.provider-card:active {
  transform: scale(0.98);
}
.provider-card.active {
  border-color: var(--ink);
  background: var(--paper-active);
}
.provider-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.provider-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.provider-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-dim);
  flex-shrink: 0;
}
.provider-dot.on {
  background: var(--ok);
}
.provider-dot.off {
  background: var(--err);
}
.provider-desc {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--ink-muted);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.config-card {
  background: transparent;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  margin-top: 4px;
  font-size: 13px;
  color: var(--ink-soft);
}
.model-select {
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  color: var(--ink);
  padding: 8px 11px;
  font-size: 13px;
  outline: none;
  font-family: inherit;
}
</style>
