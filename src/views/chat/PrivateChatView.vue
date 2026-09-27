<script setup lang="ts">
// 私聊视图（P2-3）：单实例会话——会话池、连接态、提问卡片、TTS 都归属本实例。
// 与群视图（GroupChatView）互不耦合：任何一侧的改动不应波及另一侧。
import { computed, watch } from "vue";
import { useRouter } from "vue-router";
import { useChat } from "../../composables/chat";
import { useInstances } from "../../composables/useInstances";
import { useSettings } from "../../composables/useSettings";
import { setChrome } from "../../composables/useChrome";
import { filesToAttachments } from "../../imageAttach";
import type { ChatMessage } from "../../types";
import ChatArea from "../../components/ChatArea.vue";
import ComposerBar from "../../components/ComposerBar.vue";

const props = defineProps<{ instanceId: string }>();

const router = useRouter();
const settings = useSettings();
const instancesState = useInstances();
const { state, doRestartSidecar } = settings;

// 会话池进程级常驻（useChat 幂等），切换实例即换绑，SSE/健康轮询不随挂载丢失。
const chat = computed(() => useChat(props.instanceId));

// 委托解包：模板顶层 ref 语义不变，底下按当前实例取值。
const healthInfo = computed(() => chat.value.healthInfo.value);
const messages = computed(() => chat.value.messages.value);
const tools = computed(() => chat.value.tools.value);
const busy = computed(() => chat.value.busy.value);
const connecting = computed(() => chat.value.connecting.value);
const error = computed(() => chat.value.error.value);
const attachments = computed(() => chat.value.attachments.value);
const modelConfigured = computed(() => chat.value.modelConfigured.value);
const currentModelLabel = computed(() => chat.value.currentModelLabel.value);
const statusText = computed(() => chat.value.statusText.value);
const isReady = computed(() => chat.value.isReady.value);
const canSend = computed(() => chat.value.canSend.value);
const pendingQuestion = computed(() => chat.value.pendingQuestion.value);
const composer = computed({
  get: () => chat.value.composer.value,
  set: (v: string) => {
    chat.value.composer.value = v;
  },
});

// TTS 源（开关/语音）由设置状态持有；每个会话建立时注入
watch(
  chat,
  (c) => {
    c.setTtsSource(() => ({
      enabled: state.ttsEnabled,
      voice: state.ttsVoice,
    }));
  },
  { immediate: true },
);

// 同步到自定义标题栏（思考中 / 模型 / 在线点）
const dotClass = computed(() => (isReady.value ? "on" : busy.value ? "busy" : "off"));
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

// 来源徽标解析实例名（peer 消息 from=id → 展示名）；id 保留供按实例取头像。
const nameOf = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const m of instancesState.instances.value) {
    map[m.id] = m.name?.trim() || m.id;
  }
  return map;
});
// 私聊视图只呈三方：该实例自己的消息 / 投递给它的 peer 消息 / 用户发给它的消息。
// 带 group 标的流量（群发言注入、用户群广播）归群合并流，不进私聊视图——
// 视图是给用户看的事实记录面，群聊事件不能同时出现在私聊语境里。
// 头像归属：peer 消息按发送实例；自己的 assistant 气泡按本实例
// （fromId 缺省会落到 active 单例头像，切了会话就张冠李戴）。
const displayMessages = computed<ChatMessage[]>(() =>
  messages.value
    .filter((m) => m.group !== true)
    .map((m) => {
      if (m.origin === "peer" && m.from) {
        return { ...m, from: nameOf.value[m.from] ?? m.from, fromId: m.from };
      }
      if (m.kind === "assistant") {
        return { ...m, fromId: props.instanceId };
      }
      return m;
    }),
);

function reconnect() {
  void chat.value.reconnect();
}
function submitQuestionAnswer(answers: Parameters<typeof chat.value.submitQuestionAnswer>[0]) {
  void chat.value.submitQuestionAnswer(answers);
}
function addAttachments(items: Parameters<typeof chat.value.addAttachments>[0]) {
  chat.value.addAttachments(items);
}
function removeAttachment(id: string) {
  chat.value.removeAttachment(id);
}

async function onAddFiles(files: File[]) {
  const items = await filesToAttachments(files);
  if (items.length) addAttachments(items);
}

function send() {
  void chat.value.send();
}

function openSettings() {
  void router.push({ name: "settings", params: { tab: "models" } });
}
</script>

<template>
  <div class="chat-pane">
    <ChatArea
      :messages="displayMessages"
      :tools="tools"
      :busy="busy"
      :connecting="connecting"
      :error="error"
      :health-ok="!!healthInfo?.ok"
      :model-configured="modelConfigured"
      :tts-enabled="state.ttsEnabled"
      :tts-voice="state.ttsVoice"
      :pending-question="pendingQuestion"
      :has-more-history="chat.historyHasMore.value"
      :loading-older="chat.loadingOlder.value"
      :key-prefix="`${instanceId}:`"
      @retry="reconnect"
      @restart="doRestartSidecar"
      @open-settings="openSettings"
      @suggestion="composer = $event"
      @answer-question="submitQuestionAnswer"
      @toggle-activity="chat.toggleActivity"
      @load-older="chat.loadOlder()"
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
.chat-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>
