<script setup lang="ts">
// 设置页「QQ 接入」页：OneBot 归属绑定（全局单选）+ 归属实例的 onebot 插件配置编辑。
// 归属走壳层 IPC（instances.json onebotOwner）；配置表单经 json() 按实例寻址
// 直连归属实例的 backend（运行时注册表水合端口，P2-3 通道），未绑定 / 未运行无配置面。
import { computed, onMounted, ref } from "vue";
import { useInstances } from "../../composables/useInstances";
import {
  getPluginConfigsApi,
  savePluginConfigApi,
  refreshInstanceRuntimes,
  type PluginConfigView,
} from "../../api";
import PluginConfigForm from "./children/PluginConfigForm.vue";

const { instances, error, notice, onebotOwner, refresh, setQqOwner } = useInstances();

/** 单选组绑定值：'' = 未绑定，否则实例 id（reload 时与 onebotOwner 对齐）。 */
const ownerPick = ref("");
/** 运行中的实例 id 集（注册表行）；refreshInstanceRuntimes 同时水合按实例寻址表。 */
const runningIds = ref<Set<string>>(new Set());
const configView = ref<PluginConfigView | null>(null);
const draft = ref<Record<string, string | boolean>>({});
const cfgError = ref("");
const cfgNotice = ref("");
const busy = ref(false);

const ownerRunning = computed(
  () => onebotOwner.value !== null && runningIds.value.has(onebotOwner.value),
);

async function loadRuntimes(): Promise<void> {
  try {
    const rows = await refreshInstanceRuntimes();
    runningIds.value = new Set(rows.map((r) => r.id));
  } catch {
    runningIds.value = new Set();
  }
}

/** 拉归属实例的 onebot 配置面（仅在该实例运行时可达）。 */
async function loadConfig(): Promise<void> {
  configView.value = null;
  draft.value = {};
  cfgError.value = "";
  cfgNotice.value = "";
  const owner = onebotOwner.value;
  if (owner === null || !runningIds.value.has(owner)) return;
  busy.value = true;
  try {
    const res = await getPluginConfigsApi(owner);
    const view = res.plugins.find((p) => p.id === "onebot") ?? null;
    if (view === null || view.fields.length === 0) {
      cfgError.value = "该实例未暴露 OneBot 配置（插件可能已停用）";
      return;
    }
    configView.value = view;
    const values: Record<string, string | boolean> = {};
    for (const f of view.fields) {
      if (f.type === "boolean") values[f.key] = f.value === "true" || f.default === true;
      else values[f.key] = f.value ?? (f.default != null ? String(f.default) : "");
    }
    draft.value = values;
  } catch (err) {
    cfgError.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function onSave(): Promise<void> {
  const view = configView.value;
  const owner = onebotOwner.value;
  if (view === null || owner === null) return;
  const values: Record<string, string | number | boolean | null> = {};
  for (const f of view.fields) {
    const raw = draft.value[f.key];
    if (f.type === "boolean") values[f.key] = raw === true || raw === "true";
    else if (f.type === "number") {
      const s = String(raw ?? "");
      values[f.key] = s === "" ? null : Number(s);
    } else {
      values[f.key] = raw === "" || raw == null ? null : String(raw);
    }
  }
  busy.value = true;
  cfgError.value = "";
  cfgNotice.value = "";
  try {
    await savePluginConfigApi("onebot", values, owner);
    cfgNotice.value = `配置已保存到实例 ${owner}，重启应用后生效`;
  } catch (err) {
    cfgError.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

/** 归属单选：'' = 解绑；否则绑定该实例（自动取代旧归属，多选一）。 */
async function pickOwner(): Promise<void> {
  const id = ownerPick.value;
  if (id === (onebotOwner.value ?? "")) return;
  const ok =
    id === ""
      ? await setQqOwner(onebotOwner.value ?? "", false)
      : await setQqOwner(id, true);
  if (ok) await reload();
}

async function reload(): Promise<void> {
  ownerPick.value = onebotOwner.value ?? "";
  await Promise.all([refresh(), loadRuntimes()]);
  await loadConfig();
}

onMounted(reload);
</script>

<template>
  <label class="group-title">QQ（OneBot）接入</label>
  <p class="hint">
    归属全局单选：选定后仅该实例的 OneBot 插件连接 QQ，其余实例休眠（多实例配同一
    wsUrl 也不会重复回复）。连接与行为参数（wsUrl / token / 群白名单 / 插话概率等）
    保存在归属实例自己的插件配置里，在下方编辑；未配置 wsUrl 时插件保持休眠。
    绑定与配置改动均需重启应用后生效。也可在「实例」页通过每行的「接 QQ」勾选调整归属。
  </p>

  <div v-if="notice" class="ok-msg">{{ notice }}</div>
  <div v-if="error" class="error-msg">{{ error }}</div>

  <label class="group-title">归属实例</label>
  <div class="owner-picker">
    <label class="owner-option">
      <input v-model="ownerPick" type="radio" value="" @change="pickOwner" />
      未绑定（任意实例配了 wsUrl 都可连接，不推荐多实例使用）
    </label>
    <label v-for="inst in instances" :key="inst.id" class="owner-option">
      <input v-model="ownerPick" type="radio" :value="inst.id" @change="pickOwner" />
      {{ inst.name || inst.id }}
      <span v-if="!inst.enabled" class="state-note">（已停用）</span>
      <span v-if="runningIds.has(inst.id)" class="state-note run">运行中</span>
    </label>
  </div>

  <label class="group-title">连接与行为（归属实例的插件配置）</label>
  <p v-if="onebotOwner === null" class="hint">先在上方选择归属实例。</p>
  <p v-else-if="!ownerRunning" class="hint">
    实例 {{ onebotOwner }} 未在运行（未启用或未随应用启动）。启用并重启应用后，可在此编辑它的
    OneBot 配置。
  </p>
  <template v-else>
    <div v-if="cfgNotice" class="ok-msg">{{ cfgNotice }}</div>
    <div v-if="cfgError" class="error-msg">{{ cfgError }}</div>
    <PluginConfigForm
      v-if="configView"
      plugin-id="onebot"
      :config="configView"
      :draft="draft"
      :busy="busy"
      @save="onSave"
    />
    <p v-if="configView === null && cfgError === ''" class="hint">正在读取配置…</p>
  </template>

  <button class="btn small reload" @click="reload">重新加载</button>
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
.owner-picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 4px 0 12px;
}
.owner-option {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.state-note {
  font-size: 11px;
  color: var(--ink-dim);
}
.state-note.run {
  color: var(--accent, inherit);
}
.reload {
  margin-top: 12px;
}
</style>
