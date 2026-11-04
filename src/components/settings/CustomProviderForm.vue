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
import { Button, Card, Field, InlineNotice, Input } from "../../plugin-ui";

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
  <Card :title="initial === undefined ? '添加模型提供商' : '编辑模型提供商'">
    <div class="custom-form">
      <Field label="名称">
        <Input v-model="form.name" placeholder="我的中转 / 自建网关…" />
      </Field>
      <Field label="API Base URL">
        <Input v-model="form.baseUrl" placeholder="https://api.openai.com/v1" />
      </Field>
      <Field label="API Key">
        <Input
          v-model="form.apiKey"
          type="password"
          autocomplete="off"
          :placeholder="initial?.apiKeyConfigured ? '已配置，留空不修改' : 'sk-…'"
        />
      </Field>
      <Field label="模型 ID 列表">
        <div class="models-row">
          <Input
            v-model="form.models"
            class="models-input"
            size="sm"
            placeholder="gpt-4o-mini, gpt-4o"
          />
          <Button size="sm" :disabled="fetching" @click="fetchModels">
            {{ fetching ? "拉取中…" : "拉取模型" }}
          </Button>
        </div>
      </Field>
      <p class="hint">
        逗号分隔；OpenAI 兼容协议（chat/completions）。保存后热生效（≤2s）。
        <template v-if="fetchedNote !== ''">· {{ fetchedNote }}</template>
      </p>

      <InlineNotice v-if="error !== ''" tone="err">{{ error }}</InlineNotice>

      <div class="form-actions">
        <Button variant="primary" size="sm" :disabled="busy" @click="save">
          {{ busy ? "保存中…" : "保存" }}
        </Button>
        <Button size="sm" :disabled="busy" @click="emit('cancel')">取消</Button>
      </div>
    </div>
  </Card>
</template>

<style scoped>
.custom-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.models-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.models-input {
  flex: 1;
}
.form-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
</style>
