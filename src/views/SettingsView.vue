<script setup lang="ts">
// 设置页：全屏标签布局（左导航 + 右内容），路由 /settings/:tab。
// 窗口标题栏由 App 壳提供；本页只负责导航与内容。
import { computed, onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  useSettings,
  SETTINGS_TABS,
  isBaseSettingsTab,
} from "../composables/useSettings";
import { SlotOutlet, useSlotEntries, useSlotRegistry } from "../plugin-ui";
import ModelsTab from "../components/settings/ModelsTab.vue";
import InstancesTab from "../components/settings/InstancesTab.vue";
import VoiceTab from "../components/settings/VoiceTab.vue";
import SystemTab from "../components/settings/SystemTab.vue";
import McpTab from "../components/settings/McpTab.vue";
import PluginsTab from "../components/settings/PluginsTab.vue";
import ShortcutsTab from "../components/settings/ShortcutsTab.vue";
import ScheduleTab from "../components/settings/ScheduleTab.vue";
import PresenceTab from "../components/settings/PresenceTab.vue";

const route = useRoute();
const router = useRouter();
const {
  state,
  settingsInfo,
  healthInfo,
  providerDecls,
  currentProviderDecl,
  currentProviderModels,
  openSettings,
  save,
  doRestartSidecar,
  toggleWindowStartup,
  changePetSize,
} = useSettings();

const registry = useSlotRegistry();
const pluginTabs = useSlotEntries("settings.tab");
// owner 声明：插件在启动时已 inject 排队，这里声明后条目自动出现。
const slotDeclaration = registry.declare("settings.tab");
onUnmounted(() => slotDeclaration.dispose());

const tabFromRoute = computed<string>(() => {
  const raw = route.params.tab;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id) return "models";
  // 依赖 pluginTabs：插件 tab 晚于首次路由解析注册时，这里会重新校验。
  const known =
    isBaseSettingsTab(id) ||
    pluginTabs.value.some((entry) => entry.id === id);
  return known ? id : "models";
});

watch(
  tabFromRoute,
  (tab) => {
    if (state.activeTab !== tab) state.activeTab = tab;
  },
  { immediate: true },
);

function selectTab(tab: string) {
  if (state.activeTab === tab) return;
  state.activeTab = tab;
  void router.replace({ name: "settings", params: { tab } });
}

onMounted(() => {
  void openSettings();
});

const tabs = computed(() => [
  ...SETTINGS_TABS,
  ...pluginTabs.value.map((entry) => ({
    id: entry.id ?? String(entry.uid),
    label:
      typeof entry.label === "function"
        ? entry.label()
        : (entry.label ?? entry.id ?? "插件"),
  })),
]);
const isBase = computed(() => isBaseSettingsTab(state.activeTab));
const isKnown = computed(() =>
  tabs.value.some((tab) => tab.id === state.activeTab),
);
</script>

<template>
  <div class="settings-page">
    <div class="settings-body">
      <nav class="side-nav">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="nav-item"
          :class="{ active: state.activeTab === t.id }"
          @click="selectTab(t.id)"
        >
          {{ t.label }}
        </button>
      </nav>

      <main class="content">
        <InstancesTab v-if="state.activeTab === 'instances'" />
        <ModelsTab
          v-else-if="state.activeTab === 'models'"
          :state="state"
          :provider-decls="providerDecls"
          :current-provider-decl="currentProviderDecl"
          :current-provider-models="currentProviderModels"
        />
        <VoiceTab v-else-if="state.activeTab === 'voice'" :state="state" />
        <McpTab v-else-if="state.activeTab === 'mcp'" :state="state" @restart="doRestartSidecar" />
        <PluginsTab v-else-if="state.activeTab === 'plugins'" @open-tab="selectTab" />
        <ShortcutsTab v-else-if="state.activeTab === 'shortcuts'" />
        <ScheduleTab v-else-if="state.activeTab === 'schedule'" />
        <PresenceTab v-else-if="state.activeTab === 'presence'" />
        <SystemTab
          v-else-if="state.activeTab === 'system'"
          :state="state"
          :health-info="healthInfo"
          :settings-info="settingsInfo"
          @restart="doRestartSidecar"
          @toggle-window-startup="toggleWindowStartup"
          @change-pet-size="changePetSize"
        />
        <SlotOutlet
          v-else-if="!isBase && isKnown"
          name="settings.tab"
          :owner="{}"
          :only="state.activeTab"
        />
        <p v-else-if="!isBase && !isKnown" class="hint">
          该设置页由插件提供，但插件当前未启用。
        </p>

        <footer
          v-if="state.activeTab === 'models' || state.activeTab === 'voice'"
          class="save-bar"
        >
          <div v-if="state.savingMsg" class="ok-msg">{{ state.savingMsg }}</div>
          <div v-if="state.saveError" class="error-msg">{{ state.saveError }}</div>
          <button class="btn primary" :disabled="state.saving" @click="save">
            {{ state.saving ? "保存中…" : "保存设置" }}
          </button>
        </footer>
      </main>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: transparent;
  color: var(--ink);
}
.settings-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.side-nav {
  width: 168px;
  flex-shrink: 0;
  padding: 18px 12px;
  border-right: 1px solid var(--rule);
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  background: transparent;
}
.nav-item {
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--ink-muted);
  font-size: 13px;
  padding: 8px 10px;
  cursor: pointer;
  font-family: inherit;
  transition:
    background var(--dur-hover) ease,
    color var(--dur-hover) ease,
    transform var(--dur-press) var(--ease-out);
}
@media (hover: hover) and (pointer: fine) {
  .nav-item:hover {
    color: var(--ink);
    background: var(--paper-hover);
  }
}
.nav-item:active {
  transform: scale(0.98);
}
.nav-item.active {
  color: var(--ink);
  background: var(--paper-active);
  font-weight: 500;
  box-shadow: inset 2px 0 0 var(--ink);
}
.nav-item:focus-visible {
  outline: 2px solid var(--accent-border);
  outline-offset: 2px;
}
.content {
  flex: 1;
  min-width: 0;
  width: 100%;
  max-width: 1040px;
  margin: 0 auto;
  overflow-y: auto;
  padding: 24px 32px 28px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.save-bar {
  margin-top: auto;
  padding-top: 14px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}
</style>
