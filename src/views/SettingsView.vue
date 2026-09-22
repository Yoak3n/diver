<script setup lang="ts">
// 设置页：全屏标签布局（左导航 + 右内容），路由 /settings/:tab。
// 窗口标题栏由 App 壳提供；本页只负责导航与内容。
import { computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  useSettings,
  SETTINGS_TABS,
  isSettingsTab,
  type SettingsTab,
} from "../composables/useSettings";
import ModelsTab from "../components/settings/ModelsTab.vue";
import VoiceTab from "../components/settings/VoiceTab.vue";
import SystemTab from "../components/settings/SystemTab.vue";
import McpTab from "../components/settings/McpTab.vue";
import PluginsTab from "../components/settings/PluginsTab.vue";
import ShortcutsTab from "../components/settings/ShortcutsTab.vue";
import ScheduleTab from "../components/settings/ScheduleTab.vue";

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

const tabFromRoute = computed<SettingsTab>(() => {
  const raw = route.params.tab;
  const id = Array.isArray(raw) ? raw[0] : raw;
  return id && isSettingsTab(id) ? id : "models";
});

watch(
  tabFromRoute,
  (tab) => {
    if (state.activeTab !== tab) state.activeTab = tab;
  },
  { immediate: true },
);

function selectTab(tab: SettingsTab) {
  if (state.activeTab === tab) return;
  state.activeTab = tab;
  void router.replace({ name: "settings", params: { tab } });
}

onMounted(() => {
  void openSettings();
});

const tabs = SETTINGS_TABS;
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
        <ModelsTab
          v-if="state.activeTab === 'models'"
          :state="state"
          :provider-decls="providerDecls"
          :current-provider-decl="currentProviderDecl"
          :current-provider-models="currentProviderModels"
        />
        <VoiceTab v-else-if="state.activeTab === 'voice'" :state="state" />
        <McpTab v-else-if="state.activeTab === 'mcp'" :state="state" @restart="doRestartSidecar" />
        <PluginsTab v-else-if="state.activeTab === 'plugins'" />
        <ShortcutsTab v-else-if="state.activeTab === 'shortcuts'" />
        <ScheduleTab v-else-if="state.activeTab === 'schedule'" />
        <SystemTab
          v-else-if="state.activeTab === 'system'"
          :state="state"
          :health-info="healthInfo"
          :settings-info="settingsInfo"
          @restart="doRestartSidecar"
          @toggle-window-startup="toggleWindowStartup"
          @change-pet-size="changePetSize"
        />

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
}
.content {
  flex: 1;
  min-width: 0;
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
