<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { usePluginsTab } from "./composables/usePluginsTab";
import { usePluginConfigs } from "./composables/usePluginConfigs";
import PluginConfigForm from "./children/PluginConfigForm.vue";

const {
  plugins,
  loading,
  busyId,
  error,
  hint,
  activeProfile,
  native,
  profileBusy,
  installSpec,
  installBusy,
  bindSidecarReadyTip,
  refresh,
  onToggle,
  onSwitchProfile,
  onInstall,
  onUninstall,
  dispose,
} = usePluginsTab();

const { configMap, draft, loadPluginConfigs, onSaveConfig } = usePluginConfigs(hint);

onMounted(() => {
  bindSidecarReadyTip();
  void refresh();
  void loadPluginConfigs();
});

onBeforeUnmount(() => dispose());

function hasConfig(p: { id: string }) {
  return !!configMap.value[p.id]?.hasConfig;
}
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
    <PluginConfigForm
      v-if="hasConfig(p)"
      :plugin-id="p.id"
      :config="configMap[p.id]"
      :draft="draft[p.id]"
      :busy="busyId === p.id"
      @save="onSaveConfig"
    />
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
