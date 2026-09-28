<script setup lang="ts">
// 群管理 · 成员列表区块（在线点 + 名称 + 移出按钮）。
// 管理动作经 kick 上抛（确认与 IPC 在父级）；系统全员群不可移出。
export interface GroupMemberRow {
  id: string;
  name: string;
  online: boolean;
  removable: boolean;
}

defineProps<{
  rows: GroupMemberRow[];
  working: boolean;
}>();

const emit = defineEmits<{ kick: [id: string, name: string] }>();
</script>

<template>
  <ul class="gm-members">
    <li v-for="m in rows" :key="m.id" class="gm-member">
      <span class="dot" :class="{ on: m.online }"></span>
      <span class="mname">{{ m.name }}</span>
      <span class="mid">{{ m.id }}</span>
      <button
        v-if="m.removable"
        class="kick"
        :disabled="working"
        @click="emit('kick', m.id, m.name)"
      >
        移出
      </button>
    </li>
  </ul>
</template>

<style scoped>
.gm-members {
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
</style>
