<script setup lang="ts">
// 设置页「实例」页：实例清单增删改（壳层元配置 instances.json）。
// P0 边界：只登记不启动；实例内设置（人格/模型/插件集）不在此编辑。
import { onMounted, ref } from "vue";
import { tauriAvailable, type InstanceMeta } from "../../tauri";
import { useInstances } from "../../composables/useInstances";

const { instances, loading, error, notice, refresh, create, rename, toggle, remove } =
  useInstances();

const newName = ref("");
const creating = ref(false);
const editingId = ref("");
const editingName = ref("");

onMounted(() => {
  void refresh();
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
  if (name === (inst.name ?? "")) {
    cancelRename();
    return;
  }
  if (await rename(inst.id, name)) cancelRename();
}

function onDelete(inst: InstanceMeta): void {
  const label = inst.name ? `「${inst.name}」` : ` ${inst.id} `;
  if (!window.confirm(`删除实例${label}？仅移除登记，数据目录清理随 P1 落地。`)) return;
  void remove(inst.id);
}

/** 展示名：未命名时回退占位（名字通常由人格卡片在聊天后回填）。 */
function displayName(inst: InstanceMeta): string {
  return inst.name || "未命名";
}

function formatDate(unix: number): string {
  return unix ? new Date(unix * 1000).toLocaleDateString() : "—";
}
</script>

<template>
  <label class="group-title">实例清单</label>
  <p class="hint">
    每个实例拥有独立的记忆 / 会话 / 人格 / 插件配置。当前版本只登记实例，
    <strong>多实例运行即将支持</strong>。命名可选：名字通常由你与它聊天后经人格卡片回填，
    创建时也可直接命名；人格 / 模型 / 插件集在各自的实例设置里配置，不在此登记。
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
    <div v-for="inst in instances" :key="inst.id" class="instance-card">
      <div class="avatar" :class="{ unnamed: !inst.name }">{{ (inst.name || "·").slice(0, 1) }}</div>
      <div class="meta">
        <template v-if="editingId === inst.id">
          <input
            v-model="editingName"
            class="name-input"
            maxlength="32"
            @keyup.enter="confirmRename(inst)"
            @keyup.escape="cancelRename"
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
      <label class="toggle">
        <input
          type="checkbox"
          :checked="inst.enabled"
          :disabled="!tauriAvailable()"
          @change="toggle(inst.id, ($event.target as HTMLInputElement).checked)"
        />
        启用
      </label>
      <template v-if="editingId === inst.id">
        <button class="btn small" @click="confirmRename(inst)">保存</button>
        <button class="btn small" @click="cancelRename">取消</button>
      </template>
      <template v-else>
        <button class="btn small" :disabled="!tauriAvailable()" @click="startRename(inst)">改名</button>
        <button
          class="btn small danger"
          :disabled="!tauriAvailable() || inst.id === 'default'"
          @click="onDelete(inst)"
        >
          删除
        </button>
      </template>
    </div>
    <p v-if="!loading && instances.length === 0 && !error" class="hint">暂无实例登记。</p>
  </div>

  <p class="hint">
    「启用」控制是否随应用启动（P1 起生效）；改名保存空值 = 清空回未命名；
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
.instance-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--paper-sunken);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}
.avatar {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--paper-active);
  color: var(--ink-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
}
.meta {
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
.btn.danger {
  color: var(--ink-muted);
}
</style>
