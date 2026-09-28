<script setup lang="ts">
// 设置页「实例」页 · 单实例卡片行（头像 / 改名编辑态 / 桌宠模型槽 / 启用 / 自动朗读 / 动作）。
// 纯展示 + 事件上抛：改名态由父级持有（保存失败保留编辑），管理动作的确认与 IPC 在父级。
import { tauriAvailable, type InstanceMeta } from "../../tauri";
import type { PetModelProfile } from "../../pet/models";
import InstanceAvatar from "./children/InstanceAvatar.vue";

defineProps<{
  inst: InstanceMeta;
  /** 本行处于改名编辑态。 */
  editing: boolean;
  /** 桌宠模型候选（同页共享目录）。 */
  modelProfiles: PetModelProfile[];
  /** 该实例桌宠是否在屏。 */
  petActive: boolean;
  /** 本行桌宠召唤/收起进行中。 */
  petBusy: boolean;
}>();

const editingName = defineModel<string>("editingName", { default: "" });

const emit = defineEmits<{
  startRename: [inst: InstanceMeta];
  cancelRename: [];
  confirmRename: [inst: InstanceMeta];
  clearName: [inst: InstanceMeta];
  delete: [inst: InstanceMeta];
  toggle: [id: string, enabled: boolean];
  toggleAutoRead: [id: string, autoRead: boolean];
  togglePet: [inst: InstanceMeta];
  modelChange: [inst: InstanceMeta, value: string];
}>();

/** 展示名：未命名时回退占位（名字通常由人格卡片在聊天后回填）。 */
function displayName(inst: InstanceMeta): string {
  return inst.name || "未命名";
}

function formatDate(unix: number): string {
  return unix ? new Date(unix * 1000).toLocaleDateString() : "—";
}
</script>

<template>
  <div class="instance-card">
    <InstanceAvatar :instance-id="inst.id" :name="inst.name" />
    <div class="meta">
      <template v-if="editing">
        <input
          v-model="editingName"
          class="name-input"
          maxlength="32"
          @keyup.enter="emit('confirmRename', inst)"
          @keyup.escape="emit('cancelRename')"
        />
      </template>
      <template v-else>
        <div class="name-row">
          <span class="name" :class="{ unnamed: !inst.name }">{{ displayName(inst) }}</span>
          <span v-if="inst.id === 'default'" class="badge">默认</span>
        </div>
        <div class="id-row">id：{{ inst.id }} · 登记于 {{ formatDate(inst.createdAt) }}</div>
      </template>
    </div>
    <select
      class="model-select"
      :value="inst.petModel ?? ''"
      :disabled="!tauriAvailable()"
      title="桌宠模型：跟随全局或为该实例固定"
      @change="emit('modelChange', inst, ($event.target as HTMLSelectElement).value)"
    >
      <option value="">跟随全局模型</option>
      <option v-for="m in modelProfiles" :key="m.id" :value="m.id">{{ m.label }}</option>
    </select>
    <label class="toggle">
      <input
        type="checkbox"
        :checked="inst.enabled"
        :disabled="!tauriAvailable()"
        @change="emit('toggle', inst.id, ($event.target as HTMLInputElement).checked)"
      />
      启用
    </label>
    <label class="toggle">
      <input
        type="checkbox"
        :checked="inst.autoRead"
        :disabled="!tauriAvailable()"
        title="自动朗读：该实例的回复生成后是否朗读（还需语音总开关打开）"
        @change="emit('toggleAutoRead', inst.id, ($event.target as HTMLInputElement).checked)"
      />
      自动朗读
    </label>
    <template v-if="editing">
      <button class="btn small" @click="emit('confirmRename', inst)">保存</button>
      <button class="btn small" @click="emit('cancelRename')">取消</button>
    </template>
    <template v-else>
      <button
        class="btn small"
        :disabled="!tauriAvailable() || petBusy"
        @click="emit('togglePet', inst)"
      >
        {{ petActive ? "收起桌宠" : "召唤桌宠" }}
      </button>
      <button class="btn small" :disabled="!tauriAvailable()" @click="emit('startRename', inst)">改名</button>
      <button
        v-if="inst.name"
        class="btn small"
        :disabled="!tauriAvailable()"
        @click="emit('clearName', inst)"
      >
        清空名字
      </button>
      <button
        class="btn small danger"
        :disabled="!tauriAvailable() || inst.id === 'default'"
        @click="emit('delete', inst)"
      >
        删除
      </button>
    </template>
  </div>
</template>

<style scoped>
.instance-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--paper-sunken);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}
.meta {
  flex: 1;
  min-width: 0;
}
.name-input {
  flex: 1;
  min-width: 0;
  background: var(--paper-sunken);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  color: var(--ink);
  font-size: 12px;
  padding: 8px 10px;
  box-sizing: border-box;
  font-family: inherit;
}
.name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.name {
  font-size: 13px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.unnamed {
  color: var(--ink-dim);
  font-style: italic;
}
.badge {
  font-size: 10px;
  color: var(--ink-dim);
  border: 1px solid var(--rule-strong);
  border-radius: 999px;
  padding: 1px 6px;
}
.id-row {
  font-size: 11px;
  color: var(--ink-dim);
  margin-top: 2px;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--ink-muted);
  flex-shrink: 0;
}
.model-select {
  flex-shrink: 0;
  max-width: 128px;
  background: var(--paper-sunken);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  color: var(--ink);
  font-size: 11px;
  padding: 4px 6px;
  font-family: inherit;
}
.btn.danger {
  color: var(--ink-muted);
}
</style>
