<script setup lang="ts">
import { computed } from "vue";
import { useChat } from "./composables/chat";
import { useSettings } from "./composables/useSettings";
import TopBar from "./components/TopBar.vue";
import ChatArea from "./components/ChatArea.vue";
import ComposerBar from "./components/ComposerBar.vue";
import SettingsPanel from "./components/SettingsPanel.vue";

const chat = useChat();
const settings = useSettings(chat);

// 解构到顶层：模板中 ref 自动解包
const {
  healthInfo,
  settingsInfo,
  messages,
  tools,
  busy,
  connecting,
  error,
  composer,
  personaName,
  modelConfigured,
  currentModelLabel,
  statusText,
  canSend,
  reconnect,
  send,
  pendingQuestion,
  submitQuestionAnswer,
} = chat;
const {
  state,
  providerDecls,
  currentProviderDecl,
  currentProviderModels,
  openSettings,
  save,
  doRestartSidecar,
  toggleWindowStartup,
} = settings;

// TTS 状态（开关/语音）由设置面板持有，注入给聊天核心做自动朗读
chat.setTtsSource(() => ({
  enabled: state.ttsEnabled,
  voice: state.ttsVoice,
}));

const dotClass = computed(() => (canSend.value ? "on" : busy.value ? "busy" : "off"));
</script>

<template>
  <div class="app">
    <TopBar
      :persona-name="personaName"
      :status-text="statusText"
      :model-label="currentModelLabel"
      :dot-class="dotClass"
      @open-settings="openSettings"
    />

    <ChatArea
      :messages="messages"
      :tools="tools"
      :busy="busy"
      :connecting="connecting"
      :error="error"
      :health-ok="!!healthInfo?.ok"
      :persona-name="personaName"
      :model-configured="modelConfigured"
      :tts-enabled="state.ttsEnabled"
      :tts-voice="state.ttsVoice"
      :pending-question="pendingQuestion"
      @retry="reconnect"
        @restart="doRestartSidecar"
      @open-settings="openSettings"
      @suggestion="composer = $event"
      @answer-question="submitQuestionAnswer"
    />

    <ComposerBar
      v-model="composer"
      :can-send="canSend"
      :busy="busy"
      :model-configured="modelConfigured"
      :error="error"
      @send="send"
    />

    <SettingsPanel
      :open="state.open"
      :state="state"
      :health-info="healthInfo"
      :settings-info="settingsInfo"
      :provider-decls="providerDecls"
      :current-provider-decl="currentProviderDecl"
      :current-provider-models="currentProviderModels"
      @close="state.open = false"
      @save="save"
      @restart="doRestartSidecar"
      @toggle-window-startup="toggleWindowStartup"
    />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: linear-gradient(180deg, #171826 0%, #141420 100%);
  color: #e8e6f0;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}
</style>
