<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  listPluginsApi,
  togglePluginApi,
  switchProfileApi,
  installProfilePluginApi,
  uninstallProfilePluginApi,
  getNativeStatusApi,
  getPluginConfigsApi,
  savePluginConfigApi,
  type PluginConfigView,
  type PluginInfo,
  type NativeStatus,
} from "../../api";
import { onTauriEvent, tauriAvailable } from "../../tauri";
import type { SidecarStatus } from "../../types";

const plugins = ref<PluginInfo[]>([]);
const loading = ref(false);
const busyId = ref<string | null>(null);
const error = ref("");
const hint = ref("");
const activeProfile = ref("companion");
const native = ref<NativeStatus | null>(null);
const profileBusy = ref(false);
const installSpec = ref("");
const installBusy = ref(false);

/** 有重启在飞时，等 sidecar running 再把「重启中…」改成「已重启成功」。 */
let pendingRestartHint = false;
let stopSidecarListen: (() => void) | null = null;

function markRestartPending(message: string) {
  pendingRestartHint = true;
  hint.value = message;
}

function bindSidecarReadyTip() {
  if (!tauriAvailable() || stopSidecarListen) return;
  void onTauriEvent<SidecarStatus>("sidecar://status", (status) => {
    if (status.state !== "running" || !pendingRestartHint) return;
    pendingRestartHint = false;
    hint.value = hint.value
      .replace(/sidecar 正在重启…/, "sidecar 已重启成功")
      .replace(/sidecar 重启中…/, "sidecar 已重启成功");
    void refresh();
  }).then((unlisten) => {
    stopSidecarListen = unlisten;
  });
}

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    const res = await listPluginsApi();
    activeProfile.value = res.activeProfile;
    plugins.value = res.plugins;
    try {
      native.value = await getNativeStatusApi();
    } catch {
      native.value = null;
    }
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function onToggle(plugin: PluginInfo, enabled: boolean) {
  if (!plugin.toggleable) return;
  busyId.value = plugin.id;
  error.value = "";
  hint.value = "";
  try {
    const res = await togglePluginApi(plugin.id, enabled, true);
    plugins.value = res.plugins;
    activeProfile.value = res.activeProfile;
    markRestartPending(
      enabled
        ? `已启用「${plugin.displayName}」，sidecar 正在重启…`
        : `已禁用「${plugin.displayName}」，sidecar 正在重启…`,
    );
  } catch (e) {
    error.value = String(e);
    await refresh();
  } finally {
    busyId.value = null;
  }
}

// ---- 插件 config（设置页表单，Desktop model-config 风格）----
const configMap = ref<Record<string, PluginConfigView>>({});
const draft = ref<Record<string, Record<string, string | boolean>>>({});

async function loadPluginConfigs() {
  try {
    const res = await getPluginConfigsApi();
    const map: Record<string, PluginConfigView> = {};
    const drafts: Record<string, Record<string, string | boolean>> = {};
    for (const item of res.plugins) {
      map[item.id] = item;
      const values: Record<string, string | boolean> = {};
      for (const f of item.fields) {
        if (f.type === "boolean") values[f.key] = f.value === "true" || f.default === true;
        else values[f.key] = f.value ?? (f.default != null ? String(f.default) : "");
      }
      drafts[item.id] = values;
    }
    configMap.value = map;
    draft.value = drafts;
  } catch {
    configMap.value = {};
  }
}

async function onSaveConfig(id: string) {
  const fields = configMap.value[id]?.fields ?? [];
  const values: Record<string, string | number | boolean | null> = {};
  const d = draft.value[id] ?? {};
  for (const f of fields) {
    const raw = d[f.key];
    if (f.type === "boolean") {
      values[f.key] = raw === true || raw === "true";
    } else if (f.type === "number") {
      const s = String(raw ?? "");
      values[f.key] = s === "" ? null : Number(s);
    } else {
      values[f.key] = raw === "" || raw == null ? null : String(raw);
    }
  }
  await savePluginConfigApi(id, values);
  await loadPluginConfigs();
  hint.value = "插件配置已保存，sidecar 重启后生效";
}

async function onSwitchProfile(profile: "companion" | "safe") {
  if (profileBusy.value) return;
  if (activeProfile.value === profile) return;
  profileBusy.value = true;
  error.value = "";
  hint.value = "";
  try {
    const res = await switchProfileApi(profile, true);
    activeProfile.value = res.activeProfile;
    const list = await listPluginsApi();
    plugins.value = list.plugins;
    markRestartPending(
      profile === "safe"
        ? "已切换安全模式（核心 + 后端），sidecar 正在重启…"
        : "已切回 companion 完整组合，sidecar 正在重启…",
    );
  } catch (e) {
    error.value = String(e);
    await refresh();
  } finally {
    profileBusy.value = false;
  }
}

