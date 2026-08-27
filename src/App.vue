<script setup lang="ts">
// 应用根组件：路由容器。
//   /    → ChatView（主聊天界面）
//   /pet → PetView（Live2D 桌宠）
// UI 由 Tauri 内置静态托管提供（dev 为 Vite，release 为 frontendDist），
// 不依赖 sidecar 的 HTTP 端口 —— sidecar 只提供 /api。
</script>

<template>
  <router-view />
</template>
