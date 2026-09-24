<script setup lang="ts">
import { toRef } from "vue";
import type { SettingsState } from "../../composables/useSettings";
import { tauriAvailable } from "../../tauri";
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
</script>

<template>
  <p v-if="!tauriAvailable()" class="hint">在线 TTS 需要在 Diver 桌面应用中使用。</p>
  <template v-else>
    <label class="switch-row">
      <input v-model="enabled" type="checkbox" />
      <span>语音朗读回复（在线 TTS）</span>
    </label>

    <template v-if="enabled || ready">
      <label class="group-title">服务商</label>
      <select v-model="provider" class="model-select" @change="onProviderChange">
        <option v-for="p in PROVIDERS" :key="p.id" :value="p.id">{{ p.label }}</option>
      </select>

      <label class="group-title">声线</label>
      <select v-model="voice" class="model-select">
        <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.name }}（{{ v.id }}）</option>
      </select>
      <div class="row">
        <input
          v-model="newCustomVoice"
          class="text-input"
          type="text"
          placeholder="自定义声线 ID"
          @keydown.enter.prevent="addCustomVoice"
        />
        <button class="btn" type="button" @click="addCustomVoice">添加</button>
      </div>
      <div v-if="customVoices.length" class="chips">
        <span v-for="id in customVoices" :key="id" class="chip">
          {{ id }}
          <button type="button" class="chip-x" @click="removeCustomVoice(id)">×</button>
        </span>
      </div>

      <template v-if="models.length">
        <label class="group-title">模型</label>
        <select v-model="model" class="model-select">
          <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
        </select>
      </template>

      <label class="group-title">语速 {{ speed.toFixed(2) }}x</label>
      <input v-model.number="speed" type="range" min="0.5" max="2" step="0.05" class="range" />

      <label class="group-title">音频格式</label>
      <select v-model="format" class="model-select">
        <option value="mp3">mp3</option>
        <option value="wav">wav</option>
      </select>

      <template v-if="isMimo">
        <label class="group-title">风格指令（可选）</label>
        <input
          v-model="styleInstruction"
          class="text-input"
          type="text"
          placeholder="例如：用轻快上扬的语调，语速稍快"
        />
        <label class="group-title">API 地址</label>
        <input v-model="apiHost" class="text-input" type="text" placeholder="https://api.xiaomimimo.com/v1" />
        <label class="group-title">API Key {{ hasApiKey ? "（已配置）" : "" }}</label>
        <input v-model="apiKey" class="text-input" type="password" placeholder="留空则不修改" />
      </template>

      <template v-else-if="isMinimax">
        <label class="group-title">API Host</label>
        <select v-model="apiHost" class="model-select">
          <option value="https://api.minimax.io">Official (api.minimax.io)</option>
          <option value="https://api.minimaxi.chat">Global (api.minimaxi.chat)</option>
          <option value="https://api.minimax.chat">Mainland China (api.minimax.chat)</option>
        </select>
        <label class="group-title">API Key {{ hasApiKey ? "（已配置）" : "" }}</label>
        <input v-model="apiKey" class="text-input" type="password" placeholder="留空则不修改" />
      </template>

      <template v-else-if="isVolc">
        <label class="group-title">API 端点</label>
        <input
          v-model="apiHost"
          class="text-input"
          type="text"
          placeholder="https://openspeech.bytedance.com/api/v3/tts/unidirectional"
        />
        <label class="group-title">Resource ID（可选）</label>
        <input v-model="resourceId" class="text-input" type="text" placeholder="如 volc.service_type.10029" />
        <label class="group-title">API Key {{ hasApiKey ? "（已配置）" : "" }}</label>
        <input v-model="apiKey" class="text-input" type="password" placeholder="留空则不修改" />
      </template>

      <div class="row actions">
        <button class="btn" type="button" :disabled="saving" @click="persist">
          {{ saving ? "保存中…" : "保存" }}
        </button>
        <button class="btn" type="button" :disabled="saving" @click="preview">试听</button>
        <button class="btn" type="button" @click="() => stopSpeaking()">停止</button>
      </div>
      <p v-if="msg" class="hint ok">{{ msg }}</p>
      <p v-if="err" class="hint bad">{{ err }}</p>
      <p class="hint">当前：{{ currentProviderLabel }} · 请求由应用壳发起，不再使用本地 SAPI。</p>
    </template>
  </template>
</template>

<style scoped>
.switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--ink);
}
.group-title {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-dim);
  letter-spacing: 0.06em;
  margin-top: 10px;
}
.model-select,
.text-input {
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  color: var(--ink);
  padding: 8px 11px;
  font-size: 13px;
  outline: none;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}
.range {
  width: 100%;
  accent-color: var(--ink);
}
.row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.actions {
  margin-top: 14px;
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
.hint {
  font-size: 11px;
  color: var(--ink-dim);
  margin: 8px 0 0;
}
.hint.ok {
  color: var(--ok);
}
.hint.bad {
  color: var(--err);
}
</style>
