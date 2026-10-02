<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ChatMessage, ToolActivity, UserQuestion, UserQuestionAnswerItem } from "../types";
import { tauriAvailable } from "../tauri";
import { onTtsSpeakingChange, speakMessageText, stopSpeaking } from "../tts";
import type { TtsSpeakSpec } from "../tts/queue";
import MessageBubble from "./MessageBubble.vue";
import ActivitySummary from "./ActivitySummary.vue";
import WelcomeCard from "./WelcomeCard.vue";
import QuestionCard from "./QuestionCard.vue";
import JumpToBottom from "./JumpToBottom.vue";
import MessageNav from "./MessageNav.vue";
import { createChatScroller } from "../composables/chat/useChatScroller";

const props = withDefaults(
  defineProps<{
    messages: ChatMessage[];
    tools: ToolActivity[];
    busy: boolean;
    connecting: boolean;
    error: string | null;
    healthOk: boolean;
    modelConfigured: boolean;
    ttsEnabled: boolean;
    ttsVoice: string | TtsSpeakSpec;
    pendingQuestion: { requestId: string; questions: UserQuestion[] } | null;
    /** 视图语境：群聊视图 true——他方实例发言靠左、名字在气泡上方；私聊 false */
    groupView?: boolean;
    /**
     * 列表 key 前缀（视图命名空间）。不同实例/会话池的消息 id 由各自 sidecar
     * 生成，短编号会跨池撞号；不加前缀时切换会话会按 key 复用旧组件（头像张冠李戴）。
     */
    keyPrefix?: string;
    /** 还有更早的历史没加载（打开只取最近几轮，其余懒加载） */
    hasMoreHistory?: boolean;
    /** 正在懒加载更早消息 */
    loadingOlder?: boolean;
  }>(),
  { groupView: false, keyPrefix: "" },
);

const emit = defineEmits<{
  retry: [];
  restart: [];
  "open-settings": [];
  suggestion: [text: string];
  answerQuestion: [answers: UserQuestionAnswerItem[]];
  toggleActivity: [groupId: string];
  loadOlder: [];
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

onMounted(bindTtsSpeaking);
onBeforeUnmount(() => offTtsSpeaking?.());

// 滚动控制（贴底跟随 / 首屏贴底 / 前插锚定 / 懒加载触发 / 时间线导航）
const { stickToBottom, currentMid, onScroll, scrollToBottom, jumpToMessage } =
  createChatScroller({
    scrollEl,
    count: () => props.messages.length,
    firstId: () => props.messages[0]?.id,
    hasMore: () => props.hasMoreHistory === true,
    loadingOlder: () => props.loadingOlder === true,
    requestOlder: () => emit("loadOlder"),
  });

function stopTts() {
  stopSpeaking();
}

watch(
  () => [props.messages.length, props.tools.length, props.busy],
  () => scrollToBottom(),
  { deep: true },
);

async function speak(msg: ChatMessage) {
  await speakMessageText(msg.content, props.ttsVoice, msg.id, { userGesture: true });
}
</script>

<template>
  <main class="chat">
    <div ref="scrollEl" class="chat-scroll" @scroll.passive="onScroll">
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

        <div v-if="hasMoreHistory || loadingOlder" class="history-older">
          <button
            v-if="hasMoreHistory && !loadingOlder"
            class="history-older-btn"
            type="button"
            @click="emit('loadOlder')"
          >
            查看更早的消息
          </button>
          <span v-else class="history-older-hint">正在加载更早的消息…</span>
        </div>

        <WelcomeCard
          v-if="messages.length === 0"
          :model-configured="modelConfigured"
          @open-settings="emit('open-settings')"
          @suggestion="emit('suggestion', $event)"
        />

        <template v-for="msg in messages" :key="keyPrefix + msg.id">
          <ActivitySummary
            v-if="msg.kind === 'activity-summary'"
            :msg="msg"
            :expanded="!!msg.activityExpanded"
            @toggle="emit('toggleActivity', msg.activityGroupId ?? msg.id)"
          />
          <MessageBubble
            v-else-if="
              msg.kind === 'user' ||
              msg.kind === 'system' ||
              !msg.activityGroupId ||
              isActivityExpanded(msg.activityGroupId)
            "
            :msg="msg"
            :group-view="groupView"
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

        <div v-if="busy && !messages.some((m) => m.streaming)" class="thinking">
          <span class="dot busy"></span> 正在思考…
        </div>
      </template>
    </div>

    <JumpToBottom :visible="!stickToBottom" @jump="scrollToBottom(true)" />
    <MessageNav
      :visible="messages.length > 0"
      :messages="messages"
      :current="currentMid"
      @jump="jumpToMessage"
    />
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
/* 相邻的纯过程步骤行（思考/工具、无正文无图）：抵消 18px 段距，使跨行行距
   与行内工具记录行距一致（行内 padding 4px×2 + 行高 ≈27px）。活跃 turn 的
   步骤行尚未折叠、无 activityGroupId，靠相邻兄弟选择器命中；带正文的气泡、
   摘要条、user/system 行不打折，保持段距作呼吸位。 */
.chat-scroll > .msg-row.meta-only + .msg-row.meta-only {
  margin-top: -18px;
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
.thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-muted);
  font-size: 13px;
  padding-left: 36px;
}

.history-older {
  display: flex;
  justify-content: center;
  padding: 2px 0 8px;
}
.history-older-btn {
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius-pill);
  background: var(--paper-raised);
  color: var(--ink-soft);
  font-size: 12px;
  padding: 4px 14px;
  cursor: pointer;
  transition:
    background var(--dur-hover) ease,
    color var(--dur-hover) ease,
    border-color var(--dur-hover) ease;
}
@media (hover: hover) and (pointer: fine) {
  .history-older-btn:hover {
    background: var(--paper-hover);
    color: var(--ink);
  }
}
.history-older-hint {
  color: var(--ink-muted);
  font-size: 12px;
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
