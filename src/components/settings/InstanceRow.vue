<script setup lang="ts">
// 设置页「实例」页 · 单实例卡片行（头像 / 改名编辑态 / 桌宠模型槽 / 启用 / 自动朗读 / 动作）。
// 纯展示 + 事件上抛：改名态由父级持有（保存失败保留编辑），管理动作的确认与 IPC 在父级。
import { computed, ref } from "vue";
import { tauriAvailable, type InstanceMeta, type InstanceTtsProfile } from "../../tauri";
import type { PetModelProfile } from "../../pet/models";
import { Badge, Button, Input, Select } from "../../plugin-ui";
import InstanceAvatar from "./children/InstanceAvatar.vue";
import InstanceTtsPanel from "./children/InstanceTtsPanel.vue";

const props = defineProps<{
  inst: InstanceMeta;
  /** 本行处于改名编辑态。 */
  editing: boolean;
  /** 桌宠模型候选（同页共享目录）。 */
  modelProfiles: PetModelProfile[];
  /** 该实例桌宠是否在屏。 */
  petActive: boolean;
  /** 本行桌宠召唤/收起进行中。 */
  petBusy: boolean;
  /** QQ（OneBot）归属实例 id：全局单选，勾选即取代其它实例的绑定。 */
  qqOwner: string | null;
}>();

const editingName = defineModel<string>("editingName", { default: "" });

/** 音色面板展开态。 */
const ttsOpen = ref(false);

const emit = defineEmits<{
  startRename: [inst: InstanceMeta];
  cancelRename: [];
  confirmRename: [inst: InstanceMeta];
  clearName: [inst: InstanceMeta];
  delete: [inst: InstanceMeta];
  toggle: [id: string, enabled: boolean];
  toggleAutoRead: [id: string, autoRead: boolean];
  toggleQq: [id: string, on: boolean];
  togglePet: [inst: InstanceMeta];
  modelChange: [inst: InstanceMeta, value: string];
  setTtsProfile: [id: string, tts: InstanceTtsProfile | null];
}>();

/** 展示名：未命名时回退占位（名字通常由人格卡片在聊天后回填）。 */
function displayName(inst: InstanceMeta): string {
  return inst.name || "未命名";
}

function formatDate(unix: number): string {
  return unix ? new Date(unix * 1000).toLocaleDateString() : "—";
}

const modelOptions = computed(() => [
  { value: "", label: "跟随全局模型" },
  ...props.modelProfiles.map((model) => ({
    value: model.id,
    label: model.label,
  })),
]);
</script>

<template>
  <div class="instance-card">
    <InstanceAvatar :instance-id="inst.id" :name="inst.name" />
    <div class="meta">
      <template v-if="editing">
        <Input
          v-model="editingName"
          class="name-input"
          size="sm"
          maxlength="32"
          @keyup.enter="emit('confirmRename', inst)"
          @keyup.escape="emit('cancelRename')"
        />
      </template>
      <template v-else>
        <div class="name-row">
          <span class="name" :class="{ unnamed: !inst.name }">{{ displayName(inst) }}</span>
          <Badge v-if="inst.id === 'default'">默认</Badge>
        </div>
        <div class="id-row">id：{{ inst.id }} · 登记于 {{ formatDate(inst.createdAt) }}</div>
      </template>
    </div>
    <Select
      class="model-select"
      size="sm"
      :model-value="inst.petModel ?? ''"
      :options="modelOptions"
      :disabled="!tauriAvailable()"
      title="桌宠模型：跟随全局或为该实例固定"
      @update:model-value="emit('modelChange', inst, $event)"
    />
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
    <label class="toggle">
      <input
        type="checkbox"
        :checked="qqOwner === inst.id"
        :disabled="!tauriAvailable()"
        title="接 QQ：全局单选，勾选即取代其它实例；仅该实例的 OneBot 插件连接（配置见设置「QQ 接入」页，重启应用后生效）"
        @change="emit('toggleQq', inst.id, ($event.target as HTMLInputElement).checked)"
      />
      接 QQ
    </label>
    <template v-if="editing">
      <Button size="sm" @click="emit('confirmRename', inst)">保存</Button>
      <Button size="sm" @click="emit('cancelRename')">取消</Button>
    </template>
    <template v-else>
      <Button
        size="sm"
        :disabled="!tauriAvailable() || petBusy"
        @click="emit('togglePet', inst)"
      >
        {{ petActive ? "收起桌宠" : "召唤桌宠" }}
      </Button>
      <Button size="sm" :disabled="!tauriAvailable()" @click="emit('startRename', inst)">
        改名
      </Button>
      <Button size="sm" :disabled="!tauriAvailable()" @click="ttsOpen = !ttsOpen">
        {{ ttsOpen ? "收起音色" : "音色" }}
      </Button>
      <Button
        v-if="inst.name"
        size="sm"
        :disabled="!tauriAvailable()"
        @click="emit('clearName', inst)"
      >
        清空名字
      </Button>
      <Button
        variant="danger"
        size="sm"
        :disabled="!tauriAvailable() || inst.id === 'default'"
        @click="emit('delete', inst)"
      >
        删除
      </Button>
    </template>
    <InstanceTtsPanel
      v-if="ttsOpen"
      :inst="inst"
      @save="(p) => emit('setTtsProfile', inst.id, p)"
    />
  </div>
</template>

<style scoped>
.instance-card {
  display: flex;
  flex-wrap: wrap;
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
}
</style>
