<script setup lang="ts">
// 主窗口聊天（P2-3 私聊）：左侧实例会话栏 + 右侧会话区。
// 会话池每实例一份（useChat(id)），切换侧栏即换绑；SSE/健康轮询各自常驻。
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getChat, useChat } from "../composables/chat";
import { useSettings } from "../composables/useSettings";
import { useInstances } from "../composables/useInstances";
import { setChrome } from "../composables/useChrome";
import { filesToAttachments } from "../imageAttach";
import { setInstanceRuntimes } from "../api";
import { listInstanceRuntimes, tauriAvailable } from "../tauri";
import type { ChatMessage } from "../types";
import ChatArea from "../components/ChatArea.vue";
import ComposerBar from "../components/ComposerBar.vue";
import InstanceSidebar, { type RailRow } from "../components/InstanceSidebar.vue";

const router = useRouter();
const settings = useSettings();
const { state, doRestartSidecar } = settings;
const instancesState = useInstances();

const GROUP_ID = "@group";
const currentId = ref("default");
const isGroup = computed(() => currentId.value === GROUP_ID);
// 群聊模式借 default 会话当「输入框载体」（不新建 @group 会话）；群发走 fan-out。
const chat = computed(() => useChat(isGroup.value ? "default" : currentId.value));

// 会话池喂 API 寻址 + 清单/注册表轮询（侧栏在线点 / 端口映射）。
const runtimes = ref<Record<string, { online: boolean; busy: boolean }>>({});
async function refreshRuntimes() {
  if (!tauriAvailable()) return;
  try {
    const rows = await listInstanceRuntimes();
    setInstanceRuntimes(rows);
    const map: Record<string, { online: boolean; busy: boolean }> = {};
    for (const r of rows) {
      map[r.id] = { online: true, busy: false };
    }
    runtimes.value = map;
  } catch {
    /* 注册表未就绪：侧栏降级为离线点 */
  }
}

onMounted(() => {
  void instancesState.refresh();
  void refreshRuntimes();
  window.setInterval(() => void refreshRuntimes(), 5000);
});

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

// 事件/动作委托
function send() {
  if (isGroup.value) {
    sendGroup();
    return;
  }
  void chat.value.send();
}

// 群聊广播（P2-3）：发给全部在线实例（queue 忙不插话 + group 标记）；不强制回复。
function sendGroup() {
  const text = composer.value.trim();
  if (!text) return;
  const targets = instancesState.instances.value
    .map((m) => m.id)
    .filter((id) => runtimes.value[id]?.online === true);
  if (targets.length === 0) return;
  composer.value = "";
  for (const id of targets) {
    void getChat(id)?.send({ content: text, queue: true, group: true });
  }
}
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

// ---------- 侧栏行（QQ 式）：清单 × 注册表 × 会话池预览 ----------
const nameOf = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const m of instancesState.instances.value) {
    map[m.id] = m.name?.trim() || m.id;
  }
  return map;
});

// 群聊合并流（P2-3）：只收挂 group 标的流量（用户群广播、实例群发言及其回复）；
// 纯私聊流量（含实例间私聊）不进群视图。同一消息的多实例副本按内容+来源+3s 去重。
const mergedMessages = computed<ChatMessage[]>(() => {
  const items: ChatMessage[] = [];
  for (const m of instancesState.instances.value) {
    const c = getChat(m.id);
    if (!c) continue;
    for (const msg of c.messages.value) {
      if (msg.group !== true) continue;
      if (msg.origin === "peer" && msg.from) {
        items.push({ ...msg, from: nameOf.value[msg.from] ?? msg.from });
      } else if (msg.kind === "assistant") {
        items.push({ ...msg, from: nameOf.value[m.id] ?? m.id });
      } else {
        items.push({ ...msg });
      }
    }
  }
  items.sort((a, b) => a.time - b.time);
  const out: ChatMessage[] = [];
  for (const m of items) {
    if (m.origin === "user" || m.origin === "peer") {
      const dup = out.some(
        (k) =>
          k.origin === m.origin &&
          k.from === m.from &&
          k.content === m.content &&
          Math.abs(k.time - m.time) <= 3000,
      );
      if (dup) continue;
    }
    out.push(m);
  }
  return out;
});

const railRows = computed<RailRow[]>(() => {
  const list = instancesState.instances.value;
  const rows: RailRow[] = list.map((m) => {
    const c = getChat(m.id);
    const msgs = c?.messages.value ?? [];
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
    return {
      id: m.id,
      name: nameOf.value[m.id] ?? m.id,
      avatar: m.avatar,
      preview: last ? last.content.replace(/\s+/g, " ").slice(0, 30) : "（暂无消息）",
      timeText: last ? fmtClock(last.time) : "",
      online: runtimes.value[m.id]?.online ?? false,
      busy: c?.busy.value ?? false,
    };
  });
  // 首位固定「群聊」虚拟行（P2-3）。
  const merged = mergedMessages.value;
  const lastMerged = merged.length > 0 ? merged[merged.length - 1] : undefined;
  rows.unshift({
    id: GROUP_ID,
    name: "群聊",
    avatar: null,
    preview: lastMerged
      ? lastMerged.content.replace(/\s+/g, " ").slice(0, 30)
      : "多实例共同会话",
    timeText: lastMerged ? fmtClock(lastMerged.time) : "",
    online: rows.some((r) => r.online),
    busy: rows.some((r) => r.busy),
  });
  return rows;
});

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 来源徽标解析实例名（peer 消息 from=id → 展示名）；id 保留不可解析时兜底。
const displayMessages = computed<ChatMessage[]>(() => {
  if (isGroup.value) return mergedMessages.value;
  return messages.value.map((m) =>
    m.origin === "peer" && m.from ? { ...m, from: nameOf.value[m.from] ?? m.from } : m,
  );
});
</script>

<template>
  <div class="chat-shell">
    <InstanceSidebar v-model="currentId" :rows="railRows" />
    <div class="chat-main">
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
  </div>
</template>

<style scoped>
.chat-shell {
  display: flex;
  flex: 1;
  min-height: 0;
  background: var(--paper);
}
.chat-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>
