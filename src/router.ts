// Diver 前端路由：hash 模式（Tauri 内置静态托管下最稳）。
//   /                 → 主聊天界面
//   /settings/:tab?   → 设置页（左导航标签，替代原 modal）
//   /pet              → Live2D 桌宠窗口
//
// 采用 hash 模式：Tauri 的 WebviewUrl::App 加载 index.html 后，history 模式的
// /pet 会被当作静态资源路径查找导致 404；hash 模式 URL 恒为
// `index.html#/pet`，静态资源路径不受影响。
//
// ChatView / SettingsView 在 App.vue 里 keep-alive：切设置不丢 SSE 会话与消息。

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
      path: "/settings/:tab?",
      name: "settings",
      component: () => import("./views/SettingsView.vue"),
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
