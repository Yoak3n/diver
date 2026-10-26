<script setup lang="ts">
// 设置页「QQ 接入」页：OneBot 归属绑定（全局单选）+ 归属实例的 onebot 插件配置编辑。
// 归属走壳层 IPC（instances.json onebotOwner）；配置表单经 json() 按实例寻址
// 直连归属实例的 backend（运行时注册表水合端口，P2-3 通道），未绑定 / 未运行无配置面。
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useInstances } from "../../composables/useInstances";
import {
  getOnebotStatusApi,
  getPluginConfigsApi,
  savePluginConfigApi,
  refreshInstanceRuntimes,
  type OnebotStatus,
  type PluginConfigView,
} from "../../api";
import PluginConfigForm from "./children/PluginConfigForm.vue";
import {
  buildPluginConfigValues,
  type PluginConfigDraft,
} from "./children/pluginConfigValues";

const { instances, error, notice, onebotOwner, refresh, setQqOwner } = useInstances();

/** 单选组绑定值：'' = 未绑定，否则实例 id（reload 时与 onebotOwner 对齐）。 */
const ownerPick = ref("");
/** 运行中的实例 id 集（注册表行）；refreshInstanceRuntimes 同时水合按实例寻址表。 */
const runningIds = ref<Set<string>>(new Set());
const configView = ref<PluginConfigView | null>(null);
const draft = ref<PluginConfigDraft>({});
const cfgError = ref("");
const cfgNotice = ref("");
const busy = ref(false);
/** 归属实例的 OneBot 运行时状态（轮询后端状态灯接口）。 */
const status = ref<OnebotStatus | null>(null);
const statusError = ref("");
const statusBusy = ref(false);
/** 轮询句柄：设置页卸载时清掉，避免后台一直打请求。 */
let statusTimer: number | undefined;
const STATUS_POLL_MS = 3000;

const ownerRunning = computed(
  () => onebotOwner.value !== null && runningIds.value.has(onebotOwner.value),
);

/** 状态灯颜色：绿=已登录，黄=连接中，红=断开，灰=休眠/未就绪。 */
const statusTone = computed<"ok" | "warn" | "bad" | "idle">(() => {
  if (statusError.value !== "") return "bad";
  const s = status.value;
  if (s === null || !s.available) return "idle";
  if (s.state === "online") return "ok";
  if (s.state === "connecting") return "warn";
  if (s.state === "offline") return "bad";
  return "idle";
});

const statusTitle = computed(() => {
  if (onebotOwner.value === null) return "未绑定归属实例";
  if (!ownerRunning.value) return "归属实例未运行";
  if (statusError.value !== "") return "状态读取失败";
  const s = status.value;
  if (s === null) return "正在读取连接状态…";
  if (!s.available || s.state === "unavailable") return "OneBot 插件未加载";
  if (s.state === "sleeping") return "插件休眠";
  if (s.state === "online") return "已连接";
  if (s.state === "connecting") return "连接中…";
  return "未连接";
});

const statusDetail = computed(() => {
  if (onebotOwner.value === null) {
    return "先选择归属实例；绑定后这里显示它的 OneBot 连接状态。";
  }
  if (!ownerRunning.value) return "启用归属实例并重启应用后，这里会显示连接状态。";
  if (statusError.value !== "") return statusError.value;
  const s = status.value;
  if (s === null) return "";
  if (!s.available || s.state === "unavailable") {
    return "实例里没有可用的 onebot 插件（可能被停用或未安装）。";
  }
  if (s.state === "sleeping") return s.reason ?? "插件未接线";
  const target = s.url ?? "";
  if (s.state === "online") {
    const who =
      s.nickname !== undefined && s.nickname !== ""
        ? `${s.nickname}${s.selfId !== undefined ? `（${s.selfId}）` : ""}`
        : s.selfId !== undefined
          ? `QQ ${s.selfId}`
          : "OneBot";
    return [who, target].filter(Boolean).join(" · ");
  }
  if (s.state === "connecting") {
    const why =
      s.lastError !== undefined && s.lastError !== "" ? `上次失败：${s.lastError}` : "";
    return [target, why].filter(Boolean).join(" · ");
  }
  const retry =
    s.retryInMs !== undefined
      ? `${Math.max(1, Math.ceil(s.retryInMs / 1000))} 秒后重连`
      : "等待重连";
  const attempts = s.attempts !== undefined && s.attempts > 0 ? `第 ${s.attempts} 次` : "";
  return [s.lastError ?? "连接已断开", attempts, retry, target].filter(Boolean).join(" · ");
});

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
    const values: PluginConfigDraft = {};
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

