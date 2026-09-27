<script setup lang="ts">
// 实例会话侧栏（P2-3 私聊，QQ 式）：头像 + 名称 + 最后消息预览 + 时间 + 在线点。
// 纯展示 + 选择；行数据由 ChatView 汇总（清单 + 注册表 + 会话池预览）。
// 私聊行 = 实例头像（随实例头像变更即时刷新）；群行 = 群头像（首字渐变块回退）。
import AssistantAvatar from "./AssistantAvatar.vue";
import GroupAvatarMark from "./GroupAvatarMark.vue";

export interface RailRow {
  id: string;
  name: string;
  /** 私聊行 = 实例 id（按实例取头像）；群行 = null */
  instanceId: string | null;
  /** 群行 = 群 id（按群取头像）；私聊行 = null */
  groupId: string | null;
  preview: string;
  timeText: string;
  online: boolean;
  busy: boolean;
  /** 未读数（0 = 无；>0 显示徽标）。 */
  unread: number;
}

defineProps<{ rows: RailRow[] }>();
const model = defineModel<string>({ required: true });
</script>

<template>
  <aside class="rail">
    <div class="rail-head">会话</div>
    <button
      v-for="row in rows"
      :key="row.id"
      class="rail-row"
      :class="{ active: row.id === model }"
      @click="model = row.id"
    >
      <AssistantAvatar
        v-if="row.instanceId"
        :size="38"
        variant="rail"
        :instance-id="row.instanceId"
      />
      <GroupAvatarMark
        v-else-if="row.groupId"
        :group-id="row.groupId"
        :name="row.name"
        :size="38"
        :radius="8"
      />
      <div v-else class="avatar">{{ row.name.slice(0, 1) }}</div>
      <div class="col">
        <div class="line1">
          <span class="name">{{ row.name }}</span>
          <span class="time">{{ row.timeText }}</span>
          <span v-if="row.unread > 0" class="badge">{{ row.unread > 99 ? "99+" : row.unread }}</span>
        </div>
        <div class="line2">
          <span class="preview">{{ row.preview }}</span>
          <span class="dot" :class="{ on: row.online, busy: row.busy }"></span>
        </div>
      </div>
    </button>
  </aside>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  width: 196px;
  flex-shrink: 0;
  border-right: 1px solid var(--line, rgba(0, 0, 0, 0.08));
  background: var(--panel, rgba(0, 0, 0, 0.02));
  overflow-y: auto;
}
.rail-head {
  padding: 10px 12px 6px;
  font-size: 12px;
  color: var(--muted, #888);
}
.rail-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  width: 100%;
}
.rail-row:hover {
  background: rgba(0, 0, 0, 0.04);
}
.rail-row.active {
  background: rgba(64, 128, 255, 0.12);
}
.avatar {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: #fff;
  background: linear-gradient(135deg, #6ea8fe, #8f6fe8);
}
.col {
  min-width: 0;
  flex: 1;
}
.line1 {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.name {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg, #222);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.time {
  font-size: 10px;
  color: var(--muted, #999);
  flex-shrink: 0;
}
.badge {
  flex-shrink: 0;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: #e5484d;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.line2 {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}
.preview {
  font-size: 11px;
  color: var(--muted, #888);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #c4c4c4;
}
.dot.on {
  background: #34c759;
}
.dot.on.busy {
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
</style>
