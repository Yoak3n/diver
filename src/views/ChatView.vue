<script setup lang="ts">
// 主窗口聊天（P2-3 私聊）：左侧实例会话栏 + 右侧会话区。
// 会话池每实例一份（useChat(id)），切换侧栏即换绑；SSE/健康轮询各自常驻。
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getChat, useChat } from "../composables/chat";
import {
  createUnreadTracker,
  isIncomingMessage,
  type ConvSignal,
} from "../composables/chat/unread";
import { useSettings } from "../composables/useSettings";
import { useInstances } from "../composables/useInstances";
import { setChrome } from "../composables/useChrome";
import { filesToAttachments } from "../imageAttach";
import { setInstanceRuntimes } from "../api";
import { listInstanceRuntimes, onTauriEvent, tauriAvailable } from "../tauri";
import { listGroups, type GroupRow } from "../ipc/group";
import type { ChatMessage } from "../types";
import ChatArea from "../components/ChatArea.vue";
import ComposerBar from "../components/ComposerBar.vue";
import GroupManage from "../components/GroupManage.vue";
import InstanceSidebar, { type RailRow } from "../components/InstanceSidebar.vue";

const router = useRouter();
const settings = useSettings();
const { state, doRestartSidecar } = settings;
const instancesState = useInstances();

// 群聊（P2-4 多群）：侧栏群行 id = '@group:<gid>'，缺省全员群 general。
const GROUP_PREFIX = "@group:";
const currentId = ref("default");
const isGroup = computed(() => currentId.value.startsWith(GROUP_PREFIX));
const selectedGroupId = computed(() =>
  isGroup.value ? currentId.value.slice(GROUP_PREFIX.length) : "general",
);
// 群聊模式借 default 会话当「输入框载体」（不新建会话）；群发走 fan-out。
const chat = computed(() => useChat(isGroup.value ? "default" : currentId.value));

// 群清单（壳层 groups.json）：侧栏群行 + 归属流分桶数据源。
const groups = ref<GroupRow[]>([]);
async function refreshGroups() {
  if (!tauriAvailable()) return;
  try {
    groups.value = await listGroups();
  } catch {
    /* 群清单未就绪：侧栏降级只显示实例行 */
  }
}

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
  void refreshGroups();
  window.setInterval(() => {
    void refreshRuntimes();
    void refreshGroups();
  }, 5000);
  // P2-5 点谁互动谁：实例桌宠点击 → 主窗切到该实例会话。
  if (tauriAvailable()) {
    void onTauriEvent<{ instanceId: string }>("pet://focus-instance", (p) => {
      if (p?.instanceId) currentId.value = p.instanceId;
    });
  }
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

