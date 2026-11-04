import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import { router } from "./router";
import { onTauriEvent } from "./tauri";
import { ensureLive2dCore } from "./pet/live2d/core";
import {
  SLOT_REGISTRY_KEY,
  SlotRegistry,
  createClientContext,
  mountPlugins,
} from "./plugin-ui";
import { builtinPlugins } from "./plugin-ui/builtin";

// 进入 /pet 前预加载 Cubism Core，避免 PetApp 模型创建竞态。
// 实现见 pet/live2d/core.ts（与 createPetModel 共用同一幂等入口）。
router.beforeEach(async (to) => {
  if (to.path === "/pet" && typeof window !== "undefined") {
    try {
      await ensureLive2dCore();
    } catch (e) {
      console.error("[live2d] Core 注入失败:", e);
    }
  }
});

// 插件 UI 先于应用挂载：插件的 slot 贡献在 owner 声明前排队，
// 设置页挂载时自动生效。
const slotRegistry = new SlotRegistry();
mountPlugins(builtinPlugins, createClientContext(slotRegistry), slotRegistry);

const app = createApp(App);
app.provide(SLOT_REGISTRY_KEY, slotRegistry);
app.use(router);
app.mount("#app");

// 窗口管理器可能要求跳转（如窗口已存在但 URL 不同）
onTauriEvent<string>("redirect", (url) => {
  if (url && url !== location.href) {
    location.href = url;
  }
});
