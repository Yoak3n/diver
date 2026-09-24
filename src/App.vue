<script setup lang="ts">
// 应用根组件：主窗口壳 = 自定义标题栏 + 路由内容。
//   /                 → ChatView（主聊天界面）
//   /settings/:tab?   → SettingsView（设置，左导航标签页）
//   /pet              → PetView（Live2D 桌宠，独立透明窗口，不套壳）
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import TitleBar from "./components/TitleBar.vue";
import SetupOverlay from "./components/SetupOverlay.vue";

const route = useRoute();
const router = useRouter();

const isPet = computed(() => route.name === "pet");
const isChat = computed(() => route.name === "chat");
const isSettings = computed(() => route.name === "settings");

function goChat() {
  void router.push({ name: "chat" });
}

function openSettings() {
  void router.push({ name: "settings", params: { tab: "models" } });
}
</script>

<template>
  <!-- 桌宠窗口：透明无边框，不渲染主窗口壳 -->
  <router-view v-if="isPet" />

  <div v-else class="app-shell">
    <TitleBar
      :show-status="isChat"
      :show-back="isSettings"
      :subtitle="isSettings ? '设置' : ''"
      @back="goChat"
      @open-settings="openSettings"
    />
    <div class="app-body">
      <router-view v-slot="{ Component }">
        <keep-alive>
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </div>
    <!-- 首启/启动准备：应用内进度，不弹控制台 -->
    <SetupOverlay />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--paper);
  color: var(--ink);
  overflow: hidden;
  position: relative;
}
.app-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
