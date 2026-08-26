<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { ChatMessage, ToolActivity, UserQuestion, UserQuestionAnswerItem } from "../types";
import { tauriAvailable } from "../tauri";
import { speakMessageText } from "../tts";
import MessageBubble from "./MessageBubble.vue";
import WelcomeCard from "./WelcomeCard.vue";
import QuestionCard from "./QuestionCard.vue";

const props = defineProps<{
  messages: ChatMessage[];
  tools: ToolActivity[];
  busy: boolean;
  connecting: boolean;
  error: string | null;
  healthOk: boolean;
  modelConfigured: boolean;
  ttsEnabled: boolean;
  ttsVoice: string;
  pendingQuestion: { requestId: string; questions: UserQuestion[] } | null;
}>();

defineEmits<{
  retry: [];
  restart: [];
  "open-settings": [];
  suggestion: [text: string];
  answerQuestion: [answers: UserQuestionAnswerItem[]];
}>();

const scrollEl = ref<HTMLElement | null>(null);

function scrollToBottom() {
  nextTick(() => {
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
  });
}

watch(
  () => [props.messages.length, props.tools.length, props.busy],
  () => scrollToBottom(),
  { deep: true },
);

async function speak(msg: ChatMessage) {
  await speakMessageText(msg.content, props.ttsVoice);
}
</script>

<template>
  <main class="chat">
    <div ref="scrollEl" class="chat-scroll">
      <div v-if="connecting" class="center-hint">正在连接…</div>
      <div v-else-if="error && !healthOk" class="center-hint error">
        <p>连接失败：{{ error }}</p>
        <button class="btn" @click="$emit('retry')">重试</button>
      </div>

      <template v-else>
          <div v-if="error" class="chat-error-strip">
            <span class="chat-error-text">遇到点问题：{{ error }}</span>
            <button class="btn small" @click="$emit('retry')">重连</button>
            <button class="btn small" @click="$emit('restart')">重启 sidecar</button>
          </div>
        <WelcomeCard
          v-if="messages.length === 0"
          :model-configured="modelConfigured"
          @open-settings="$emit('open-settings')"
          @suggestion="$emit('suggestion', $event)"
        />

        <MessageBubble
          v-for="msg in messages"
          :key="msg.id"
          :msg="msg"
          :tts-voice="ttsVoice"
          :tauri="tauriAvailable()"
          @speak="speak"
        />

        <QuestionCard
          v-if="pendingQuestion"
          :request-id="pendingQuestion.requestId"
          :questions="pendingQuestion.questions"
          @answer="$emit('answerQuestion', $event)"
        />

        <div v-if="tools.length" class="tools-strip">
          <span v-for="(t, i) in tools" :key="i" class="tool-chip" :class="t.status">
            {{ t.status === "call" ? "正在" : "完成" }} {{ t.name }}
          </span>
        </div>

        <div v-if="busy && !messages.some((m) => m.streaming)" class="thinking">
          <span class="dot busy"></span> 正在思考…
        </div>
      </template>
    </div>
  </main>
</template>

<style scoped>
.chat {
  flex: 1;
  overflow: hidden;
  position: relative;
}
.chat-scroll {
  height: 100%;
  overflow-y: auto;
  padding: 20px 22px 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
}
.center-hint {
  margin: auto;
  color: #8d89a1;
  font-size: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.center-hint.error p {
  color: #d37d7d;
}
.btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #e8e6f0;
  border-radius: 10px;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
  .chat-error-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 8px 12px;
    border: 1px solid rgba(211, 125, 125, 0.4);
    border-radius: 10px;
    background: rgba(211, 93, 93, 0.12);
  }
  .chat-error-text {
    flex: 1;
    color: #e8a3a3;
    font-size: 13px;
  }
  .btn.small {
    padding: 4px 10px;
    font-size: 12px;
  }
.tools-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-left: 44px;
}
.tool-chip {
  font-size: 11px;
  color: #9a96ad;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 10px;
  padding: 2px 10px;
}
.tool-chip.call {
  color: #ffb07c;
}
.thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #9a96ad;
  font-size: 13px;
  padding-left: 44px;
}
.dot.busy {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ffb07c;
  animation: pulse 1.2s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
</style>