/** 读归属实例的 OneBot 连接状态（状态灯；3 秒轮询 + 手动刷新）。 */
async function loadStatus(): Promise<void> {
  const owner = onebotOwner.value;
  if (owner === null || !runningIds.value.has(owner)) {
    status.value = null;
    statusError.value = "";
    return;
  }
  statusBusy.value = true;
  try {
    status.value = await getOnebotStatusApi(owner);
    statusError.value = "";
  } catch (err) {
    status.value = null;
    statusError.value = err instanceof Error ? err.message : String(err);
  } finally {
    statusBusy.value = false;
  }
}

async function onSave(): Promise<void> {
  const view = configView.value;
  const owner = onebotOwner.value;
  if (view === null || owner === null) return;
  const values = buildPluginConfigValues(view.fields, draft.value);
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
  await Promise.all([loadConfig(), loadStatus()]);
}

onMounted(() => {
  void reload();
  statusTimer = window.setInterval(() => {
    void loadStatus();
  }, STATUS_POLL_MS);
});

onUnmounted(() => {
  if (statusTimer !== undefined) window.clearInterval(statusTimer);
  statusTimer = undefined;
});
</script>

<template>
  <label class="group-title">QQ（OneBot）接入</label>
  <p class="hint">
    归属全局单选：选定后仅该实例的 OneBot 插件连接 QQ，其余实例休眠（多实例配同一
    wsUrl 也不会重复回复）。连接与行为参数（wsUrl / token / 群白名单 / 插话概率等）
    保存在归属实例自己的插件配置里，在下方编辑；未配置 wsUrl 时插件保持休眠。
    绑定与配置改动均需重启应用后生效。也可在「实例」页通过每行的「接 QQ」勾选调整归属。
    「插件」页只负责 OneBot 插件的启停，连接与行为配置统一在本页维护。
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

  <label class="group-title">连接状态</label>
  <div class="link-card" :class="`tone-${statusTone}`">
    <span class="link-dot" aria-hidden="true"></span>
    <div class="link-copy">
      <div class="link-title">{{ statusTitle }}</div>
      <div v-if="statusDetail" class="link-detail">{{ statusDetail }}</div>
    </div>
    <button
      v-if="onebotOwner !== null && ownerRunning"
      class="btn small link-refresh"
      :disabled="statusBusy"
      @click="loadStatus"
    >
      刷新
    </button>
  </div>

  <label class="group-title">连接与行为（归属实例的插件配置）</label>
  <p v-if="onebotOwner === null" class="hint">
    先在上方选择归属实例。未绑定归属时 OneBot 仍是旧的「配置即归属」行为，但本页不编辑任何实例的配置；
    绑定后即可在此维护（也可在「实例」页勾选目标实例的「接 QQ」）。
  </p>
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
.link-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  margin: 4px 0 12px;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  background: var(--paper-raised);
}
.link-dot {
  flex: none;
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border-radius: 50%;
  background: var(--ink-dim);
}
.tone-ok .link-dot {
  background: var(--ok);
  box-shadow: 0 0 0 3px rgba(47, 158, 107, 0.16);
}
.tone-warn .link-dot {
  background: var(--warn);
  box-shadow: 0 0 0 3px rgba(196, 130, 42, 0.16);
}
.tone-bad .link-dot {
  background: var(--err);
  box-shadow: 0 0 0 3px rgba(196, 75, 60, 0.16);
}
.link-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.link-title {
  font-size: 12px;
  font-weight: 500;
}
.link-detail {
  font-size: 11px;
  color: var(--ink-dim);
  line-height: 1.6;
  word-break: break-all;
}
.link-refresh {
  flex: none;
}
.reload {
  margin-top: 12px;
}
</style>
