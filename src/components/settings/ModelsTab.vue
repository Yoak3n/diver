<script setup lang="ts">
// 模型与提供商面板：提供商卡片（含自定义）+ 模型选择 + 动态配置表单。
// 自定义提供商（OpenAI 兼容）：加号入口 / 编辑 / 删除；身份热注册 ≤2s，
// 轮询刷新到卡片出现（或消失）为止，免手动刷新页面。
import { ref } from "vue";
import type { ProviderConfigDecl } from "../../types";
import type { SettingsState } from "../../composables/useSettings";
import { useSettings } from "../../composables/useSettings";
import {
  removeCustomProvider,
  type CustomProviderIdentity,
} from "../../api";
import CustomProviderForm from "./CustomProviderForm.vue";

const props = defineProps<{
  state: SettingsState;
  providerDecls: ProviderConfigDecl[];
  currentProviderDecl: ProviderConfigDecl | undefined;
  currentProviderModels: { provider: string; id: string }[];
}>();

const { openSettings } = useSettings();

const showForm = ref(false);
const editing = ref<
  { id: string; name: string; baseUrl: string; models: string; apiKeyConfigured: boolean } | undefined
>(undefined);

/** 身份变更后 llm-custom 热重注册（≤2s）：轮询刷新直到卡片到位，免手动刷新。 */
async function refreshUntil(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await openSettings();
    if (check()) return;
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 400));
  }
}

function openAdd() {
  editing.value = undefined;
  showForm.value = true;
}

function openEdit(p: ProviderConfigDecl) {
  const val = (k: string) => p.fields.find((f) => f.key === k)?.value ?? "";
  editing.value = {
    id: p.provider,
    name: p.name,
    baseUrl: val("baseUrl"),
    models: val("models"),
    apiKeyConfigured: p.fields.find((f) => f.key === "apiKey")?.configured ?? false,
  };
  showForm.value = true;
}

async function onSaved(identity: CustomProviderIdentity) {
  showForm.value = false;
  editing.value = undefined;
  props.state.provider = identity.id;
  const first = props.providerDecls.find((p) => p.provider === identity.id);
  if (first === undefined || first.name !== identity.name) {
    await refreshUntil(
      () => props.providerDecls.some((p) => p.provider === identity.id && p.name === identity.name),
    );
  }
  const models = props.currentProviderModels;
  if (models.length > 0 && !models.some((m) => m.id === props.state.model)) {
    props.state.model = models[0].id;
  }
}

async function onDelete(p: ProviderConfigDecl) {
  if (!window.confirm(`删除自定义提供商「${p.name}」？其端点配置将一并清除。`)) return;
  await removeCustomProvider(p.provider);
  if (props.state.provider === p.provider) {
    props.state.provider = props.providerDecls.find((x) => x.provider !== p.provider)?.provider ?? "";
  }
  await refreshUntil(() => !props.providerDecls.some((x) => x.provider === p.provider));
}
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
        <span class="head-tags">
          <span v-if="p.custom" class="custom-badge">自定义</span>
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
        </span>
      </div>
      <p class="provider-desc">{{ p.description }}</p>
    </button>
  </div>

  <button v-if="!showForm" class="add-provider" type="button" @click="openAdd">＋ 添加模型提供商</button>
  <CustomProviderForm
    v-else
    :initial="editing"
    @saved="onSaved"
    @cancel="showForm = false"
  />

  <label class="group-title">模型</label>
  <select v-model="state.model" class="model-select">
    <option v-for="m in currentProviderModels" :key="m.id" :value="m.id">{{ m.id }}</option>
  </select>

  <template v-if="currentProviderDecl">
    <label class="group-title">{{ currentProviderDecl.name }} 配置</label>
    <div class="config-card">
      <div v-if="currentProviderDecl.custom" class="custom-actions">
        <button class="ghost-btn" type="button" @click="openEdit(currentProviderDecl)">编辑身份</button>
        <button class="ghost-btn danger" type="button" @click="onDelete(currentProviderDecl)">删除提供商</button>
      </div>
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
.head-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.custom-badge {
  font-size: 10px;
  color: var(--ink-muted);
  border: 1px solid var(--rule-strong);
  border-radius: 999px;
  padding: 1px 6px;
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
.add-provider {
  margin-top: 8px;
  width: 100%;
  background: transparent;
  border: 1px dashed var(--rule-strong);
  border-radius: var(--radius);
  color: var(--ink-soft);
  padding: 9px 12px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: background var(--dur-hover) ease;
}
@media (hover: hover) and (pointer: fine) {
  .add-provider:hover {
    background: var(--paper-hover);
  }
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
.custom-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}
.ghost-btn {
  background: transparent;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  color: var(--ink-soft);
  padding: 5px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.ghost-btn.danger {
  color: var(--err);
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
