<script setup lang="ts">
import type { SettingsState } from "../../composables/useSettings";
import { tauriAvailable } from "../../tauri";

defineProps<{
  state: SettingsState;
}>();
</script>

<template>
  <label class="switch-row">
    <input v-model="state.ttsEnabled" type="checkbox" />
    <span>语音朗读回复（本地 TTS）</span>
  </label>
  <template v-if="state.ttsEnabled">
    <label class="group-title">语音</label>
    <select v-model="state.ttsVoice" class="model-select">
      <option v-for="v in state.voices" :key="v" :value="v">{{ v }}</option>
    </select>
  </template>
  <p v-if="!tauriAvailable()" class="hint">
    （浏览器模式使用系统语音，Tauri 应用内使用本地 SAPI 语音）
  </p>
</template>

<style scoped>
.switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
  color: #b9b5cc;
}
.group-title {
  display: block;
  font-size: 12px;
  color: #8d89a1;
  letter-spacing: 1px;
  margin-top: 4px;
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
</style>
