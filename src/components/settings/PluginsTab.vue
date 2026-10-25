<script setup lang="ts">
// 设置「插件」页：实例作用域 / profile 切换 / 插件启停与配置（二级菜单）/
// profile 插件安装。
//
// 多实例：每个实例一个 sidecar、一份 COS_HOME / profile 补丁，所有插件读写都
// 按所选实例寻址；未运行实例的 backend 不可达，页面明确提示而不发请求。
// 分层：usePluginScope 管实例与运行态，usePluginsTab 管列表与 lifecycle，
// usePluginConfigs 管 config 表单；本文件只做装配与选中态。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePluginsTab } from "./composables/usePluginsTab";
import { usePluginConfigs } from "./composables/usePluginConfigs";
import { usePluginScope } from "./composables/usePluginScope";
import { isSettingsTab, type SettingsTab } from "../../composables/settings-tabs";
import PluginNav from "./children/PluginNav.vue";
import PluginDetail from "./children/PluginDetail.vue";
import PluginInstancePicker from "./children/PluginInstancePicker.vue";
import PluginProfileSection from "./children/PluginProfileSection.vue";
import PluginInstallSection from "./children/PluginInstallSection.vue";

const {
  instances,
  error: instancesError,
  selectedId,
  selectedInstance,
  runningIds,
  scopeLoading,
  isTauri,
  targetInstanceId,
  canManage,
  load: loadScope,
  refreshRunning,
  bindStatus,
  dispose: disposeScope,
} = usePluginScope();

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
  reset: resetPlugins,
  clearHint,
  onToggle,
  onSwitchProfile,
  onInstall,
  onUninstall,
  dispose,
} = usePluginsTab(() => targetInstanceId.value);

const {
  configMap,
  draft,
  configError,
  loadPluginConfigs,
  reset: resetConfigs,
  onSaveConfig,
} = usePluginConfigs(hint, () => targetInstanceId.value);

const selectedPluginId = ref("");

watch(
  plugins,
  (list) => {
    if (list.length === 0) {
      selectedPluginId.value = "";
      return;
    }
    if (!list.some((p) => p.id === selectedPluginId.value)) selectedPluginId.value = list[0].id;
  },
  { immediate: true },
);

const selectedPlugin = computed(
  () => plugins.value.find((p) => p.id === selectedPluginId.value) ?? null,
);

/** 独立设置页由后端（产品层）随配置视图下发，前端只做 tab 合法性校验。 */
const selectedConfigTab = computed(() => {
  const page = selectedPlugin.value
    ? configMap.value[selectedPlugin.value.id]?.page
    : undefined;
  if (!page || !isSettingsTab(page.tab)) return null;
  return { tab: page.tab, label: page.label };
});

const emit = defineEmits<{
  openTab: [tab: SettingsTab];
}>();

/** 未运行实例不可达：清空上一实例的残留，不发请求。 */
async function reloadPlugins() {
  // 切换实例先水合运行表：目标 sidecar 可能刚起，旧端口表会误判未运行。
  if (isTauri) await refreshRunning();
  if (!canManage.value) {
    resetPlugins();
    resetConfigs();
    return;
  }
  await Promise.all([refresh(), loadPluginConfigs()]);
}

async function reloadAll() {
  await reloadPlugins();
}

let scopeReady = false;

onMounted(async () => {
  bindSidecarReadyTip();
  bindStatus();
  await loadScope();
  scopeReady = true;
  await reloadPlugins();
});

watch(selectedId, () => clearHint());

watch([selectedId, canManage], () => {
  if (scopeReady) void reloadPlugins();
});

onBeforeUnmount(() => {
  dispose();
  disposeScope();
});
</script>

<template>
  <label class="group-title">实例</label>
  <p v-if="isTauri" class="hint">
    每个实例拥有独立的插件启停、运行档案与配置。先选实例；下面所有操作只作用于它，
    不会影响其它实例。
  </p>
  <p v-else class="hint">当前不在 Tauri 环境，插件面按 active 实例管理。</p>
  <PluginInstancePicker
    v-if="isTauri"
    :instances="instances"
    :selected-id="selectedId"
    :running-ids="runningIds"
    @select="selectedId = $event"
  />
  <div v-if="instancesError" class="error-msg">{{ instancesError }}</div>
  <div v-if="isTauri && scopeLoading" class="hint">加载实例清单…</div>
  <p v-else-if="isTauri && !instancesError && instances.length === 0" class="hint">
    暂无实例登记，请先在「实例」页新建。
  </p>
  <p v-else-if="isTauri && !canManage" class="hint">
    实例 {{ selectedInstance?.name || selectedId }} 未在运行（未启用 / 启动中 / 已崩溃）。
    插件状态与配置保存在它自己的 COS_HOME，启动该实例后即可在此管理。
  </p>
  <div v-if="isTauri && !scopeLoading && !canManage" class="scope-actions">
    <button class="btn small" @click="emit('openTab', 'instances')">打开「实例」页</button>
  </div>

  <template v-if="canManage">
    <PluginProfileSection
      :active-profile="activeProfile"
      :profile-busy="profileBusy"
      :native="native"
      :instance-name="selectedInstance?.name || selectedInstance?.id"
      @switch="onSwitchProfile"
    />

    <label class="group-title">插件</label>
    <p class="hint">
      左侧选插件，右侧看说明、启停与配置。开关与配置写入
      <code>$COS_HOME/profiles/&lt;active&gt;/cordis.patch.yml</code>，重启该实例的
      sidecar 后生效；各实例互不影响。禁用 ≠ 卸载：包体仍在插件目录。
    </p>

    <div v-if="loading" class="hint">加载插件列表…</div>
    <div v-else-if="error" class="error-msg">{{ error }}</div>
    <div v-else-if="!plugins.length" class="hint">
      未发现 companion 插件（检查 cos-plugins / plugins 目录）。
    </div>
    <template v-else>
      <div v-if="configError" class="error-msg">插件配置读取失败：{{ configError }}</div>
      <div class="plugins-layout">
        <PluginNav
          :plugins="plugins"
          :selected-id="selectedPluginId"
          @select="selectedPluginId = $event"
        />
        <PluginDetail
          v-if="selectedPlugin"
          :plugin="selectedPlugin"
          :config="configMap[selectedPlugin.id] ?? null"
          :draft="draft[selectedPlugin.id]"
          :busy="busyId === selectedPlugin.id"
          :active-profile="activeProfile"
          :config-tab="selectedConfigTab"
          :config-error="configError"
          @save="onSaveConfig"
          @toggle="onToggle"
          @uninstall="onUninstall"
          @open-tab="emit('openTab', $event)"
        />
      </div>
    </template>

    <PluginInstallSection
      v-model:spec="installSpec"
      :install-busy="installBusy"
      :active-profile="activeProfile"
      @install="onInstall"
    />
  </template>

  <div class="toolbar">
    <button class="btn small" :disabled="loading || scopeLoading" @click="reloadAll">
      刷新
    </button>
  </div>
  <div v-if="hint" class="ok-msg">{{ hint }}</div>
</template>

<style scoped>
.plugins-layout {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 720px) {
  .plugins-layout {
    grid-template-columns: 1fr;
  }
}
.toolbar {
  margin-top: 12px;
  display: flex;
  gap: 8px;
}
.scope-actions {
  display: flex;
  gap: 8px;
  margin: 4px 0 8px;
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
