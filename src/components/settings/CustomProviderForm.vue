<script setup lang="ts">
// 自定义模型提供商表单（新增 / 编辑身份与端点配置）。
// 配置值经 /api/custom-providers 落盘：baseUrl/models 入 diver-settings、
// apiKey 入 secrets；llm-custom 热重注册（≤2s）后出现在提供商列表。
import { reactive, ref } from "vue";
import {
  fetchCustomProviderModels,
  saveCustomProvider,
  type CustomProviderIdentity,
} from "../../api";

const props = defineProps<{
  /** 编辑模式初始值；缺省 = 新增。 */
  initial?: {
    id: string;
    name: string;
    baseUrl: string;
    models: string;
    apiKeyConfigured: boolean;
  };
}>();

const emit = defineEmits<{
  saved: [provider: CustomProviderIdentity];
  cancel: [];
}>();

const form = reactive({
  name: props.initial?.name ?? "",
  baseUrl: props.initial?.baseUrl ?? "",
  apiKey: "",
  models: props.initial?.models ?? "",
});
const busy = ref(false);
const fetching = ref(false);
const error = ref("");
const fetchedNote = ref("");

async function fetchModels() {
  if (form.baseUrl.trim() === "") {
    error.value = "先填 API Base URL 再拉取模型";
    return;
  }
  fetching.value = true;
  error.value = "";
  fetchedNote.value = "";
  try {
    const { models } = await fetchCustomProviderModels(form.baseUrl, form.apiKey || undefined);
    if (models.length === 0) {
      error.value = "端点没有返回模型";
      return;
    }
    form.models = models.join(", ");
    fetchedNote.value = `已拉取 ${models.length} 个模型`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    fetching.value = false;
  }
}

async function save() {
  const name = form.name.trim();
  const baseUrl = form.baseUrl.trim();
  const models = form.models.trim();
  if (name === "" || baseUrl === "" || models === "") {
    error.value = "名称、API Base URL、模型 ID 列表均为必填";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const res = await saveCustomProvider({
      action: props.initial === undefined ? "add" : "update",
      ...(props.initial === undefined ? {} : { id: props.initial.id }),
      name,
      baseUrl,
      models,
      ...(form.apiKey.trim() === "" ? {} : { apiKey: form.apiKey.trim() }),
    });
    emit("saved", res.provider);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="custom-form">
    <label class="field-label">{{ initial === undefined ? "添加模型提供商" : "编辑模型提供商" }}</label>

    <label class="field-label">名称</label>
    <input v-model="form.name" type="text" placeholder="我的中转 / 自建网关…" />

    <label class="field-label">API Base URL</label>
    <input v-model="form.baseUrl" type="text" placeholder="https://api.openai.com/v1" />

    <label class="field-label">API Key</label>
    <input
      v-model="form.apiKey"
      type="password"
      autocomplete="off"
      :placeholder="initial?.apiKeyConfigured ? '已配置，留空不修改' : 'sk-…'"
    />

    <label class="field-label">模型 ID 列表</label>
    <div class="models-row">
      <input v-model="form.models" type="text" placeholder="gpt-4o-mini, gpt-4o" />
      <button class="form-btn" type="button" :disabled="fetching" @click="fetchModels">
        {{ fetching ? "拉取中…" : "拉取模型" }}
      </button>
    </div>
    <p class="hint">
      逗号分隔；OpenAI 兼容协议（chat/completions）。保存后热生效（≤2s）。
      <template v-if="fetchedNote !== ''">· {{ fetchedNote }}</template>
    </p>

    <p v-if="error !== ''" class="form-error">{{ error }}</p>

    <div class="form-actions">
      <button class="form-btn primary" type="button" :disabled="busy" @click="save">
        {{ busy ? "保存中…" : "保存" }}
      </button>
      <button class="form-btn" type="button" :disabled="busy" @click="emit('cancel')">取消</button>
    </div>
  </div>
</template>

<style scoped>
.custom-form {
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--paper-raised);
}
.custom-form input {
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  color: var(--ink);
  padding: 8px 11px;
  font-size: 13px;
  outline: none;
  font-family: inherit;
}
.field-label {
  margin-top: 4px;
  font-size: 13px;
  color: var(--ink-soft);
}
.models-row {
  display: flex;
  gap: 8px;
}
.models-row input {
  flex: 1;
}
.form-btn {
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  color: var(--ink);
  padding: 8px 14px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.form-btn.primary {
  background: var(--ink);
  color: var(--paper);
  border-color: var(--ink);
}
.form-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.form-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.hint {
  margin: 0;
  font-size: 11px;
  color: var(--ink-muted);
  line-height: 1.5;
}
.form-error {
  margin: 0;
  font-size: 11px;
  color: var(--err);
}
</style>
