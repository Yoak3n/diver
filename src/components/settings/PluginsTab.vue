<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  listPluginsApi,
  togglePluginApi,
  switchProfileApi,
  installProfilePluginApi,
  uninstallProfilePluginApi,
  getNativeStatusApi,
  type PluginInfo,
  type NativeStatus,
} from "../../api";

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
    hint.value = enabled
      ? `已启用「${plugin.displayName}」，sidecar 正在重启…`
      : `已禁用「${plugin.displayName}」，sidecar 正在重启…`;
  } catch (e) {
    error.value = String(e);
    await refresh();
  } finally {
    busyId.value = null;
  }
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
    hint.value =
      profile === "safe"
        ? "已切换安全模式（核心 + 后端），sidecar 重启中…"
        : "已切回 companion 完整组合，sidecar 重启中…";
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
    hint.value = `已安装 ${spec}，sidecar 重启中…`;
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
    hint.value = `已卸载 ${p.packageName}，sidecar 重启中…`;
  } catch (e) {
    error.value = String(e);
  } finally {
    busyId.value = null;
    await refresh().catch(() => {});
  }
}

onMounted(() => {
  void refresh();
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
  padding: 10px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
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
  color: #c9c6da;
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
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: #e8e6f0;
  padding: 6px 10px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.plugin-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.plugin-kind {
  margin-top: 4px;
  font-size: 11px;
  color: #8ec8a0;
}
.btn.small.danger {
  color: #e0a0a0;
  border-color: rgba(224, 160, 160, 0.35);
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
  color: #eee;
}
.plugin-id {
  font-size: 12px;
  opacity: 0.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.plugin-desc {
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.75;
  line-height: 1.4;
}
.plugin-advisory {
  margin-top: 4px;
  font-size: 12px;
  color: #d4a574;
}
.badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.15);
}
.badge.warn {
  color: #e0b070;
  border-color: rgba(224, 176, 112, 0.4);
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
  opacity: 0.9;
}
.hint {
  font-size: 12px;
  opacity: 0.65;
  line-height: 1.45;
  margin: 0 0 8px;
}
.error-msg {
  color: #f0a0a0;
  font-size: 12px;
  margin-bottom: 8px;
}
.ok-msg {
  color: #9dcea0;
  font-size: 12px;
  margin-top: 8px;
}
.switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 22px;
  flex-shrink: 0;
  margin-top: 2px;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 999px;
  transition: 0.15s;
}
.slider:before {
  position: absolute;
  content: "";
  height: 16px;
  width: 16px;
  left: 3px;
  bottom: 3px;
  background: #ddd;
  border-radius: 50%;
  transition: 0.15s;
}
.switch input:checked + .slider {
  background: #6b8cce;
}
.switch input:checked + .slider:before {
  transform: translateX(18px);
}
.switch input:disabled + .slider {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn.small {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: #ddd;
  cursor: pointer;
}
.btn.small:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  opacity: 0.9;
}
</style>
