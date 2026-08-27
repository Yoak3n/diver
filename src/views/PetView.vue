<script setup lang="ts">
// 桌宠视图：包装 PetApp（Live2D 桌宠）。作为 /pet 路由组件，
// 与主界面共享同一个 index.html（Tauri 内置静态托管，不依赖 sidecar 端口）。
// 桌宠窗口是透明/无边框的，这里在挂载时给 html/body 设置透明背景。
import { onBeforeUnmount, onMounted } from "vue";
import PetApp from "../pet/PetApp.vue";

const TRANSPARENT_CLASS = "diver-pet-transparent";

onMounted(() => {
  document.documentElement.classList.add(TRANSPARENT_CLASS);
  document.body.classList.add(TRANSPARENT_CLASS);
});

onBeforeUnmount(() => {
  document.documentElement.classList.remove(TRANSPARENT_CLASS);
  document.body.classList.remove(TRANSPARENT_CLASS);
});
</script>

<template>
  <PetApp />
</template>

<style>
/* 桌宠窗口必须全透明（覆盖全局 style.css 的不透明背景）。
   由 PetView 挂载时给 html/body 加类触发。 */
html.diver-pet-transparent,
html.diver-pet-transparent body {
  background: transparent !important;
}
</style>
