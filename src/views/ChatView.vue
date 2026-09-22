<script setup lang="ts">
import { computed, watch } from "vue";
import { useRouter } from "vue-router";
import { useChat } from "../composables/chat";
import { useSettings } from "../composables/useSettings";
import { setChrome } from "../composables/useChrome";
import { filesToAttachments } from "../imageAttach";
import ChatArea from "../components/ChatArea.vue";
import ComposerBar from "../components/ComposerBar.vue";

async function onAddFiles(files: File[]) {
  const items = await filesToAttachments(files);
  if (items.length) addAttachments(items);
}

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
  attachments,
  modelConfigured,
  currentModelLabel,
  statusText,
  isReady,
  canSend,
  reconnect,
  send,
  pendingQuestion,
  submitQuestionAnswer,
  addAttachments,
  removeAttachment,
} = chat;
const { state, doRestartSidecar } = settings;

// TTS 状态（开关/语音）由设置状态持有，注入给聊天核心做自动朗读
chat.setTtsSource(() => ({
  enabled: state.ttsEnabled,
  voice: state.ttsVoice,
}));

const dotClass = computed(() => (isReady.value ? "on" : busy.value ? "busy" : "off"));

// 同步到自定义标题栏
watch(
  [statusText, currentModelLabel, dotClass],
  () => {
    setChrome({
      statusText: statusText.value,
      modelLabel: currentModelLabel.value,
      dotClass: dotClass.value,
    });
  },
  { immediate: true },
);

function openSettings() {
  void router.push({ name: "settings", params: { tab: "models" } });
}
</script>

<template>
  <div class="chat-shell">
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
      :is-ready="isReady"
      :busy="busy"
      :model-configured="modelConfigured"
      :error="error"
      :attachments="attachments"
      @send="send"
      @add-files="onAddFiles"
      @remove-attachment="removeAttachment"
    />
  </div>
</template>

<style scoped>
.chat-shell {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--paper);
}
</style>
