import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const sidecarPort = Number(process.env.DIVER_PORT ?? 53620);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    proxy: {
      // dev 模式下 /api 转发到 sidecar（与 release 同源行为保持一致）
      "/api": {
        target: `http://127.0.0.1:${sidecarPort}`,
        changeOrigin: true,
      },
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/harness/**"],
    },
  },
  build: {
    // 单入口 SPA：主界面与桌宠通过 vue-router 路由（/#/ 和 /#/pet）区分，
    // 不再需要 pet.html 独立入口。public/pet/ 下的 Live2D 静态资源仍复制到 dist/pet/。
  },
}));
