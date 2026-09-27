<script setup lang="ts">
// 群管理面板（P2-4 二期）：成员列表 / 改名 / 移出成员（拍板「用户事后可撤人」）/
// 解散群 / 邀请记录。系统全员群只读（成员动态跟随实例增删，纯展示）。
// 管理动作由壳层发起，群系统事件统一 inject（收听不吵）；失败不回滚，仅提示。
import { computed, ref, watch } from "vue";
import {
  deleteGroup,
  listGroupInvites,
  removeGroupMember,
  renameGroup,
  type GroupInvite,
  type GroupRow,
} from "../ipc/group";

const props = defineProps<{
  group: GroupRow;
  /** 实例 id → 显示名。 */
  names: Record<string, string>;
  /** 全部实例（系统群的动态成员展示）。 */
  instances: Array<{ id: string; name: string }>;
  /** 实例 id → 在线。 */
  online: Record<string, boolean>;
}>();
const emit = defineEmits<{ changed: []; dissolved: [] }>();

const open = ref(false);
const nameInput = ref("");
const invites = ref<GroupInvite[]>([]);
const notice = ref("");
const working = ref(false);

watch(
  () => [props.group.id, open.value] as const,
  () => {
    void refreshInvites();
    if (open.value) {
      nameInput.value = props.group.name;
      notice.value = "";
    }
  },
  { immediate: true },
);

async function refreshInvites() {
  try {
    invites.value = await listGroupInvites(props.group.id);
  } catch {
    invites.value = [];
  }
}

const memberRows = computed(() => {
  if (props.group.system) {
    return props.instances.map((m) => ({
      id: m.id,
      name: m.name,
      online: props.online[m.id] === true,
      removable: false,
    }));
  }
  return props.group.members.map((id) => ({
    id,
    name: props.names[id] ?? id,
    online: props.online[id] === true,
    removable: true,
  }));
});

const nameDirty = computed(() => {
  const v = nameInput.value.trim();
  return v !== "" && v !== props.group.name;
});

function noticeOf(outcome: { delivered: string[]; failed: Array<{ to: string; error: string }> }): string {
  if (outcome.failed.length === 0) return `已通知 ${outcome.delivered.length} 名在线成员`;
  return `已通知 ${outcome.delivered.length} 人，${outcome.failed.length} 人未送达`;
}

async function guard(fn: () => Promise<void>) {
  if (working.value) return;
  working.value = true;
  notice.value = "";
  try {
    await fn();
  } catch (err) {
    notice.value = String(err);
  } finally {
    working.value = false;
  }
}

function saveName() {
  const name = nameInput.value.trim();
  if (!nameDirty.value) return;
  void guard(async () => {
    const outcome = await renameGroup(props.group.id, name);
    notice.value = `已更名为「${name}」·${noticeOf(outcome)}`;
    emit("changed");
  });
}

function kick(id: string, name: string) {
  if (!window.confirm(`把「${name}」移出群聊「${props.group.name}」？`)) return;
  void guard(async () => {
    const outcome = await removeGroupMember(props.group.id, id);
    notice.value = `已移出「${name}」·${noticeOf(outcome)}`;
    emit("changed");
  });
}

function dissolve() {
  if (!window.confirm(`解散群聊「${props.group.name}」？成员将收到解散通知，此操作不可撤销。`)) return;
  void guard(async () => {
    await deleteGroup(props.group.id);
    emit("dissolved");
  });
}

const STATUS_TEXT: Record<string, string> = {
  pending: "待回应",
  accepted: "已加入",
  declined: "已婉拒",
};

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
</script>

