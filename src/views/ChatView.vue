<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useChat } from "../composables/chat";
import { useSettings } from "../composables/useSettings";
import TopBar from "../components/TopBar.vue";
import ChatArea from "../components/ChatArea.vue";
import ComposerBar from "../components/ComposerBar.vue";

const router = useRouter();
const chat = useChat();
const settings = useSettings();

// 解构到顶层：模板中 ref 自动解包
const {
  healthInfo,
  messages,
  tools,
  busy,
  connecting,
  error,
  composer,
  modelConfigured,
  currentModelLabel,
  statusText,
  canSend,
  reconnect,
  send,
  pendingQuestion,
  submitQuestionAnswer,
} = chat;
const { state, doRestartSidecar } = settings;

// TTS 状态（开关/语音）由设置状态持有，注入给聊天核心做自动朗读
chat.setTtsSource(() => ({
  enabled: state.ttsEnabled,
  voice: state.ttsVoice,
}));

function openSettings() {
  void router.push({ name: "settings", params: { tab: "models" } });
}

const dotClass = computed(() => (canSend.value ? "on" : busy.value ? "busy" : "off"));
</script>

<template>
  <div class="app">
    <TopBar
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
      :model-configured="modelConfigured"
      :tts-enabled="state.ttsEnabled"
      :tts-voice="state.ttsVoice"
      :pending-question="pendingQuestion"
      @retry="reconnect"
      @restart="doRestartSidecar"
      @open-settings="openSettings"
      @suggestion="composer = $event"
      @answer-question="submitQuestionAnswer"
      @toggle-activity="chat.toggleActivity"
    />

    <ComposerBar
      v-model="composer"
      :can-send="canSend"
      :busy="busy"
      :model-configured="modelConfigured"
      :error="error"
      @send="send"
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