async function onInstall() {
  const spec = installSpec.value.trim();
  if (!spec || installBusy.value) return;
  installBusy.value = true;
  error.value = "";
  hint.value = "";
  try {
    const res = await installProfilePluginApi(spec, true);
    plugins.value = res.plugins;
    markRestartPending(`已安装 ${spec}，sidecar 正在重启…`);
    installSpec.value = "";
  } catch (e) {
    error.value = String(e);
  } finally {
    installBusy.value = false;
    await refresh().catch(() => {});
  }
}

async function onUninstall(p: PluginInfo) {

  if (p.kind !== "profile") return;
  busyId.value = p.id;
  error.value = "";
  hint.value = "";
  try {
    const res = await uninstallProfilePluginApi(p.id, true);
    plugins.value = res.plugins;
    markRestartPending(`已卸载 ${p.packageName}，sidecar 正在重启…`);
  } catch (e) {
    error.value = String(e);
  } finally {
    busyId.value = null;
    await refresh().catch(() => {});
  }
}

onMounted(() => {
  bindSidecarReadyTip();
  void refresh();
  void loadPluginConfigs();
});

onBeforeUnmount(() => {
  stopSidecarListen?.();
  stopSidecarListen = null;
});
</script>

<template>
  <label class="group-title">运行档案（Profile）</label>
  <div class="profile-row">
    <span class="profile-name">
      当前：<strong>{{ activeProfile }}</strong>
      <span v-if="activeProfile === 'safe'" class="badge warn">安全模式</span>
    </span>
    <span class="profile-actions">
      <button
        class="btn small"
        :disabled="profileBusy || activeProfile === 'safe'"
        @click="onSwitchProfile('safe')"
      >
        进入安全模式
      </button>
      <button
        class="btn small"
        :disabled="profileBusy || activeProfile === 'companion'"
        @click="onSwitchProfile('companion')"
      >
        回到 companion
      </button>
    </span>
  </div>
  <p class="hint">
    安全模式只加载 <code>@cos/*</code> 核心 + <code>@diver/backend</code> 传输，
    用于插件导致启动失败时恢复 UI。完整组合使用 <code>companion</code>。
  </p>
  <div v-if="native" class="hint">
    原生 RPC：{{ native.configured ? native.url : "未配置" }} ·
    {{ native.probes.filter((p) => p.ok).length }}/{{ native.probes.length }} 探测通过
  </div>

  <label class="group-title">安装 profile 插件（P4）</label>
  <div class="install-row">
    <input
      v-model="installSpec"
      class="install-input"
      type="text"
      placeholder="file:../../examples/hello-tool 或 npm 包名 / git URL"
      :disabled="installBusy || activeProfile !== 'companion'"
    />
    <button
      class="btn small"
      :disabled="installBusy || !installSpec.trim() || activeProfile !== 'companion'"
      @click="onInstall"
    >
      {{ installBusy ? "安装中…" : "安装" }}
    </button>
  </div>
  <p class="hint">
    安装进 <code>$COS_HOME/profiles/&lt;active&gt;</code>（pnpm）。internal
    （<code>@diver/*</code> / 随包 plugins）不可卸载，只能禁用。
  </p>

  <label class="group-title">插件（cos profile 启停）</label>
  <p class="hint">
    开关写入 <code>$COS_HOME/profiles/&lt;active&gt;/cordis.patch.yml</code> 的
    <code>disabled</code> 覆盖，随后重启 sidecar 生效。禁用 ≠ 卸载：包体仍在插件目录。
  </p>

  <div v-if="loading" class="hint">加载插件列表…</div>
  <div v-else-if="error" class="error-msg">{{ error }}</div>
  <div v-else-if="!plugins.length" class="hint">未发现 companion 插件（检查 cos-plugins / plugins 目录）。</div>

  <div v-for="p in plugins" :key="p.id" class="plugin-row">
    <div v-if="configMap[p.id]?.hasConfig" class="plugin-config">
      <div class="config-title">{{ configMap[p.id]?.title || p.displayName }} 配置</div>
      <label v-for="f in configMap[p.id].fields" :key="f.key" class="config-field">
        <span class="config-label">{{ f.label }}</span>
        <input
          v-if="f.type === 'boolean'"
          type="checkbox"
          v-model="draft[p.id][f.key]"
        />
        <select v-else-if="f.type === 'select'" v-model="draft[p.id][f.key]">
          <option v-for="opt in f.options || []" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <input
          v-else
          :type="f.type === 'password' || f.secret ? 'password' : f.type === 'number' ? 'number' : 'text'"
          v-model="draft[p.id][f.key]"
          :placeholder="f.default != null ? String(f.default) : ''"
        />
        <span v-if="f.description" class="config-desc">{{ f.description }}</span>
      </label>
      <button class="btn" :disabled="busyId === p.id" @click="onSaveConfig(p.id)">保存配置</button>
    </div>
    <div class="plugin-main">
      <div class="plugin-title">
        <span class="plugin-name">{{ p.displayName }}</span>
        <span class="plugin-id">{{ p.packageName }}</span>
        <span v-if="!p.present" class="badge warn">缺失</span>
        <span v-if="activeProfile === 'safe' && p.id !== 'backend'" class="badge">safe 未加载</span>
      </div>
      <div class="plugin-desc">{{ p.description || "—" }}</div>
      <div v-if="p.advisory" class="plugin-advisory">{{ p.advisory }}</div>
      <div v-if="p.kind === 'profile'" class="plugin-kind">profile 安装 · 可卸载</div>
    </div>
    <div class="plugin-actions">
      <button
        v-if="p.kind === 'profile'"
        class="btn small danger"
        :disabled="busyId === p.id || activeProfile !== 'companion'"
        @click="onUninstall(p)"
      >
        卸载
      </button>
      <label class="switch">
        <input
          type="checkbox"
          :checked="p.enabled"
          :disabled="
            !p.toggleable ||
            !p.present ||
            busyId === p.id ||
            (activeProfile === 'safe' && p.id !== 'backend')
          "
          @change="onToggle(p, ($event.target as HTMLInputElement).checked)"
        />
        <span class="slider"></span>
      </label>
    </div>
  </div>

  <div class="toolbar">
    <button class="btn small" :disabled="loading" @click="refresh">刷新</button>
  </div>
  <div v-if="hint" class="ok-msg">{{ hint }}</div>
</template>

<style scoped>
.plugin-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--rule);
}
.plugin-row:last-of-type {
  border-bottom: none;
}
.plugin-config {
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper-raised);
}
.config-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--ink);
  margin-bottom: 0.5rem;
}
.config-field {
  display: grid;
  grid-template-columns: 10rem 1fr;
  gap: 0.35rem 0.5rem;
  align-items: center;
  margin-bottom: 0.35rem;
  font-size: 0.9rem;
}
.config-label {
  color: var(--ink-soft);
  font-size: 12px;
}
.config-desc {
  grid-column: 2;
  font-size: 0.8rem;
  color: var(--ink-muted);
}
.profile-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.profile-name {
  font-size: 13px;
  color: var(--ink);
  font-weight: 500;
}
.profile-actions {
  display: flex;
  gap: 6px;
}
.install-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}
.install-input {
  flex: 1;
}
.plugin-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding-top: 2px;
}
.plugin-kind {
  margin-top: 4px;
  font-size: 11px;
  color: var(--ok);
}
.btn.small.danger {
  color: var(--err);
  border-color: var(--err-border);
}
.plugin-main {
  flex: 1;
  min-width: 0;
}
.plugin-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.plugin-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--ink);
}
.plugin-id {
  font-size: 12px;
  color: var(--ink-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.plugin-desc {
  margin-top: 4px;
  font-size: 12px;
  color: var(--ink-muted);
  line-height: 1.5;
}
.plugin-advisory {
  margin-top: 4px;
  font-size: 12px;
  color: var(--warn);
}
.badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--rule-strong);
  color: var(--ink-muted);
}
.badge.warn {
  color: var(--warn);
  border-color: var(--warn);
}
.toolbar {
  margin-top: 12px;
  display: flex;
  gap: 8px;
}
.group-title {
  display: block;
  margin: 14px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}
.hint {
  font-size: 12px;
  color: var(--ink-muted);
  line-height: 1.5;
  margin: 0 0 8px;
}
.error-msg {
  color: var(--err);
  font-size: 12px;
  margin-bottom: 8px;
}
.ok-msg {
  color: var(--ok);
  font-size: 12px;
  margin-top: 8px;
}
</style>
