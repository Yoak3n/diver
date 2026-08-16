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
  <template v-if="state.activeTab === 'models'">
    <!-- 提供商卡片选择 -->
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

    <!-- 模型选择（与当前提供商联动） -->
    <label class="group-title">模型</label>
    <select v-model="state.model" class="model-select">
      <option v-for="m in currentProviderModels" :key="m.id" :value="m.id">{{ m.id }}</option>
    </select>

    <!-- 当前提供商配置（插件声明驱动） -->
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
          </p>
        </template>
      </div>
    </template>
  </template>
</template>

<style scoped>
.group-title {
  display: block;
  font-size: 12px;
  color: #8d89a1;
  letter-spacing: 1px;
  margin-top: 4px;
}
.provider-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.provider-card {
  background: #141420;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  color: #e8e6f0;
  transition: border-color 0.15s, background 0.15s;
}
.provider-card:hover {
  border-color: rgba(255, 176, 124, 0.35);
}
.provider-card.active {
  border-color: #ffb07c;
  background: rgba(255, 176, 124, 0.08);
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
}
.provider-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6f6b85;
  flex-shrink: 0;
}
.provider-dot.on {
  background: #59d99a;
}
.provider-dot.off {
  background: #d35d5d;
}
.provider-desc {
  margin: 6px 0 0;
  font-size: 11px;
  color: #8d89a1;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.config-card {
  background: rgba(20, 20, 32, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field-label {
  margin-top: 4px;
  font-size: 13px;
  color: #b9b5cc;
}
.model-select {
  background: #141420;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  color: #e8e6f0;
  padding: 9px 12px;
  font-size: 13px;
  outline: none;
  font-family: inherit;
}
.hint {
  font-size: 11px;
  color: #6f6b85;
  margin: 0;
}
.modal-body input[type="password"],
.modal-body input[type="text"],
.modal-body select {
  background: #141420;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  color: #e8e6f0;
  padding: 9px 12px;
  font-size: 13px;
  outline: none;
  font-family: inherit;
  width: 100%;
}
</style>
