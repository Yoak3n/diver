<script setup lang="ts">
// 模型与提供商面板：默认只常驻 DeepSeek 官方；其余提供商经「添加模型提供商」
// 下拉选择（已注册适配器 + 自定义）后进入卡片区，列表落 diver-settings.json。
// 卡片点击切换激活 provider，模型与配置区跟随当前 provider。
import { computed, ref } from "vue";
import type { ConfigFieldDecl, ProviderConfigDecl } from "../../types";
import type { SettingsState } from "../../composables/useSettings";
import { addProviderCard, removeProviderCard, useSettings } from "../../composables/useSettings";
import {
  removeCustomProvider,
  type CustomProviderIdentity,
} from "../../api";
import { Button, Card, Field, Input, SectionTitle, Select } from "../../plugin-ui";
import AddProviderPanel from "./children/AddProviderPanel.vue";
import ProviderCard from "./children/ProviderCard.vue";
import { addableProviderDecls, canRemoveProvider, visibleProviderDecls } from "./provider-cards";
import CustomProviderForm from "./CustomProviderForm.vue";

const props = defineProps<{
  state: SettingsState;
  providerDecls: ProviderConfigDecl[];
  currentProviderDecl: ProviderConfigDecl | undefined;
  currentProviderModels: { provider: string; id: string }[];
}>();

const { openSettings, settingsInfo } = useSettings();

const modelOptions = computed(() =>
  props.currentProviderModels.map((model) => ({
    value: model.id,
    label: model.id,
  })),
);

/** 卡片区：默认项 ∪ 已添加 ∪ 自定义身份 ∪ 当前激活项。 */
const visibleProviders = computed(() =>
  visibleProviderDecls(props.providerDecls, props.state.providerCards, props.state.provider),
);

/** 「添加」下拉：尚未显示的适配器（自定义走单独入口）。 */
const addableProviders = computed(() =>
  addableProviderDecls(props.providerDecls, props.state.providerCards, props.state.provider),
);

/** 必填 secret 未配置 = 红点；没有必填 secret 或已配置 = 绿点。 */
function providerTone(provider: ProviderConfigDecl): "ok" | "err" {
  const requiredSecrets = provider.fields.filter(
    (field) => field.secret && field.required,
  );
  if (requiredSecrets.length === 0) return "ok";
  return requiredSecrets.every((field) => field.configured) ? "ok" : "err";
}

/** 字段说明：原 hint + secret/settings 的当前状态。 */
function fieldHint(field: ConfigFieldDecl): string {
  const provider = props.currentProviderDecl?.provider;
  if (provider === undefined) return field.hint ?? "";
  const base = field.hint ?? "";
  if (field.secret) {
    return [base, field.configured ? "已配置 ✓" : "未配置"]
      .filter(Boolean)
      .join(" · ");
  }
  if (field.store === "settings") {
    const current =
      props.state.configInputs[provider][field.key] ?? field.value ?? "";
    return [base, `当前：${current || "默认"}`].filter(Boolean).join(" · ");
  }
  return base;
}

const showAdd = ref(false);
const showForm = ref(false);
const editing = ref<
  { id: string; name: string; baseUrl: string; models: string; apiKeyConfigured: boolean } | undefined
>(undefined);

/** 某 provider 的模型目录（同步读取，切 provider 后立刻对齐模型）。 */
function modelsOf(provider: string): string[] {
  return (settingsInfo.value?.models ?? [])
    .filter((model) => model.provider === provider)
    .map((model) => model.id);
}

/** 切换激活 provider，并把模型对齐到它的目录，避免保存出无效组合。 */
function selectProvider(provider: string) {
  props.state.provider = provider;
  const models = modelsOf(provider);
  if (models.length > 0 && !models.includes(props.state.model)) {
    props.state.model = models[0];
  }
}

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

async function onAdd(provider: string) {
  await addProviderCard(provider);
  selectProvider(provider);
  showAdd.value = false;
}

async function onRemove(decl: ProviderConfigDecl) {
  await removeProviderCard(decl.provider);
}

function startCustom() {
  showAdd.value = false;
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
  await refreshUntil(() => {
    const decl = props.providerDecls.find((p) => p.provider === identity.id);
    return decl !== undefined && decl.name === identity.name;
  });
  selectProvider(identity.id);
}

async function onDelete(p: ProviderConfigDecl) {
  if (!window.confirm(`删除自定义提供商「${p.name}」？其端点配置将一并清除。`)) return;
  await removeCustomProvider(p.provider);
  if (props.state.providerCards.includes(p.provider)) {
    await removeProviderCard(p.provider);
  }
  if (props.state.provider === p.provider) {
    const fallback =
      props.providerDecls.find((x) => x.provider === "deepseek-official") ??
      props.providerDecls.find((x) => x.provider !== p.provider);
    if (fallback !== undefined) selectProvider(fallback.provider);
  }
  await refreshUntil(() => !props.providerDecls.some((x) => x.provider === p.provider));
}
</script>

<template>
  <SectionTitle title="提供商" />
  <div class="provider-grid">
    <ProviderCard
      v-for="p in visibleProviders"
      :key="p.provider"
      :decl="p"
      :active="state.provider === p.provider"
      :removable="canRemoveProvider(p, state.provider)"
      :tone="providerTone(p)"
      @select="selectProvider(p.provider)"
      @remove="onRemove(p)"
    />
  </div>

  <AddProviderPanel
    v-if="showAdd"
    :options="addableProviders"
    @add="onAdd"
    @custom="startCustom"
    @cancel="showAdd = false"
  />
  <CustomProviderForm
    v-else-if="showForm"
    :initial="editing"
    @saved="onSaved"
    @cancel="showForm = false"
  />
  <Button v-else variant="ghost" class="add-provider" @click="showAdd = true">
    ＋ 添加模型提供商
  </Button>

  <SectionTitle title="模型" />
  <Select v-model="state.model" :options="modelOptions" />

  <template v-if="currentProviderDecl">
    <SectionTitle :title="`${currentProviderDecl.name} 配置`" />
    <Card>
      <div v-if="currentProviderDecl.custom" class="custom-actions">
        <Button variant="ghost" size="sm" @click="openEdit(currentProviderDecl)">
          编辑身份
        </Button>
        <Button variant="danger" size="sm" @click="onDelete(currentProviderDecl)">
          删除提供商
        </Button>
      </div>
      <div class="config-fields">
        <Field
          v-for="field in currentProviderDecl.fields"
          :key="field.key"
          :label="field.label"
          :description="fieldHint(field)"
        >
          <Input
            v-model="state.configInputs[currentProviderDecl.provider][field.key]"
            :type="field.type === 'password' ? 'password' : 'text'"
            :placeholder="
              field.type === 'password' && field.configured
                ? '已配置，留空不修改'
                : (field.placeholder ?? '')
            "
            :autocomplete="field.type === 'password' ? 'off' : undefined"
          />
        </Field>
      </div>
    </Card>
  </template>
</template>

<style scoped>
.provider-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.add-provider {
  width: 100%;
  justify-content: flex-start;
  border-style: dashed;
  margin-top: 8px;
}
.config-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.custom-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
</style>
