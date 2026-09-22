<script setup lang="ts">
// 设置页：全屏标签布局（左导航 + 右内容），路由 /settings/:tab。
// 不用 modal —— 与聊天页并列的独立页面；返回聊天保留会话状态（keep-alive）。
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

// 路由 ↔ activeTab 双向同步
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

function backToChat() {
  void router.push({ name: "chat" });
}

onMounted(() => {
  void openSettings();
});

const tabs = SETTINGS_TABS;
</script>

<template>
  <div class="settings-page">
    <header class="settings-head">
      <button class="icon-btn" title="返回聊天" @click="backToChat">←</button>
      <h2>设置</h2>
    </header>

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
        <McpTab
          v-else-if="state.activeTab === 'mcp'"
          :state="state"
          @restart="doRestartSidecar"
        />
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
  height: 100vh;
  background: linear-gradient(180deg, #171826 0%, #141420 100%);
  color: #e8e6f0;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}
.settings-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  flex-shrink: 0;
}
.settings-head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.settings-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.side-nav {
  width: 168px;
  flex-shrink: 0;
  padding: 14px 10px;
  border-right: 1px solid rgba(255, 255, 255, 0.07);
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}
.nav-item {
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: #9a96ad;
  font-size: 13px;
  padding: 9px 12px;
  cursor: pointer;
  font-family: inherit;
}
.nav-item:hover {
  color: #d9d6e6;
  background: rgba(255, 255, 255, 0.05);
}
.nav-item.active {
  color: #ffb07c;
  background: rgba(255, 176, 124, 0.1);
  font-weight: 600;
}
.content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 18px 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.save-bar {
  margin-top: auto;
  padding-top: 12px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}
.btn.primary {
  background: linear-gradient(135deg, #ff9d6c, #c06ab3);
  border: none;
  font-weight: 600;
  color: #fff;
  border-radius: 10px;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.btn.primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ok-msg {
  color: #59d99a;
  font-size: 12px;
}
.error-msg {
  color: #e8a3a3;
  font-size: 12px;
}
.icon-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #c9c6da;
  border-radius: 8px;
  width: 32px;
  height: 32px;
  cursor: pointer;
  font-size: 15px;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}
</style>
