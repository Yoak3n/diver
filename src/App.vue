<script setup lang="ts">
// 应用根组件：路由容器。
//   /                 → ChatView（主聊天界面）
//   /settings/:tab?   → SettingsView（设置，左导航标签页）
//   /pet              → PetView（Live2D 桌宠）
// keep-alive 保留聊天/设置的挂载状态，切换路由不丢 SSE 连接与未保存表单。
// UI 由 Tauri 内置静态托管提供（dev 为 Vite，release 为 frontendDist），
// 不依赖 sidecar 的 HTTP 端口 —— sidecar 只提供 /api。
</script>

<template>
  <router-view v-slot="{ Component, route }">
    <!-- 桌宠窗口不 keep-alive（无跨页状态需求） -->
    <keep-alive v-if="route.name !== 'pet'">
      <component :is="Component" />
    </keep-alive>
    <component :is="Component" v-else />
  </router-view>
</template>