<template>
  <div class="gm" :class="{ open }">
    <button class="gm-bar" @click="open = !open">
      <span class="gm-name">{{ group.name }}</span>
      <span class="gm-meta">{{ memberRows.length }} 名成员</span>
      <span class="gm-toggle">{{ open ? "收起" : "群管理" }}</span>
    </button>

    <div v-if="open" class="gm-panel">
      <p v-if="notice" class="gm-notice">{{ notice }}</p>

      <section class="gm-sec">
        <h4>成员</h4>
        <p v-if="group.system" class="gm-hint">系统全员群：成员动态跟随实例增删，不可移出。</p>
        <ul class="gm-members">
          <li v-for="m in memberRows" :key="m.id" class="gm-member">
            <span class="dot" :class="{ on: m.online }"></span>
            <span class="mname">{{ m.name }}</span>
            <span class="mid">{{ m.id }}</span>
            <button
              v-if="m.removable"
              class="kick"
              :disabled="working"
              @click="kick(m.id, m.name)"
            >
              移出
            </button>
          </li>
        </ul>
      </section>

      <section v-if="!group.system" class="gm-sec">
        <h4>群名称</h4>
        <div class="gm-rename">
          <input
            v-model="nameInput"
            :disabled="working"
            maxlength="24"
            placeholder="群名称"
            @keydown.enter="saveName"
          />
          <button :disabled="working || !nameDirty" @click="saveName">保存</button>
        </div>
      </section>

      <section class="gm-sec">
        <h4>邀请记录</h4>
        <p v-if="invites.length === 0" class="gm-hint">暂无邀请记录。</p>
        <ul class="gm-invites">
          <li v-for="inv in invites" :key="inv.id" class="gm-invite">
            <span class="iline">
              {{ names[inv.from] ?? inv.from }} → {{ names[inv.to] ?? inv.to }}
              <span class="chip" :class="inv.status">{{ STATUS_TEXT[inv.status] ?? inv.status }}</span>
            </span>
            <span class="iline dim">
              {{ inv.message || "（无留言）" }}
              <template v-if="inv.status === 'declined' && inv.reason">· 理由：{{ inv.reason }}</template>
              · {{ fmtTime(inv.at) }}
            </span>
          </li>
        </ul>
      </section>

      <section v-if="!group.system" class="gm-sec gm-danger">
        <button class="dissolve" :disabled="working" @click="dissolve">解散群聊</button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.gm {
  border-bottom: 1px solid var(--line, rgba(0, 0, 0, 0.08));
  background: var(--panel, rgba(0, 0, 0, 0.02));
  flex-shrink: 0;
}
.gm-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 14px;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
}
.gm-bar:hover {
  background: rgba(0, 0, 0, 0.03);
}
.gm-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg, #222);
}
.gm-meta {
  font-size: 12px;
  color: var(--muted, #888);
  flex: 1;
}
.gm-toggle {
  font-size: 12px;
  color: var(--accent, #4080ff);
}
.gm-panel {
  padding: 4px 14px 12px;
  max-height: 260px;
  overflow-y: auto;
}
.gm-notice {
  margin: 4px 0;
  font-size: 12px;
  color: var(--accent, #4080ff);
}
.gm-sec {
  margin-top: 8px;
}
.gm-sec h4 {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--muted, #888);
  font-weight: 600;
}
.gm-hint {
  margin: 2px 0 6px;
  font-size: 11px;
  color: var(--muted, #999);
}
.gm-members,
.gm-invites {
  list-style: none;
  margin: 0;
  padding: 0;
}
.gm-member {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 13px;
}
.mname {
  color: var(--fg, #222);
}
.mid {
  font-size: 11px;
  color: var(--muted, #999);
  flex: 1;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #c4c4c4;
  flex-shrink: 0;
}
.dot.on {
  background: #34c759;
}
.kick {
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: none;
  border-radius: 6px;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  color: var(--fg, #444);
}
.kick:hover {
  border-color: #e5484d;
  color: #e5484d;
}
.gm-rename {
  display: flex;
  gap: 6px;
}
.gm-rename input {
  flex: 1;
  max-width: 240px;
  padding: 5px 8px;
  border: 1px solid var(--line, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  font-size: 13px;
}
.gm-rename button {
  border: none;
  border-radius: 6px;
  background: var(--accent, #4080ff);
  color: #fff;
  font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
}
.gm-rename button:disabled {
  opacity: 0.4;
  cursor: default;
}
.iline {
  display: block;
  font-size: 12px;
  color: var(--fg, #333);
}
.iline.dim {
  color: var(--muted, #999);
  font-size: 11px;
}
.chip {
  display: inline-block;
  margin-left: 6px;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.06);
}
.chip.pending {
  background: rgba(255, 170, 0, 0.18);
  color: #9a6700;
}
.chip.accepted {
  background: rgba(52, 199, 89, 0.15);
  color: #1a7f37;
}
.chip.declined {
  background: rgba(229, 72, 77, 0.12);
  color: #c22a2f;
}
.dissolve {
  border: 1px solid rgba(229, 72, 77, 0.5);
  background: none;
  color: #e5484d;
  border-radius: 6px;
  font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
}
.dissolve:hover {
  background: rgba(229, 72, 77, 0.08);
}
</style>