// 群聊广播（P2-4 多群）：发给当前群的在线成员（queue 忙不插话 + group 归属）；不强制回复。
function sendGroup() {
  const text = composer.value.trim();
  if (!text) return;
  const g = groups.value.find((x) => x.id === selectedGroupId.value);
  const members =
    !g || g.system ? instancesState.instances.value.map((m) => m.id) : g.members;
  const targets = members.filter((id) => runtimes.value[id]?.online === true);
  if (targets.length === 0) return;
  const groupRef = { id: g?.id ?? "general", name: g?.name ?? "全员群" };
  composer.value = "";
  for (const id of targets) {
    void getChat(id)?.send({ content: text, queue: true, group: groupRef });
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

// 群聊合并流（P2-3/P2-4）：只收挂 group 标的流量（用户群广播、实例群发言及其回复）；
// 纯私聊流量（含实例间私聊）不进群视图。同一消息的多实例副本按归属群+内容+来源+3s 去重。
const mergedMessages = computed<ChatMessage[]>(() => {
  const items: ChatMessage[] = [];
  for (const m of instancesState.instances.value) {
    const c = getChat(m.id);
    if (!c) continue;
    for (const msg of c.messages.value) {
      if (msg.group !== true) continue;
      const withGroup = { ...msg, groupId: msg.groupId ?? "general" };
      if (msg.origin === "peer" && msg.from) {
        items.push({ ...withGroup, from: nameOf.value[msg.from] ?? msg.from });
      } else if (msg.kind === "assistant") {
        items.push({ ...withGroup, from: nameOf.value[m.id] ?? m.id });
      } else {
        items.push({ ...withGroup });
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
          k.groupId === m.groupId &&
          k.content === m.content &&
          Math.abs(k.time - m.time) <= 3000,
      );
      if (dup) continue;
    }
    out.push(m);
  }
  return out;
});

// 合并流按归属群分桶：侧栏群行预览 + 当前群视图共用。
const mergedByGroup = computed<Map<string, ChatMessage[]>>(() => {
  const map = new Map<string, ChatMessage[]>();
  for (const m of mergedMessages.value) {
    const arr = map.get(m.groupId ?? "general");
    if (arr) arr.push(m);
    else map.set(m.groupId ?? "general", [m]);
  }
  return map;
});

// ---------- 未读计数（侧栏收尾）：实例行 + 群行 ----------
const unread = createUnreadTracker(currentId);
const convSignals = computed<Record<string, ConvSignal>>(() => {
  const out: Record<string, ConvSignal> = {};
  for (const m of instancesState.instances.value) {
    const msgs = getChat(m.id)?.messages.value ?? [];
    const last = msgs[msgs.length - 1];
    if (last) out[m.id] = { sid: last.id, incoming: isIncomingMessage(last) };
  }
  for (const [gid, bucket] of mergedByGroup.value) {
    const last = bucket[bucket.length - 1];
    if (last) out[`${GROUP_PREFIX}${gid}`] = { sid: last.id, incoming: isIncomingMessage(last) };
  }
  return out;
});
watch(convSignals, (signals) => unread.observe(signals));
watch(currentId, (id) => unread.clear(id));

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
      unread: unread.counts.value[m.id] ?? 0,
    };
  });
  // 群行置顶（P2-4 多群）：按群清单逐行，预览取该群合并流最后一条。
  const groupRail: RailRow[] = groups.value.map((g) => {
    const msgs = mergedByGroup.value.get(g.id) ?? [];
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
    const members = g.system ? list.map((m) => m.id) : g.members;
    return {
      id: `${GROUP_PREFIX}${g.id}`,
      name: g.name,
      avatar: null,
      preview: last
        ? last.content.replace(/\s+/g, " ").slice(0, 30)
        : g.system
          ? "多实例共同会话"
          : "群聊",
      timeText: last ? fmtClock(last.time) : "",
      online: members.some((id) => runtimes.value[id]?.online === true),
      busy: false,
      unread: unread.counts.value[`${GROUP_PREFIX}${g.id}`] ?? 0,
    };
  });
  return [...groupRail, ...rows];
});

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 来源徽标解析实例名（peer 消息 from=id → 展示名）；id 保留不可解析时兜底。
const displayMessages = computed<ChatMessage[]>(() => {
  if (isGroup.value) return mergedByGroup.value.get(selectedGroupId.value) ?? [];
  return messages.value.map((m) =>
    m.origin === "peer" && m.from ? { ...m, from: nameOf.value[m.from] ?? m.from } : m,
  );
});

// 群管理面板（P2-4 二期）：当前群行 + 成员/改名/移出/解散/邀请记录。
const currentGroup = computed(() => groups.value.find((g) => g.id === selectedGroupId.value));
const instanceRows = computed(() =>
  instancesState.instances.value.map((m) => ({ id: m.id, name: nameOf.value[m.id] ?? m.id })),
);
const onlineMap = computed<Record<string, boolean>>(() => {
  const map: Record<string, boolean> = {};
  for (const [id, r] of Object.entries(runtimes.value)) map[id] = r.online === true;
  return map;
});
function onGroupDissolved() {
  unread.clear(`${GROUP_PREFIX}${selectedGroupId.value}`);
  void refreshGroups();
  // 解散的群若是当前会话，退回默认私聊视图。
  if (isGroup.value) currentId.value = "default";
}
</script>

<template>
  <div class="chat-shell">
    <InstanceSidebar v-model="currentId" :rows="railRows" />
    <div class="chat-main">
      <GroupManage
        v-if="isGroup && currentGroup"
        :group="currentGroup"
        :names="nameOf"
        :instances="instanceRows"
        :online="onlineMap"
        @changed="refreshGroups"
        @dissolved="onGroupDissolved"
      />
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
