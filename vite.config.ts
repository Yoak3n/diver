import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const sidecarPort = Number(process.env.DIVER_PORT ?? 3620);

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
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        // 输出文件名由 key 决定：构建产物仍为 dist/pet.html
        pet: resolve(__dirname, "src/pet/pet.html"),
      },
    },
  },
}));
