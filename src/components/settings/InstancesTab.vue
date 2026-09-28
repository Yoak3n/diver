<script setup lang="ts">
// 设置页「实例」页：实例清单增删改（壳层元配置 instances.json）。
// P0 边界：只登记不启动；实例内设置（人格/模型/插件集）不在此编辑。
// 分层：InstanceRow.vue 单实例卡片行；本文件做清单装配、改名编辑态与管理动作。
import { onBeforeUnmount, onMounted, ref } from "vue";
import { tauriAvailable, type InstanceMeta } from "../../tauri";
import { useInstances } from "../../composables/useInstances";
import { useInstancePet } from "../../composables/useInstancePet";
import InstanceRow from "./InstanceRow.vue";

const { instances, loading, error, notice, refresh, create, rename, clearName, toggle, setAutoRead, remove } =
  useInstances();

const newName = ref("");
const creating = ref(false);
const editingId = ref("");
const editingName = ref("");

// P2-5 多桌宠：召唤/收起 + 每实例模型槽（逻辑收口在 useInstancePet）。
const {
  petBusy,
  petMsg,
  modelProfiles,
  loadCatalog,
  refreshPets,
  petOn,
  togglePet,
  onModelChange,
} = useInstancePet();

// 桌宠在屏状态也会被本页之外的动作改动（启动自动开经典窗等）：停留期间定时重读，
// 按钮跟实际状态一致，而不是停在进页面那一刻的快照上。
let petTimer: number | null = null;

onMounted(() => {
  void refresh();
  void refreshPets();
  void loadCatalog();
  petTimer = window.setInterval(() => void refreshPets(), 4000);
});

onBeforeUnmount(() => {
  if (petTimer !== null) window.clearInterval(petTimer);
  petTimer = null;
});

async function onCreate(): Promise<void> {
  creating.value = true;
  const ok = await create(newName.value.trim() || undefined);
  creating.value = false;
  if (ok) newName.value = "";
}

function startRename(inst: InstanceMeta): void {
  editingId.value = inst.id;
  editingName.value = inst.name ?? "";
}

function cancelRename(): void {
  editingId.value = "";
  editingName.value = "";
}

async function confirmRename(inst: InstanceMeta): Promise<void> {
  const name = editingName.value.trim();
  // 留空 = 不修改（清空是独立入口「清空名字」，会同步清人格卡片）
  if (!name || name === (inst.name ?? "")) {
    cancelRename();
    return;
  }
  if (await rename(inst.id, name)) cancelRename();
}

function onClearName(inst: InstanceMeta): void {
  const label = inst.name ? `「${inst.name}」` : ` ${inst.id} `;
  if (!window.confirm(`清空${label}的名字，回到未命名？人格卡片里的名字一并清空，之后可重新命名。`))
    return;
  void clearName(inst.id);
}

function onDelete(inst: InstanceMeta): void {
  const label = inst.name ? `「${inst.name}」` : ` ${inst.id} `;
  if (!window.confirm(`删除实例${label}？仅移除登记，数据目录清理随 P1 落地。`)) return;
  void remove(inst.id);
}
</script>

<template>
  <label class="group-title">实例清单</label>
  <p class="hint">
    每个实例拥有独立的记忆 / 会话 / 人格 / 插件配置。命名可选：名字通常由你与它聊天后经人格卡片回填，
    创建时也可直接命名；人格 / 插件集在各自的实例设置里配置。此处可为每个实例指定桌宠模型
    （默认跟随全局，选定后该实例的桌宠钉定用它）；点击实例头像可单独更换，
    悬停角标 × 恢复默认（群聊按发送实例显示）。
  </p>

  <div class="create-row">
    <input
      v-model="newName"
      class="name-input"
      placeholder="实例名称（可选，可留空稍后由人格卡片回填）"
      maxlength="32"
      :disabled="!tauriAvailable() || creating"
      @keyup.enter="onCreate"
    />
    <button class="btn small" :disabled="!tauriAvailable() || creating" @click="onCreate">
      {{ creating ? "登记中…" : "新建实例" }}
    </button>
  </div>

  <div v-if="notice" class="ok-msg">{{ notice }}</div>
  <div v-if="error" class="error-msg">{{ error }}</div>

  <div class="instance-list">
    <InstanceRow
      v-for="inst in instances"
      :key="inst.id"
      :inst="inst"
      :editing="editingId === inst.id"
      v-model:editing-name="editingName"
      :model-profiles="modelProfiles"
      :pet-active="petOn(inst)"
      :pet-busy="petBusy === inst.id"
      @start-rename="startRename"
      @cancel-rename="cancelRename"
      @confirm-rename="confirmRename"
      @clear-name="onClearName"
      @delete="onDelete"
      @toggle="toggle"
      @toggle-auto-read="setAutoRead"
      @toggle-pet="togglePet"
      @model-change="onModelChange"
    />
    <p v-if="!loading && instances.length === 0 && !error" class="hint">暂无实例登记。</p>
    <p v-if="petMsg" class="hint">{{ petMsg }}</p>
  </div>

  <p class="hint">
    「启用」控制是否随应用启动（P1 起生效）；「自动朗读」控制该实例的回复是否朗读
    （自动朗读 = 语音总开关 AND 本开关，群聊一律不朗读）；
    改名留空 = 不修改，「清空名字」才回到未命名（同步清人格卡片，命名流程可重来）；
    默认实例不可删除（旧数据零迁移保留）。
  </p>
</template>

<style scoped>
.group-title {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-dim);
  letter-spacing: 0.06em;
  margin-top: 4px;
}
.hint {
  font-size: 11px;
  color: var(--ink-dim);
  margin: 0;
  line-height: 1.7;
}
.create-row {
  display: flex;
  gap: 8px;
  align-items: center;
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
.instance-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
