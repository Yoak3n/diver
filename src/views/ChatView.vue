<script setup lang="ts">
// 会话主视图（编排层）：侧栏（实例行 + 群行）+ 未读计数 + 视图切换。
// 私聊/群聊各自成视图（chat/PrivateChatView、chat/GroupChatView），
// 合并流计算在 composables/chat/groupStream 供侧栏预览与群视图共用。
import { computed, onMounted, ref, watch } from "vue";
import { getChat } from "../composables/chat";
import { createGroupStream } from "../composables/chat/groupStream";
import {
  createUnreadTracker,
  isIncomingMessage,
  type ConvSignal,
} from "../composables/chat/unread";
import { useInstances } from "../composables/useInstances";
import { setChrome } from "../composables/useChrome";
import { refreshInstanceRuntimes } from "../api";
import { onTauriEvent, tauriAvailable } from "../tauri";
import { listGroups, type GroupRow } from "../ipc/group";
import InstanceSidebar, { type RailRow } from "../components/InstanceSidebar.vue";
import PrivateChatView from "./chat/PrivateChatView.vue";
import GroupChatView from "./chat/GroupChatView.vue";

const instancesState = useInstances();

// 群聊（P2-4 多群）：侧栏群行 id = '@group:<gid>'，缺省全员群 general。
const GROUP_PREFIX = "@group:";
const currentId = ref("default");
const isGroup = computed(() => currentId.value.startsWith(GROUP_PREFIX));
const selectedGroupId = computed(() =>
  isGroup.value ? currentId.value.slice(GROUP_PREFIX.length) : "general",
);

// 初始会话 = 壳层 active 实例（清单第一个启用项，全停用兜底 default）：
// 硬编码 "default" 会在 default 被停用时选中一个没在运行的实例。
// 一旦用户点选或桌宠聚焦过，清单刷新不再改回。
let instancePicked = false;
function pickInstance(id: string) {
  instancePicked = true;
  currentId.value = id;
}
// 清单到达后落到 active 实例（只此一次；此后由用户点选 / 桌宠聚焦决定）。
watch(
  () => instancesState.instances.value,
  (list) => {
    if (instancePicked || list.length === 0) return;
    currentId.value = list.find((i) => i.enabled)?.id ?? "default";
  },
  { immediate: true },
);

// 群清单（壳层 groups.json）：侧栏群行 + 群视图成员解析。
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
    const rows = await refreshInstanceRuntimes();
    const map: Record<string, { online: boolean; busy: boolean }> = {};
    for (const r of rows) {
      map[r.id] = { online: true, busy: false };
    }
    runtimes.value = map;
  } catch {
    /* 注册表未就绪：侧栏降级为离线点 */
  }
}

const onlineMap = computed<Record<string, boolean>>(() => {
  const map: Record<string, boolean> = {};
  for (const [id, r] of Object.entries(runtimes.value)) map[id] = r.online === true;
  return map;
});

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
      if (p?.instanceId) pickInstance(p.instanceId);
    });
  }
});

// ---------- 群合并流（侧栏预览/未读 与 群视图共用同一份计算） ----------
const { nameOf, mergedByGroup } = createGroupStream();

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

// ---------- 侧栏行（QQ 式）：清单 × 注册表 × 会话池预览 ----------
const railRows = computed<RailRow[]>(() => {
  const list = instancesState.instances.value;
  const rows: RailRow[] = list.map((m) => {
    const c = getChat(m.id);
    const msgs = c?.messages.value ?? [];
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
    return {
      id: m.id,
      name: nameOf.value[m.id] ?? m.id,
      instanceId: m.id,
      groupId: null,
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
      instanceId: null,
      groupId: g.id,
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

// 群视图下标题栏不再跟随某个实例的会话态（那是私聊的语义）。
const selectedGroupName = computed(
  () => groups.value.find((g) => g.id === selectedGroupId.value)?.name ?? "群聊",
);
watch([isGroup, selectedGroupName], () => {
  if (isGroup.value) {
    setChrome({ statusText: selectedGroupName.value, modelLabel: "", dotClass: "on" });
  }
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
    <InstanceSidebar
      :model-value="currentId"
      :rows="railRows"
      @update:model-value="pickInstance"
    />
    <div class="chat-main">
      <PrivateChatView v-if="!isGroup" :instance-id="currentId" />
      <GroupChatView
        v-else
        :group-id="selectedGroupId"
        :groups="groups"
        :online="onlineMap"
        @changed="refreshGroups"
        @dissolved="onGroupDissolved"
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
