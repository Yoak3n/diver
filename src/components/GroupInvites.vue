<script setup lang="ts">
// 群邀请记录（只读）：待回应/已加入/已婉拒 + 婉拒理由；随群切换重拉。
import { ref, watch } from "vue";
import { listGroupInvites, type GroupInvite } from "../ipc/group";

const props = defineProps<{
  groupId: string;
  /** 实例 id → 显示名。 */
  names: Record<string, string>;
}>();

const invites = ref<GroupInvite[]>([]);

watch(
  () => props.groupId,
  async () => {
    try {
      invites.value = await listGroupInvites(props.groupId);
    } catch {
      invites.value = [];
    }
  },
  { immediate: true },
);

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
</template>

<style scoped>
.gm-hint {
  margin: 2px 0 6px;
  font-size: 11px;
  color: var(--muted, #999);
}
.gm-invites {
  list-style: none;
  margin: 0;
  padding: 0;
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
</style>
