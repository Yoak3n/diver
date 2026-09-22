<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { ChatMessage, ToolActivity, UserQuestion, UserQuestionAnswerItem } from "../types";
import { tauriAvailable } from "../tauri";
import { onTtsSpeakingChange, speakMessageText, stopSpeaking } from "../tts";
import MessageBubble from "./MessageBubble.vue";
import ActivitySummary from "./ActivitySummary.vue";
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

const emit = defineEmits<{
  retry: [];
  restart: [];
  "open-settings": [];
  suggestion: [text: string];
  answerQuestion: [answers: UserQuestionAnswerItem[]];
  toggleActivity: [groupId: string];
}>();

function isActivityExpanded(groupId: string): boolean {
  const summary = props.messages.find(
    (m) => m.kind === "activity-summary" && (m.activityGroupId ?? m.id) === groupId,
  );
  return !!summary?.activityExpanded;
}

const scrollEl = ref<HTMLElement | null>(null);
const ttsSpeaking = ref(false);
let offTtsSpeaking: (() => void) | null = null;

function bindTtsSpeaking() {
  offTtsSpeaking?.();
  offTtsSpeaking = onTtsSpeakingChange((v) => {
    ttsSpeaking.value = v;
  });
}

import { onMounted, onBeforeUnmount } from "vue";
onMounted(bindTtsSpeaking);
onBeforeUnmount(() => offTtsSpeaking?.());

function stopTts() {
  stopSpeaking();
}

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
  await speakMessageText(msg.content, props.ttsVoice, msg.id);
}
</script>

<template>
  <main class="chat">
    <div ref="scrollEl" class="chat-scroll">
      <div v-if="ttsSpeaking" class="tts-stop-bar">
        <span>正在朗读…</span>
        <button type="button" class="btn small" @click="stopTts">停止朗读</button>
      </div>
      <div v-if="connecting" class="center-hint">
        <span class="hint-rule"></span>
        <p>正在连接…</p>
      </div>
      <div v-else-if="error && !healthOk" class="center-hint error">
        <p>连接失败：{{ error }}</p>
        <button class="btn" @click="emit('retry')">重试</button>
      </div>

      <template v-else>
        <div v-if="error" class="chat-error-strip">
          <span class="chat-error-text">遇到点问题：{{ error }}</span>
          <button class="btn small" @click="emit('retry')">重连</button>
          <button class="btn small" @click="emit('restart')">重启 sidecar</button>
        </div>

        <WelcomeCard
          v-if="messages.length === 0"
          :model-configured="modelConfigured"
          @open-settings="emit('open-settings')"
          @suggestion="emit('suggestion', $event)"
        />

        <template v-for="msg in messages" :key="msg.id">
          <ActivitySummary
            v-if="msg.kind === 'activity-summary'"
            :msg="msg"
            :expanded="!!msg.activityExpanded"
            @toggle="emit('toggleActivity', msg.activityGroupId ?? msg.id)"
          />
          <MessageBubble
            v-else-if="!msg.activityGroupId || isActivityExpanded(msg.activityGroupId)"
            :msg="msg"
            :tts-voice="ttsVoice"
            :tauri="tauriAvailable()"
            @speak="speak"
          />
        </template>

        <QuestionCard
          v-if="pendingQuestion"
          :request-id="pendingQuestion.requestId"
          :questions="pendingQuestion.questions"
          @answer="emit('answerQuestion', $event)"
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
  overflow-x: hidden;
  padding: 28px 28px 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  scrollbar-width: thin;
}
.chat-scroll > * {
  min-width: 0;
  max-width: var(--chat-max);
  width: 100%;
  margin-left: auto;
  margin-right: auto;
}
.center-hint {
  margin: auto;
  color: var(--ink-muted);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.center-hint.error p {
  color: var(--err);
}
.hint-rule {
  width: 32px;
  height: 1px;
  background: var(--rule-strong);
}
.chat-error-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--err-border);
  border-radius: var(--radius);
  background: var(--err-soft);
}
.chat-error-text {
  flex: 1;
  color: var(--err);
  font-size: 13px;
}
.tools-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-left: 36px;
}
.tool-chip {
  font-size: 11px;
  color: var(--ink-muted);
  background: var(--paper-sunken);
  border: 1px solid var(--rule);
  border-radius: var(--radius-pill);
  padding: 2px 10px;
}
.tool-chip.call {
  color: var(--warn);
}
.thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-muted);
  font-size: 13px;
  padding-left: 36px;
}

.tts-stop-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 6px 10px;
  margin: 4px 8px;
  border-radius: 10px;
  background: rgba(42, 39, 64, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #c9c5dc;
  font-size: 12px;
  position: sticky;
  top: 8px;
  z-index: 5;
}
</style>
