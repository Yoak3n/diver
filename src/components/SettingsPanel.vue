<script setup lang="ts">
import type { HealthInfo, ProviderConfigDecl, SettingsInfo } from "../types";
import type { SettingsState } from "../composables/useSettings";
import ModelsTab from "./settings/ModelsTab.vue";
import VoiceTab from "./settings/VoiceTab.vue";
import SystemTab from "./settings/SystemTab.vue";
import McpTab from "./settings/McpTab.vue";
import PluginsTab from "./settings/PluginsTab.vue";
import ShortcutsTab from "./settings/ShortcutsTab.vue";

defineProps<{
  open: boolean;
  state: SettingsState;
  healthInfo: HealthInfo | null;
  settingsInfo: SettingsInfo | null;
  providerDecls: ProviderConfigDecl[];
  currentProviderDecl: ProviderConfigDecl | undefined;
  currentProviderModels: { provider: string; id: string }[];
}>();

defineEmits<{
  close: [];
  save: [];
  restart: [];
  toggleWindowStartup: [key: "autoOpenMain" | "autoOpenPet", value: boolean];
  changePetSize: [percent: number];
}>();
</script>

<template>
  <Transition name="fade">
    <div v-if="open" class="modal-mask" @click.self="$emit('close')">
      <div class="modal">
        <div class="modal-head">
          <h3>设置</h3>
          <button class="icon-btn" @click="$emit('close')">✕</button>
        </div>

        <!-- 标签页导航 -->
        <div class="tabs">
          <button
            class="tab"
            :class="{ active: state.activeTab === 'models' }"
            @click="state.activeTab = 'models'"
          >
            模型与提供商
          </button>
          <button
            class="tab"
            :class="{ active: state.activeTab === 'voice' }"
            @click="state.activeTab = 'voice'"
          >
            语音
          </button>
          <button
            class="tab"
            :class="{ active: state.activeTab === 'mcp' }"
            @click="state.activeTab = 'mcp'"
          >
            MCP 服务
          </button>
          <button
            class="tab"
            :class="{ active: state.activeTab === 'plugins' }"
            @click="state.activeTab = 'plugins'"
          >
            插件
          </button>
          <button
            class="tab"
            :class="{ active: state.activeTab === 'shortcuts' }"
            @click="state.activeTab = 'shortcuts'"
          >
            快捷键
          </button>
          <button
            class="tab"
            :class="{ active: state.activeTab === 'system' }"
            @click="state.activeTab = 'system'"
          >
            系统
          </button>
        </div>

        <div class="modal-body">
          <ModelsTab
            v-if="state.activeTab === 'models'"
            :state="state"
            :provider-decls="providerDecls"
            :current-provider-decl="currentProviderDecl"
            :current-provider-models="currentProviderModels"
          />
          <VoiceTab v-if="state.activeTab === 'voice'" :state="state" />
          <McpTab
            v-if="state.activeTab === 'mcp'"
            :state="state"
            @restart="$emit('restart')"
          />
          <PluginsTab v-if="state.activeTab === 'plugins'" />
          <ShortcutsTab v-if="state.activeTab === 'shortcuts'" />
          <SystemTab
            v-if="state.activeTab === 'system'"
            :state="state"
            :health-info="healthInfo"
            :settings-info="settingsInfo"
            @restart="$emit('restart')"
            @toggle-window-startup="(key, value) => $emit('toggleWindowStartup', key, value)"
            @change-pet-size="(p) => $emit('changePetSize', p)"
          />

          <div v-if="state.savingMsg" class="ok-msg">{{ state.savingMsg }}</div>
          <div v-if="state.saveError" class="error-msg">{{ state.saveError }}</div>
          <button class="btn primary save-btn" :disabled="state.saving" @click="$emit('save')">
            {{ state.saving ? "保存中…" : "保存设置" }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(10, 10, 18, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  width: 440px;
  max-height: 84vh;
  background: #1d1e2e;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 60px rgba(0, 0, 0, 0.5);
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}
.modal-head h3 {
  margin: 0;
  font-size: 15px;
}
.tabs {
  display: flex;
  gap: 4px;
  padding: 10px 18px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}
.tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: #9a96ad;
  font-size: 13px;
  padding: 8px 14px;
  cursor: pointer;
  font-family: inherit;
}
.tab:hover {
  color: #d9d6e6;
}
.tab.active {
  color: #ffb07c;
  border-bottom-color: #ffb07c;
}
.modal-body {
  padding: 16px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
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
.save-btn {
  align-self: flex-end;
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
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
