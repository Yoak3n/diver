import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import { onTauriEvent } from "./tauri";

createApp(App).mount("#app");

// 窗口管理器可能要求跳转（如窗口已存在但 URL 不同）
onTauriEvent<string>("redirect", (url) => {
  if (url && url !== location.href) {
    location.href = url;
  }
});
