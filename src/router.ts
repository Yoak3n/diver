// Diver 前端路由：hash 模式（Tauri 内置静态托管下最稳）。
//   /        → 主聊天界面
//   /pet     → Live2D 桌宠窗口
//
// 采用 hash 模式：Tauri 的 WebviewUrl::App 加载 index.html 后，history 模式的
// /pet 会被当作静态资源路径查找导致 404；hash 模式 URL 恒为
// `index.html#/pet`，静态资源路径不受影响。

import { createRouter, createWebHashHistory } from "vue-router";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      name: "chat",
      component: () => import("./views/ChatView.vue"),
    },
    {
      path: "/pet",
      name: "pet",
      component: () => import("./views/PetView.vue"),
    },
    // 未知路径回退主界面
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
