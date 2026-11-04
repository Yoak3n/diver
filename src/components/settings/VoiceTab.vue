<script setup lang="ts">
import { computed, toRef } from "vue";
import type { SettingsState } from "../../composables/useSettings";
import { tauriAvailable } from "../../tauri";
import {
  Button,
  Field,
  InlineNotice,
  Input,
  PageHeader,
  Select,
  Switch,
} from "../../plugin-ui";
import { useTtsSettings } from "./composables/useTtsSettings";

const props = defineProps<{
  state: SettingsState;
}>();

const stateRef = toRef(props, "state");
const {
  ready,
  saving,
  msg,
  err,
  enabled,
  provider,
  voice,
  model,
  speed,
  apiHost,
  resourceId,
  styleInstruction,
  format,
  customVoices,
  newCustomVoice,
  apiKey,
  hasApiKey,
  voices,
  models,
  PROVIDERS,
  currentProviderLabel,
  isMimo,
  isMinimax,
  isVolc,
  persist,
  onProviderChange,
  preview,
  addCustomVoice,
  removeCustomVoice,
  stopSpeaking,
} = useTtsSettings(stateRef);

const providerOptions = computed(() =>
  PROVIDERS.map((item) => ({ value: item.id, label: item.label })),
);
const voiceOptions = computed(() =>
  voices.value.map((item) => ({
    value: item.id,
    label: `${item.name}（${item.id}）`,
  })),
);
const modelOptions = computed(() =>
  models.value.map((item) => ({ value: item, label: item })),
);
const formatOptions = [
  { value: "mp3", label: "mp3" },
  { value: "wav", label: "wav" },
];
const minimaxHostOptions = [
  { value: "https://api.minimax.io", label: "Official (api.minimax.io)" },
  { value: "https://api.minimaxi.chat", label: "Global (api.minimaxi.chat)" },
  { value: "https://api.minimax.chat", label: "Mainland China (api.minimax.chat)" },
];
</script>

<template>
  <PageHeader
    title="语音"
    description="在线 TTS：回复生成后由应用壳合成并播放；桌宠口型由播放窗的音频分析驱动。"
  />
  <p v-if="!tauriAvailable()" class="hint">在线 TTS 需要在 Diver 桌面应用中使用。</p>
  <template v-else>
    <Switch v-model="enabled" label="语音朗读回复（在线 TTS）" />

    <template v-if="enabled || ready">
      <Field label="服务商">
        <Select
          v-model="provider"
          :options="providerOptions"
          @update:model-value="onProviderChange"
        />
      </Field>

      <Field label="声线">
        <Select v-model="voice" :options="voiceOptions" />
      </Field>
      <div class="row">
        <Input
          v-model="newCustomVoice"
          size="sm"
          placeholder="自定义声线 ID"
          @keydown.enter.prevent="addCustomVoice"
        />
        <Button size="sm" @click="addCustomVoice">添加</Button>
      </div>
      <div v-if="customVoices.length" class="chips">
        <span v-for="id in customVoices" :key="id" class="chip">
          {{ id }}
          <button type="button" class="chip-x" @click="removeCustomVoice(id)">×</button>
        </span>
      </div>

      <Field v-if="models.length" label="模型">
        <Select v-model="model" :options="modelOptions" />
      </Field>

      <Field :label="`语速 ${speed.toFixed(2)}x`">
        <input
          v-model.number="speed"
          type="range"
          min="0.5"
          max="2"
          step="0.05"
          class="range"
        />
      </Field>

      <Field label="音频格式">
        <Select v-model="format" :options="formatOptions" />
      </Field>

      <template v-if="isMimo">
        <Field label="风格指令（可选）">
          <Input
            v-model="styleInstruction"
            placeholder="例如：用轻快上扬的语调，语速稍快"
          />
        </Field>
        <Field label="API 地址">
          <Input v-model="apiHost" placeholder="https://api.xiaomimimo.com/v1" />
        </Field>
        <Field :label="`API Key ${hasApiKey ? '（已配置）' : ''}`">
          <Input
            v-model="apiKey"
            type="password"
            placeholder="留空则不修改"
            autocomplete="off"
          />
        </Field>
      </template>

      <template v-else-if="isMinimax">
        <Field label="API Host">
          <Select v-model="apiHost" :options="minimaxHostOptions" />
        </Field>
        <Field :label="`API Key ${hasApiKey ? '（已配置）' : ''}`">
          <Input
            v-model="apiKey"
            type="password"
            placeholder="留空则不修改"
            autocomplete="off"
          />
        </Field>
      </template>

      <template v-else-if="isVolc">
        <Field label="API 端点">
          <Input
            v-model="apiHost"
            placeholder="https://openspeech.bytedance.com/api/v3/tts/unidirectional"
          />
        </Field>
        <Field label="Resource ID（可选）">
          <Input v-model="resourceId" placeholder="如 volc.service_type.10029" />
        </Field>
        <Field :label="`API Key ${hasApiKey ? '（已配置）' : ''}`">
          <Input
            v-model="apiKey"
            type="password"
            placeholder="留空则不修改"
            autocomplete="off"
          />
        </Field>
      </template>

      <div class="row actions">
        <Button variant="primary" :disabled="saving" @click="persist">
          {{ saving ? "保存中…" : "保存" }}
        </Button>
        <Button :disabled="saving" @click="preview">试听</Button>
        <Button @click="stopSpeaking()">停止</Button>
      </div>
      <InlineNotice v-if="msg" tone="ok">{{ msg }}</InlineNotice>
      <InlineNotice v-if="err" tone="err">{{ err }}</InlineNotice>
      <p class="hint">
        当前：{{ currentProviderLabel }} · 请求由应用壳发起，不再使用本地 SAPI。
      </p>
    </template>
  </template>
</template>

<style scoped>
.range {
  width: 100%;
  accent-color: var(--ink);
}
.row {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.actions {
  margin-top: 14px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.chip {
  background: var(--paper-sunken);
  border: 1px solid var(--rule);
  border-radius: var(--radius-pill);
  padding: 4px 10px;
  font-size: 12px;
  color: var(--ink-soft);
}
.chip-x {
  border: 0;
  background: transparent;
  color: var(--ink-dim);
  cursor: pointer;
  margin-left: 4px;
}
</style>
