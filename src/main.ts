import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import { router } from "./router";
import { onTauriEvent } from "./tauri";

// Live2D Cubism Core：动态注入经典 <script>（挂载全局 Live2DCubismCore）。
// 需支持 moc3 v5（YUI 等 Cubism 5 导出模型）；旧 Core 最高 v4 会导致 reviveMoc 失败。
// 原 pet.html 用静态 <script src="/pet/live2dcubismcore.min.js"> 注入；
// 改为路由后统一在应用启动时按需动态加载（仅当访问 /pet 时）。
// 注意：必须在 pixi-live2d-display 创建模型前完成，PetApp 的模型加载是懒
// 加载（动态 import），时序上动态 script 先行即可。
function injectLive2dCore(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    // dev：Vite 按源码路径提供 public/ 资源；release：Tauri 静态托管同路径
    script.src = "/pet/live2dcubismcore.min.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Live2D Cubism Core 加载失败"));
    document.head.appendChild(script);
  });
}

// 路由切换时：进入 /pet 前确保 Core 已加载（PetApp 的模型加载是异步的，
// 这里预加载避免竞态）。
router.beforeEach(async (to) => {
  if (to.path === "/pet" && typeof window !== "undefined") {
    try {
      await injectLive2dCore();
    } catch (e) {
      console.error("[live2d] Core 注入失败:", e);
    }
  }
});

const app = createApp(App);
app.use(router);
app.mount("#app");

// 窗口管理器可能要求跳转（如窗口已存在但 URL 不同）
onTauriEvent<string>("redirect", (url) => {
  if (url && url !== location.href) {
    location.href = url;
  }
});
