<script setup lang="ts">
// 群聊视图（P2-4）：合并流展示 + 群广播 fan-out + 群管理面板。
// 不借任何实例会话池当载体——busy/连接态/提问卡片等私聊概念不出现在群视图，
// 与私聊视图（PrivateChatView）互不耦合。
import { computed, ref, watch } from "vue";
import { getChat, useChat } from "../../composables/chat";
import { createGroupStream } from "../../composables/chat/groupStream";
import { createAttachmentOps } from "../../composables/chat/ttsBridge";
import { useInstances } from "../../composables/useInstances";
import { useSettings } from "../../composables/useSettings";
import { filesToAttachments } from "../../imageAttach";
import type { ChatMessage, ComposerAttachment, ToolActivity } from "../../types";
import type { GroupRow } from "../../ipc/group";
import ChatArea from "../../components/ChatArea.vue";
import ComposerBar from "../../components/ComposerBar.vue";
import GroupManage from "../../components/GroupManage.vue";

const props = defineProps<{
  groupId: string;
  /** 群清单（成员解析 + 管理面板）；由 ChatView 轮询喂入 */
  groups: GroupRow[];
  /** 实例在线图（ChatView 轮询注册表喂入） */
  online: Record<string, boolean>;
}>();

const emit = defineEmits<{ changed: []; dissolved: [] }>();

const instancesState = useInstances();
const settings = useSettings();

// 群视图订阅成员会话池（进程级幂等；成员未私聊过也有完整流量进合并流）
// 群聊**不接** TTS 源（用户定案）：群聊回复不自动朗读，自动朗读只属于私聊。
const memberIds = computed<string[]>(() => {
  const g = props.groups.find((x) => x.id === props.groupId);
  return !g || g.system
    ? instancesState.instances.value.map((m) => m.id)
    : g.members;
});
watch(
  memberIds,
  (ids) => {
    for (const id of ids) void useChat(id);
  },
  { immediate: true },
);

const { nameOf, mergedByGroup } = createGroupStream();
const messages = computed<ChatMessage[]>(() => mergedByGroup.value.get(props.groupId) ?? []);

// 历史分页聚合：任一成员还有更早消息即显示懒加载入口，触发时各池自行按锚点补
const memberChats = computed(() =>
  memberIds.value
    .map((id) => getChat(id))
    .filter((c): c is NonNullable<ReturnType<typeof getChat>> => c !== null),
);
const groupHasMore = computed(() => memberChats.value.some((c) => c.historyHasMore.value));
const groupLoadingOlder = computed(() => memberChats.value.some((c) => c.loadingOlder.value));
function loadOlderAll() {
  for (const c of memberChats.value) void c.loadOlder();
}

const currentGroup = computed(() => props.groups.find((g) => g.id === props.groupId));
const instanceRows = computed(() =>
  instancesState.instances.value.map((m) => ({ id: m.id, name: nameOf.value[m.id] ?? m.id })),
);

// 群视图自己的输入态：不挂任何实例池（图片随广播 fan-out，不再静默丢弃）
const composer = ref("");
const attachments = ref<ComposerAttachment[]>([]);
const attachOps = createAttachmentOps(attachments);

// 群视图没有「思考中」：busy/连接态/错误一律中性，成员忙态看侧栏行。
const NO_TOOLS: ToolActivity[] = [];

function send() {
  const text = composer.value.trim();
  const images = attachments.value.map((a) => ({
    mime: a.mime,
    data: a.data,
    ...(a.name !== undefined ? { name: a.name } : {}),
  }));
  if (!text && images.length === 0) return;
  const g = currentGroup.value;
  const targets = memberIds.value.filter((id) => props.online[id] === true);
  if (targets.length === 0) return;
  const groupRef = { id: g?.id ?? props.groupId, name: g?.name ?? "全员群" };
  composer.value = "";
  attachOps.clearAttachments();
  // 整次广播共享一个消息 id：成员忙时领取时间可差几分钟，合并流按 id 去重
  const clientMsgId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `g-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (const id of targets) {
    void getChat(id)?.send({
      content: text,
      queue: true,
      group: groupRef,
      images,
      clientMsgId,
    });
  }
}

async function onAddFiles(files: File[]) {
  const items = await filesToAttachments(files);
  attachOps.addAttachments(items);
}
</script>

<template>
  <div class="chat-pane">
    <GroupManage
      v-if="currentGroup"
      :group="currentGroup"
      :names="nameOf"
      :instances="instanceRows"
      :online="online"
      @changed="emit('changed')"
      @dissolved="emit('dissolved')"
    />
    <ChatArea
      :messages="messages"
      :tools="NO_TOOLS"
      :busy="false"
      :connecting="false"
      :error="null"
      :health-ok="true"
      :model-configured="true"
      :tts-enabled="settings.state.ttsEnabled"
      :tts-voice="settings.state.ttsVoice"
      :pending-question="null"
      :has-more-history="groupHasMore"
      :loading-older="groupLoadingOlder"
      :key-prefix="`group-${groupId}:`"
      group-view
      @suggestion="composer = $event"
      @load-older="loadOlderAll"
    />

    <ComposerBar
      v-model="composer"
      :can-send="composer.trim() !== '' || attachments.length > 0"
      :is-ready="true"
      :busy="false"
      :model-configured="true"
      :error="null"
      :attachments="attachments"
      @send="send"
      @add-files="onAddFiles"
      @remove-attachment="attachOps.removeAttachment"
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
